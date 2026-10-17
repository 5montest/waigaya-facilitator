import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { TranscriptAssembler, transcriptionConfig, connectStt, synthesize } from '../src/openai-audio.js';

class FakeSocket extends EventEmitter {
  static last;
  constructor() { super(); FakeSocket.last = this; this.readyState = 1; this.bufferedAmount = 0; this.sent = []; this.closed = false; queueMicrotask(() => this.emit('open')); }
  send(text) { this.sent.push(JSON.parse(text)); }
  close() { if (!this.closed) { this.closed = true; this.readyState = 3; this.emit('close'); } }
  terminate() { this.close(); }
  message(data) { this.emit('message', Buffer.from(JSON.stringify(data))); }
}
test('文字起こし3モデルは24kHz・クライアントで区切り、Whisperの設定を分ける', () => {
  for (const model of ['gpt-transcribe','gpt-live-transcribe','gpt-realtime-whisper']) {
    const c = transcriptionConfig(model); assert.equal(c.session.audio.input.format.rate,24000); assert.equal(c.session.audio.input.turn_detection,null);
  }
  const whisper = transcriptionConfig('gpt-realtime-whisper').session.audio.input.transcription;
  assert.equal(whisper.language,'ja'); assert.equal(whisper.languages,undefined); assert.equal(whisper.prompt,undefined);
  assert.throws(() => transcriptionConfig('not-registered'));
});
test('確定が逆順で届いても、commitの音声境界で発言順を保持する', () => {
  const output = []; const a = new TranscriptAssembler(u=>output.push(u),'stream');
  a.commit({startMs:0,endMs:1000}); a.commit({startMs:1000,endMs:2000});
  a.consume({type:'input_audio_buffer.committed',item_id:'a'}); a.consume({type:'input_audio_buffer.committed',item_id:'b'});
  a.consume({type:'conversation.item.input_audio_transcription.completed',item_id:'b',transcript:'二番目'});
  a.consume({type:'conversation.item.input_audio_transcription.completed',item_id:'a',transcript:'最初'});
  assert.equal(output[0].startMs,1000); assert.equal(output[1].startMs,0); assert.equal(output[1].speaker,null);
});
test('commit前の逐次表示と確定結果は同じ発言IDで更新し、後着deltaで戻さない', () => {
  const output = []; const a = new TranscriptAssembler(u=>output.push(u),'stream'); a.currentSpan={startMs:0,endMs:1000};
  a.consume({type:'conversation.item.input_audio_transcription.delta',item_id:'a',delta:'賛成'}); assert.equal(output.at(-1).final,false);
  a.commit({startMs:0,endMs:1100}); a.consume({type:'input_audio_buffer.committed',item_id:'a'});
  a.consume({type:'conversation.item.input_audio_transcription.completed',item_id:'a',transcript:'賛成ではありません。'});
  const count = output.length; a.consume({type:'conversation.item.input_audio_transcription.delta',item_id:'a',delta:'古い結果'});
  assert.equal(output.length,count); assert.equal(output.at(-1).final,true); assert.equal(new Set(output.map(u=>u.id)).size,1);
});
test('完了がcommit確認より先に来ても、音声境界を確認するまで確定扱いにしない', () => {
  const output=[]; const a=new TranscriptAssembler(u=>output.push(u),'stream');
  a.consume({type:'conversation.item.input_audio_transcription.completed',item_id:'a',transcript:'確認しました。'});
  assert.equal(output.at(-1).final,false);
  a.commit({startMs:0,endMs:500}); a.consume({type:'input_audio_buffer.committed',item_id:'a'}); assert.equal(output.at(-1).final,true);
});
test('OpenAIの設定応答後にreadyを通知し、発話終了でcommit、最終結果まで接続を保つ', async () => {
  const output=[]; let ready=0, usage;
  const connection=connectStt({emit:u=>output.push(u),onReady:()=>ready++,onError:e=>{throw e;},onClose:()=>{},onUsage:u=>{usage=u;},WebSocketImpl:FakeSocket});
  const ws=FakeSocket.last; await new Promise(r=>queueMicrotask(r)); assert.equal(ready,0);
  ws.message({type:'session.updated'}); assert.equal(ready,1); connection.voice(true); connection.send(Buffer.alloc(4800)); connection.voice(false); connection.end();
  assert.equal(ws.closed,false); assert.equal(ws.sent.filter(e=>e.type==='input_audio_buffer.commit').length,1);
  ws.message({type:'input_audio_buffer.committed',item_id:'a'}); assert.equal(ws.closed,false);
  ws.message({type:'conversation.item.input_audio_transcription.completed',item_id:'a',transcript:'日本語の発言'});
  assert.equal(ws.closed,true); assert.equal(output.at(-1).final,true); assert.equal(usage.uploadedAudioSeconds,.1);
});
test('長い無音はクリアし、声がないまま確定処理へ送らない', async () => {
  const connection=connectStt({emit:()=>{},onReady:()=>{},onError:e=>{throw e;},onClose:()=>{},WebSocketImpl:FakeSocket});
  const ws=FakeSocket.last; await new Promise(r=>queueMicrotask(r)); ws.message({type:'session.updated'}); connection.send(Buffer.alloc(96000)); connection.end();
  assert.ok(ws.sent.some(e=>e.type==='input_audio_buffer.clear')); assert.equal(ws.sent.filter(e=>e.type==='input_audio_buffer.commit').length,0);
});
test('STT終了の確定待ち中に切断したら未確定区間を正常終了と扱わない',async()=>{
 const errors=[],usage=[];let closed=0;
 const c=connectStt({emit:()=>{},onReady:()=>{},onError:e=>errors.push(e),onClose:()=>closed++,onUsage:u=>usage.push(u),WebSocketImpl:FakeSocket});
 const ws=FakeSocket.last;await new Promise(r=>queueMicrotask(r));ws.message({type:'session.updated'});c.voice(true);c.send(Buffer.alloc(4800));c.voice(false);c.end();ws.close();
 assert.equal(errors.length,1);assert.equal(closed,1);assert.equal(usage[0].outcome,'failed_billing_unknown');
});
test('STT終了待ち中のAPIエラーも障害として残し、生の応答は通知しない',async()=>{
 const errors=[],usage=[];
 const c=connectStt({emit:()=>{},onReady:()=>{},onError:e=>errors.push(e),onClose:()=>{},onUsage:u=>usage.push(u),WebSocketImpl:FakeSocket});
 const ws=FakeSocket.last;await new Promise(r=>queueMicrotask(r));ws.message({type:'session.updated'});c.voice(true);c.send(Buffer.alloc(4800));c.end();ws.message({type:'error',error:{message:'private upstream data'}});
 assert.equal(errors.length,1);assert.equal(ws.closed,true);assert.equal(usage[0].outcome,'failed_billing_unknown');assert.ok(!errors[0].message.includes('private'));
});
test('明示中断と予期しないSTT切断を区別し、遅延した確定結果を採用しない',async()=>{
 const errors=[],output=[];
 const c=connectStt({emit:u=>output.push(u),onReady:()=>{},onError:e=>errors.push(e),onClose:()=>{},WebSocketImpl:FakeSocket});
 const ws=FakeSocket.last;await new Promise(r=>queueMicrotask(r));ws.message({type:'session.updated'});c.voice(true);c.send(Buffer.alloc(4800));c.abort();ws.message({type:'input_audio_buffer.committed',item_id:'late'});ws.message({type:'conversation.item.input_audio_transcription.completed',item_id:'late',transcript:'中断後の古い結果'});
 assert.equal(errors.length,0);assert.equal(output.length,0);
});
test('Speech APIのネットワーク境界で分割された16bitサンプルを欠落させない', async () => {
  const chunks=[];
  await new Promise((done,reject)=>synthesize({text:'確認します。',onChunk:b=>chunks.push(b),onDone:done,onError:reject,fetchImpl:async(url,args)=>{
    assert.match(url,/audio\/speech$/); assert.equal(JSON.parse(args.body).response_format,'pcm');
    return new Response(new ReadableStream({start(c){for(const a of [[1,2,3],[4,5],[6]])c.enqueue(Uint8Array.from(a)); c.close();}}));
  }}));
  assert.deepEqual([...Buffer.concat(chunks)],[1,2,3,4,5,6]); assert.ok(chunks.every(b=>b.length%2===0));
});
test('生成中断後のHTTP応答から音声を再生せず、完了扱いにしない', async () => {
  let finish, signal, count=0, done=0;
  const task=synthesize({text:'確認します。',onChunk:()=>count++,onDone:()=>done++,onError:e=>{throw e;},fetchImpl:(url,args)=>{signal=args.signal;return new Promise(r=>{finish=r;});}});
  task.abort(); assert.equal(signal.aborted,true); finish(new Response(Uint8Array.from([1,2])));
  await new Promise(r=>setTimeout(r,5)); assert.equal(count,0); assert.equal(done,0);
});
test('不完全なPCMやAPI拒否を正常な音声と扱わず、生のAPIエラーを返さない', async () => {
  for (const response of [new Response(Uint8Array.from([1])),new Response('raw sensitive response',{status:401})]) {
    const error=await new Promise(done=>synthesize({text:'確認します。',onChunk:()=>{},onDone:()=>{throw new Error('完了してはいけない');},onError:done,fetchImpl:async()=>response}));
    assert.ok(error instanceof Error); assert.equal(error.message.includes('raw sensitive'),false);
  }
});

test('Discord用STTの呼称ヒントを送信し、Whisperへ未対応promptを送らない',()=>{
 const prompt='記録係はワイガヤです。';assert.equal(transcriptionConfig('gpt-transcribe',{prompt}).session.audio.input.transcription.prompt,prompt);
 assert.equal(transcriptionConfig('gpt-realtime-whisper',{prompt}).session.audio.input.transcription.prompt,undefined);
 assert.throws(()=>transcriptionConfig('gpt-transcribe',{prompt:'a'.repeat(1001)}));
});
