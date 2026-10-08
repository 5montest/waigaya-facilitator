import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import opus from '@discordjs/opus';
import { Downsample, upsample, VoiceActivity } from '../src/discord/audio.js';
import { discordConfig, inviteUrl } from '../src/discord/config.js';
import { transcribeSpeaker } from '../src/discord/transcription.js';
import { MeetingBridge } from '../src/discord/bridge.js';
import { DiscordPlayback } from '../src/discord/playback.js';
import { command, proposal } from '../src/discord/commands.js';
import { createApp } from '../src/server.js';
import { Store } from '../src/store.js';

const samples=values=>{const b=Buffer.alloc(values.length*2);values.forEach((v,i)=>b.writeInt16LE(v,i*2));return b;};
test('Discord PCMの分割境界を保ち、2ch48kから1ch24kへの変換と逆変換を行う',()=>{
  const pcm=samples([100,300,500,700,-100,-300,-500,-700]),down=new Downsample();
  const result=Buffer.concat([down.convert(pcm.subarray(0,3)),down.convert(pcm.subarray(3,11)),down.convert(pcm.subarray(11))]);
  assert.deepEqual(result,samples([400,-400]));assert.deepEqual(upsample(result),samples([400,400,400,400,-400,-400,-400,-400]));assert.throws(()=>upsample(Buffer.alloc(3)));
});
test('実OpusコーデックでDiscordの20msフレームを復号し、文字起こし用PCMへ変換できる',()=>{
  const pcm=Buffer.alloc(3840);for(let i=0;i<960;i++){const v=Math.round(Math.sin(i*2*Math.PI*440/48000)*8000);pcm.writeInt16LE(v,i*4);pcm.writeInt16LE(v,i*4+2);}
  const codec=new opus.OpusEncoder(48000,2),decoded=codec.decode(codec.encode(pcm));
  assert.equal(decoded.length,3840);assert.equal(new Downsample().convert(decoded).length,960);assert.ok(decoded.some(v=>v!==0));
});
test('無音パケットと小さなノイズは発話扱いせず、60msの声と300msの無音で状態を変える',()=>{
  const changes=[],activity=new VoiceActivity(v=>changes.push(v));
  const frame=value=>samples(Array(1920).fill(value));
  for(let i=0;i<30;i++)activity.write(frame(50));assert.deepEqual(changes,[]);
  activity.write(frame(3000));activity.write(frame(3000));assert.deepEqual(changes,[]);
  activity.write(frame(3000));assert.deepEqual(changes,[true]);
  for(let i=0;i<14;i++)activity.write(frame(0));assert.deepEqual(changes,[true]);
  activity.write(frame(0));assert.deepEqual(changes,[true,false]);
  for(let i=0;i<3;i++)activity.write(frame(3000));activity.end();assert.deepEqual(changes,[true,false,true,false]);
});
test('Discord設定はトークンをファイルから読み、外部サーバーURLと複数行の秘密値を拒否する',()=>{
  const root=mkdtempSync(join(tmpdir(),'wg-discord-'));const env={DISCORD_APPLICATION_ID:'123456789012345678',DISCORD_GUILD_ID:'223456789012345678',DISCORD_BOT_TOKEN_FILE:'token.txt'};
  try{
    writeFileSync(join(root,'token.txt'),'a'.repeat(60)+'\n');const config=discordConfig({env:{...env,WAIGAYA_DISCORD_VOICE_CHANNEL_ID:'223456789012345678',WAIGAYA_DISCORD_MINUTES_FORUM_ID:'323456789012345678'},workspace:root});assert.equal(config.token.length,60);
    assert.equal(new URL(inviteUrl(config)).searchParams.get('guild_id'),env.DISCORD_GUILD_ID);
    assert.throws(()=>discordConfig({env:{...env,WAIGAYA_DISCORD_SERVER:'http://elsewhere.example'},workspace:root}));
    writeFileSync(join(root,'token.txt'),'a'.repeat(60)+'\n'+'b'.repeat(60));assert.throws(()=>discordConfig({env,workspace:root}));
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('音声認識の設定完了前に届いたPCMと発話終了を保持し、確定結果に話者と時刻を付ける',async()=>{
  let handlers;const calls=[],utterances=[];
  const capture=transcribeSpeaker({speaker:'参加者 (123)',startedAt:1000,emit:u=>utterances.push(u),onError:assert.fail,onUsage:()=>{},connect:h=>{handlers=h;return{voice:v=>calls.push(['voice',v]),send:b=>calls.push(['send',b.length]),end:()=>calls.push(['end']),abort:()=>calls.push(['abort'])};}});
  capture.write(samples([100,100,100,100]));capture.end();assert.deepEqual(calls,[]);handlers.onReady();assert.deepEqual(calls,[['voice',true],['send',2],['voice',false],['end']]);
  handlers.emit({id:'u',text:'条件を確認します。',startMs:0,endMs:40,final:true});assert.equal(utterances[0].speaker,'参加者 (123)');assert.equal(utterances[0].startMs,1000);assert.equal(utterances[0].source,'discord');
  handlers.onClose();await capture.closed;
});
test('認識を中断した後は、遅い接続完了で保存音声を再送しない',()=>{
  let handlers;const calls=[];const capture=transcribeSpeaker({speaker:'A',emit:()=>{},onError:assert.fail,onUsage:()=>{},connect:h=>{handlers=h;return{voice:()=>calls.push('voice'),send:()=>calls.push('send'),end:()=>{},abort:()=>calls.push('abort')};}});
  capture.write(Buffer.alloc(8));capture.abort();handlers.onReady();assert.deepEqual(calls,['abort']);
});
test('Discordの割り込み停止後に遅い音声開始が届いても再生せず、新しい許可だけ採用する',()=>{
  const bridge=new EventEmitter();bridge.state={outputEpoch:5,playback:{epoch:5},speaking:false};const sent=[];bridge.send=e=>sent.push(e);
  const playback=new DiscordPlayback(bridge,{onFailure:assert.fail});
  try{
    playback.consume({type:'tts_start',epoch:5});assert.equal(playback.epoch,5);playback.speech(true);assert.equal(playback.epoch,null);assert.ok(sent.some(e=>e.type==='stop'));
    playback.consume({type:'tts_start',epoch:5});assert.equal(playback.epoch,null);playback.speech(false);
    bridge.state={outputEpoch:6,playback:{epoch:6},speaking:false};playback.consume({type:'tts_start',epoch:6});assert.equal(playback.epoch,null);
    bridge.state={outputEpoch:8,playback:{epoch:8},speaking:false};playback.consume({type:'tts_start',epoch:8});assert.equal(playback.epoch,8);
  }finally{playback.close();}
});
test('スラッシュコマンドは記録・返答・自律設定の操作に限定し、返信でメンションを展開しない',()=>{
  for(const name of ['start','ask','stop','auto','leave','minutes','publish','pause','resume','finish','mode','status','help'])assert.ok(command.options.some(o=>o.name===name));
  const state={id:'s',candidate:{id:'c',text:'@everyone 条件を確認しますか？',evidence:[{utteranceId:'u',revision:1}]},utterances:[{id:'u',revision:1,text:'条件は未確認です。',speaker:'A'}]};
  const result=proposal(state);assert.deepEqual(result.allowedMentions,{parse:[]});assert.equal(result.components[0].components.length,2);assert.match(result.content,/条件は未確認/);
});
test('Discordブリッジは既存会議へ話者別の発言と使用量を保存し、同じLLM候補を取得する',async()=>{
  const key=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='mock-only';
  const app=createApp({store:new Store(':memory:'),serviceToken:'local-test-token',modelAnalyze:async({state})=>({result:{action:'question',reason:'条件が未確認',text:'どの条件を確認しますか？',evidence:[{utteranceId:state.utterances[0].id,revision:1}],notes:[]},usage:{estimatedUsd:null}})});
  app.server.listen(0,'127.0.0.1');await once(app.server,'listening');const bridge=new MeetingBridge(`http://127.0.0.1:${app.server.address().port}`,{serviceToken:'local-test-token'});const failures=[];bridge.on('failure',m=>failures.push(m));
  try{
    await bridge.open('Discordテスト',{mode:'assistant'});assert.equal(bridge.state.inputHealthy,true);
    await bridge.enqueue({type:'utterance',utterance:{id:'u',text:'条件はまだ決まっていません。',speaker:'A (123)',source:'discord',final:true}});
    await bridge.enqueue({type:'audio_usage',usage:{provider:'openai',kind:'stt',model:'gpt-transcribe',uploadedAudioSeconds:60,estimatedUsd:999,outcome:'closed'}});
    const result=await bridge.ask();assert.equal(result.reply.text,'どの条件を確認しますか？');assert.equal(result.candidate,null);assert.equal(result.utterances[0].speaker,'A (123)');assert.equal(result.usage.find(u=>u.kind==='stt').estimatedUsd,.0045);
    await assert.rejects(()=>bridge.api(bridge.path+'/events',{type:'audio_usage',usage:{provider:'openai',kind:'stt',model:'bad-model',uploadedAudioSeconds:60}}));
    const failed=await bridge.api(bridge.path+'/events',{type:'audio_usage',usage:{provider:'openai',kind:'stt',model:'gpt-transcribe',uploadedAudioSeconds:3,outcome:'failed_billing_unknown'}});
    assert.equal(failed.usage.at(-1).estimatedUsd,null);
    assert.deepEqual(failures,[]);
  }finally{await bridge.close();await app.close();if(key===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=key;}
});
test('Discordで会話が続いても検討を完了し、発話終了後にボタンなしでTTSへ進む',async()=>{
  const key=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='mock-only';
  let complete,signal,modelStarted,ttsCalls=0;
  const started=new Promise(resolve=>{modelStarted=resolve;});
  const app=createApp({store:new Store(':memory:'),serviceToken:'local-test-token',modelAnalyze:args=>{signal=args.signal;assert.equal(args.requestedReply,true);modelStarted();return new Promise(resolve=>{complete=resolve;});},ttsSynthesize:options=>{ttsCalls++;queueMicrotask(()=>{options.onChunk(Buffer.alloc(960));options.onDone();});return {abort(){}};}});
  app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
  const base=`http://127.0.0.1:${app.server.address().port}`,bridge=new MeetingBridge(base,{serviceToken:'local-test-token'});const failures=[];bridge.on('failure',message=>failures.push(message));
  let second;
  try{
    await bridge.open('進行テスト',{mode:'assistant'});const sessionId=bridge.state.id;
    await bridge.enqueue({type:'utterance',utterance:{id:'u1',text:'ゆっくり歩く動きとジャンプを両立したい。'}});
    const asked=bridge.ask();await started;
    bridge.send({type:'stop',reason:'human_speaking'});bridge.send({type:'vad',active:true});await bridge.waitFor(s=>s.speaking);
    await bridge.enqueue({type:'utterance',utterance:{id:'u2',text:'並列バルブを試したい。'}});
    assert.equal(signal.aborted,false);
    complete({result:{action:'summary',reason:'動きの条件整理',text:'ゆっくり歩く動きとジャンプを両立したい、という条件ですね。',evidence:[{utteranceId:'u1',revision:1}],notes:[]},usage:{estimatedUsd:.001}});
    const answer=await asked;assert.equal(answer.reply.action,'summary');assert.equal(proposal(answer).components.length,0);
    const rejected=once(bridge,'action_error');bridge.send({type:'speak_reply',requestId:answer.reply.requestId});assert.equal((await rejected)[0].code,'busy');assert.equal(bridge.state.inputHealthy,true);
    const speaking=bridge.speakReply(answer.reply.requestId);assert.equal(ttsCalls,0);
    bridge.send({type:'vad',active:false});const playback=await speaking;assert.equal(ttsCalls,1);assert.equal(playback.playback.text,answer.reply.text);assert.equal(playback.reply,null);
    bridge.send({type:'stop',reason:'human_speaking'});bridge.send({type:'vad',active:true});await bridge.waitFor(s=>s.speaking);assert.equal(bridge.state.playback,null);assert.equal(ttsCalls,1);
    await bridge.close();
    second=new MeetingBridge(base,{serviceToken:'local-test-token'});second.on('failure',m=>failures.push(m));await second.open(undefined,{sessionId});
    assert.equal(second.state.id,sessionId);assert.equal(second.state.utterances.length,2);assert.equal(second.state.reply,null);
    assert.deepEqual(failures,[]);
  }finally{await bridge.close();await second?.close();await app.close();if(key===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=key;}
});
