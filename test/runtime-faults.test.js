import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { VoiceConnectionStatus } from '@discordjs/voice';
import { Events } from 'discord.js';
import { fixedFixture,ids,waitFor } from './helpers/fixed.js';
import { transcribeSpeaker } from '../src/discord/transcription.js';
import { emptyMinutes } from '../src/minutes.js';
import { MeetingBridge } from '../src/discord/bridge.js';

test('実環境想定: 通話接続が2秒以上遅れても実際の定期復旧走査が記録を止めない',async()=>{
 const r=await fixedFixture({keepWorkerTimer:true,ready:()=>delay(2300)});let scans=0;
 const process=r.runtime.completionWorker.process.bind(r.runtime.completionWorker);
 r.runtime.completionWorker.process=async(...args)=>{scans++;return process(...args);};
 try{await r.action('start');assert.ok(scans>0);assert.equal((await r.state()).status,'recording');await r.emit('ワイガヤ、今の二つの案を整理して');await waitFor(()=>r.tts.length===1);await r.action('end');const state=await r.complete();assert.equal(state.completionJob.status,'completed');assert.equal(r.generated.length,1);assert.equal(r.created.length,1);}finally{await r.close();}
});

test('実環境想定: 開始通知の送信待ち中に開始者が退出したら録音を始めない',async()=>{
 const r=await fixedFixture();let release;
 try{const send=r.voice.send;r.voice.send=payload=>new Promise(resolve=>{release=()=>send(payload).then(resolve);});const start=r.action('start');await waitFor(()=>Boolean(release));await r.membership(false);release();await start;assert.equal(r.joins(),0);assert.equal(r.captures.length,0);assert.equal(await r.state(),null);}finally{release?.();await r.close();}
});

test('実環境想定: VC接続失敗を健康な無発言会議と表示しない',async()=>{
 const r=await fixedFixture({ready:async()=>{throw new Error('private connection failure');}});
 try{await r.action('start');const state=await r.state();assert.equal(state.status,'paused');assert.equal(state.health.connection,'failed');assert.ok(state.gaps.some(g=>g.kind==='connection'));assert.equal(r.captures.length,0);await r.api(`/api/sessions/${state.id}/finish`,{deferGeneration:true});const ended=await r.complete();assert.equal(ended.completionJob.errorCategory,'recording_missing');assert.equal(r.created.length,0);assert.ok(!JSON.stringify(r.dms).includes('private connection'));}finally{await r.close();}
});

test('実環境想定: 音声購読が同期例外を返してもBotを落とさず次の発話で復旧する',async()=>{
 const r=await fixedFixture();
 try{await r.action('start');const subscribe=r.connection.receiver.subscribe;r.connection.receiver.subscribe=()=>{throw new Error('private receiver error');};assert.doesNotThrow(()=>r.connection.receiver.speaking.emit('start',ids.owner));await waitFor(async()=>(await r.state()).health.stt==='failed');assert.equal((await r.state()).status,'recording');r.connection.receiver.subscribe=subscribe;await r.emit('音声購読の復旧後も発言を記録します。');assert.equal((await r.state()).utterances.length,1);assert.equal((await r.state()).health.stt,'ok');}finally{await r.close();}
});

test('実環境想定: Bot接続時にすでに話している人の後続音声も受信する',async()=>{
 let r;r=await fixedFixture({ready:async()=>{r.connection.receiver.speaking.users.add(ids.owner);}});
 try{await r.action('start');assert.equal(r.captures.length,1);await r.emit('接続時から続けて話している内容です。');assert.equal((await r.state()).utterances.length,1);}finally{r.connection.receiver.speaking.users.clear();await r.close();}
});

test('実環境想定: pause中から話し続けていてもresume後の音声を受信する',async()=>{
 const r=await fixedFixture();
 try{await r.action('start');await r.action('pause');r.connection.receiver.speaking.users.add(ids.owner);r.connection.receiver.speaking.emit('start',ids.owner);assert.equal(r.captures.length,0);await r.action('resume');assert.equal(r.captures.length,1);await r.emit('再開後の部分だけを記録します。');assert.equal((await r.state()).utterances.length,1);}finally{r.connection.receiver.speaking.users.clear();await r.close();}
});

test('実環境想定: STTがエラーなしで突然閉じても記録障害を検出する',async()=>{
 const handlers=[];const r=await fixedFixture({transcribe:args=>transcribeSpeaker({...args,connect:h=>{handlers.push(h);queueMicrotask(h.onReady);return{send(){},voice(){},end(){h.onClose();},abort(){h.onClose();}};}})});
 try{await r.action('start');await r.capture();handlers[0].onClose();await waitFor(async()=>(await r.state()).health.stt==='failed');assert.equal((await r.state()).status,'recording');assert.equal(r.runtime.meeting.captures.size,0);assert.ok((await r.state()).gaps.some(g=>g.kind==='stt'));await r.capture();handlers[1].emit({id:'stt-recovered',text:'再接続後の確定発言です。',final:true,startMs:0,endMs:20});await r.runtime.meeting.bridge.queue;await waitFor(async()=>(await r.state()).health.stt==='ok');}finally{await r.close();}
});

test('実環境想定: VC切断は接続障害として残し、Bot退出後も原本と議事録を保持する',async()=>{
 const r=await fixedFixture();
 try{await r.action('start');await r.emit('切断する前に確定した内容を保持します。');r.connection.emit(VoiceConnectionStatus.Disconnected);await waitFor(()=>r.runtime.meeting===null);const state=await r.complete();assert.equal(state.endReason,'connection_lost');assert.equal(state.health.connection,'failed');assert.ok(state.gaps.some(g=>g.kind==='connection'));assert.equal(state.utterances.length,1);assert.equal(r.generated.length,1);assert.equal(r.created.length,1);assert.equal(r.destroys(),1);}finally{await r.close();}
});

test('実環境想定: WebSocket切断で記録と返答を止め、確定済み原本を失わない',async()=>{
 const r=await fixedFixture();
 try{await r.action('start');await r.emit('保存が完了した発言は切断後も残します。');r.runtime.meeting.bridge.ws.terminate();await waitFor(()=>r.runtime.meeting===null);const state=await r.complete();assert.equal(state.endReason,'connection_lost');assert.equal(state.health.connection,'failed');assert.equal(state.utterances.length,1);assert.equal(r.created.length,1);assert.equal(r.tts.length,0);}finally{await r.close();}
});

test('実環境想定: 心拍が途絶えたら実タイマーで切断を検出し、勝手に記録を再開しない',async()=>{
 const r=await fixedFixture();
 try{await r.action('start');await r.emit('心拍が止まる前に記録しました。');clearInterval(r.runtime.meeting.bridge.heartbeat);await waitFor(()=>r.runtime.meeting===null,6000);const state=await r.complete();assert.equal(state.endReason,'connection_lost');assert.equal(state.utterances.length,1);assert.equal(r.joins(),1);}finally{await r.close();}
});

test('実環境想定: 議事録生成が遅くても先にVCを退出し、生成完了後に一度だけ投稿する',async()=>{
 let release;const r=await fixedFixture({generateDraft:()=>new Promise(resolve=>{release=()=>resolve(emptyMinutes());})});
 try{await r.action('start');await r.emit('生成に時間が掛かっても原本を保全します。');await r.action('end');await waitFor(()=>Boolean(release));assert.equal(r.runtime.meeting,null);assert.equal(r.destroys(),1);assert.equal((await r.state()).status,'finalizing');assert.equal(r.created.length,0);await r.runtime.completionWorker.tick();assert.equal(r.generated.length,1);release();const state=await r.complete();assert.equal(state.completionJob.status,'completed');assert.equal(r.created.length,1);}finally{release?.();await r.close();}
});

test('実環境想定: Discord送信結果が不明なら定期走査でも再送・通知連投しない',async()=>{
 const r=await fixedFixture({keepWorkerTimer:true,sendUnknown:true});
 try{await r.action('start');await r.emit('送信結果が不明でも本文は保持します。');await r.action('end');const state=await r.complete();assert.equal(state.completionJob.status,'needs_reconciliation');const notices=r.dms.length;await delay(2300);assert.equal(r.created.length,1);assert.equal(r.dms.length,notices);assert.ok((await r.state()).publications[0].publicationMarkdown);}finally{await r.close();}
});

test('実環境想定: 一人のSTT障害を別の人の正常発言だけで回復済みにしない',async()=>{
 const r=await fixedFixture();
 try{await r.action('start');await r.membership(true,{user:r.other});await r.capture();r.captures[0].onError(new Error('private speaker failure'));await waitFor(async()=>(await r.state()).health.stt==='failed');await r.emit('もう一人の音声は正常に記録されています。',{userId:ids.other});assert.equal((await r.state()).health.stt,'failed');await r.emit('失敗した話者も復旧しました。');assert.equal((await r.state()).health.stt,'ok');assert.equal((await r.state()).utterances.length,2);}finally{await r.close();}
});

test('実環境想定: 起動時の復旧一覧取得が遅れても明示開始済みの会議を停止しない',async()=>{
 let release,reached;const gate=new Promise(resolve=>{release=resolve;}),scanStarted=new Promise(resolve=>{reached=resolve;});let lists=0;
 const r=await fixedFixture({deferClientReady:true,bridgeFactory:(base,options)=>{const bridge=new MeetingBridge(base,options),api=bridge.api.bind(bridge);bridge.api=async(path,...args)=>{if(path.startsWith('/api/sessions?')&&++lists===2){reached();await gate;}return api(path,...args);};return bridge;}});
 try{await scanStarted;await r.action('start');assert.equal((await r.state()).status,'recording');release();await r.initialized;assert.equal((await r.state()).status,'recording');assert.notEqual((await r.state()).health.connection,'failed');await r.emit('起動時の復旧と重なっても保存します。');assert.equal((await r.state()).utterances.length,1);}finally{release();await r.close();}
});

test('実環境想定: SQLite保存失敗で新規受信を止め、最後の保存済み原本を保全する',async()=>{
 const r=await fixedFixture();const save=r.store.save.bind(r.store);let blocked=false;
 try{await r.action('start');await r.emit('障害前に保存した原本です。');const id=(await r.state()).id;await r.capture();r.store.save=(...args)=>{if(blocked)throw new Error('private disk failure');return save(...args);};blocked=true;r.captures.at(-1).emit({id:'not-yet-durable',text:'書き込みを確認できない発言です。',source:'discord',final:true,startMs:Date.now(),endMs:Date.now()});await waitFor(()=>r.runtime.meeting===null);assert.equal(r.store.load(id).utterances.length,1);assert.equal((await r.state()).health.storage,'failed');assert.equal(r.created.length,0);assert.equal(r.destroys(),1);assert.ok(!JSON.stringify(r.dms).includes('private disk'));blocked=false;const state=await r.complete();assert.equal(state.completionJob.status,'completed');assert.equal(state.utterances.length,2);}finally{blocked=false;r.store.save=save;await r.close();}
});

test('実環境想定: VC接続待ち中の非同期errorイベントでプロセスを落とさない',async()=>{
 let r,emissionError;r=await fixedFixture({ready:()=>new Promise(resolve=>{setTimeout(()=>{try{r.connection.emit('error',new Error('private asynchronous voice error'));}catch(e){emissionError=e;}resolve();},20);})});
 try{await r.action('start');assert.equal(emissionError,undefined);assert.equal(r.runtime.meeting,null);assert.equal((await r.state()).status,'paused');assert.equal((await r.state()).health.connection,'failed');assert.equal(r.destroys(),1);}finally{await r.close();}
});

test('実環境想定: 最終STTが13秒で確定しなければ欠損を残し、一度だけ終了・投稿する',async()=>{
 let resolveClosed,draining=false,aborts=0;const closed=new Promise(resolve=>{resolveClosed=resolve;});
 const r=await fixedFixture({keepWorkerTimer:true,transcribe:args=>({closed,write(){},end(){draining=true;},abort(){aborts++;resolveClosed();args.onClose();}})});
 try{await r.action('start');const current=r.runtime.meeting,args=await r.capture();args.emit({id:'durable-before-timeout',source:'discord',text:'終了前に確定できた発言を残します。',final:true,startMs:args.startedAt,endMs:Date.now()});await current.bridge.queue;const ending=r.action('end');await waitFor(()=>draining);r.connection.emit(VoiceConnectionStatus.Disconnected);assert.equal(r.runtime.meeting,current);await ending;assert.ok(aborts>0);assert.equal(r.runtime.meeting,null);const state=await r.complete();assert.equal(state.health.stt,'failed');assert.ok(state.gaps.some(g=>g.kind==='stt'));assert.equal(state.utterances.length,1);assert.equal(r.generated.length,1);assert.equal(r.created.length,1);assert.equal(r.destroys(),1);args.emit({id:'too-late',source:'discord',text:'中断後の遅い結果',final:true,startMs:args.startedAt,endMs:Date.now()});await current.bridge.queue;assert.equal((await r.state()).utterances.length,1);}finally{resolveClosed();await r.close();}
});

test('実環境想定: Bot強制退出のGateway通知と音声切断が重なっても接続障害を一度だけ処理する',async()=>{
 const r=await fixedFixture();
 try{await r.action('start');await r.emit('Bot強制退出の前に保存した内容です。');r.client.emit(Events.VoiceStateUpdate,{channelId:ids.vc},{id:ids.bot,channelId:null,member:r.bot});r.connection.emit(VoiceConnectionStatus.Disconnected);await waitFor(()=>r.runtime.meeting===null);const state=await r.complete();assert.equal(state.health.connection,'failed');assert.ok(state.gaps.some(g=>g.kind==='connection'));assert.equal(state.utterances.length,1);assert.equal(r.destroys(),1);assert.equal(r.generated.length,1);assert.equal(r.created.length,1);}finally{await r.close();}
});

test('実環境想定: Botのサーバー受信無効を記録中と誤表示せず、開始時・会議中とも停止する',async()=>{
 for(const phase of ['start','recording']){const r=await fixedFixture();try{if(phase==='start')r.guild.voiceStates.cache.set(ids.bot,{channelId:ids.vc,channel:r.voice,serverDeaf:true});await r.action('start');if(phase==='recording')r.client.emit(Events.VoiceStateUpdate,{channelId:ids.vc},{id:ids.bot,channelId:ids.vc,member:r.bot,serverDeaf:true});await waitFor(()=>r.runtime.meeting===null);const state=await r.state();assert.equal(state.health.connection,'failed');assert.ok(state.gaps.some(g=>g.kind==='connection'));assert.equal(r.captures.length,0);assert.equal(r.destroys(),1);}finally{await r.close();}}
});
