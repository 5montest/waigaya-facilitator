import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { Store } from '../src/store.js';
import { createApp } from '../src/server.js';
import { MeetingBridge } from '../src/discord/bridge.js';
import { emptyMinutes } from '../src/minutes.js';
const token='local-test-token',guildId='123456789012345678',voiceChannelId='223456789012345678',ownerId='323456789012345678';
const wait = async condition => {const end=Date.now()+3000;while(!await condition()){if(Date.now()>end)throw new Error('test wait timeout');await new Promise(r=>setTimeout(r,10));}};
const draft=state=>{const d=emptyMinutes(),u=state.utterances.find(u=>u.final);if(u)d.overview=[{text:'設定作業を検討した。',evidence:[{utteranceId:u.id,revision:u.revision}]}];return d;};
async function fixture(options={}){
 const store=options.store||new Store(':memory:');let calls=0;
 const minutesGenerator=options.minutesGenerator||{generateDraft:async s=>{calls++;return draft(s);}};
 const app=createApp({store,serviceToken:token,minutesGenerator,...options});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
 const base=`http://127.0.0.1:${app.server.address().port}`;
 const post=async(path,body,authorized=true)=>{const res=await fetch(base+path,{method:'POST',headers:{origin:base,'content-type':'application/json',...(authorized?{authorization:`Bearer ${token}`}:{})},body:JSON.stringify(body)});return {status:res.status,body:await res.json()};};
 const get=async(path,authorized=true)=>{const res=await fetch(base+path,{headers:authorized?{authorization:`Bearer ${token}`}:{}});return {status:res.status,body:res.headers.get('content-type').includes('json')?await res.json():await res.text()};};
 const created=await post('/api/sessions',{discord:{guildId,voiceChannelId,ownerId,recordingNoticeSentAt:Date.now()},mode:options.mode||'minutes'});assert.equal(created.status,201);
 const path=`/api/sessions/${created.body.id}`;await post(path+'/events',{type:'lifecycle',action:'start'});
 const utterance=(id='u1',text='設定作業に半日かかりました。')=>post(path+'/events',{type:'utterance',utterance:{id,text,source:'discord',final:true}});
 return {app,store,base,post,get,path,utterance,calls:()=>calls,state:async()=> (await get(path)).body};
}
test('T02/T14 Discord既定はminutes。終了は自動下書き生成だけで投稿しない',async()=>{
 const r=await fixture();try{
  assert.equal((await r.state()).mode,'minutes');await r.utterance();assert.equal((await r.post(r.path+'/finish',{})).status,202);
  await wait(async()=> (await r.state()).status==='completed');const state=await r.state();assert.equal(state.minutesStatus,'draft');assert.equal(r.calls(),1);assert.equal(state.outputChannelId,null);assert.equal(state.publications.length,0);
  assert.match((await r.get(r.path+'/minutes.md')).body,/AI下書き/);assert.match((await r.get(r.path+'/transcript.md')).body,/u1@1/);assert.match((await r.get(r.path+'/markdown')).body,/文字起こし/);
 }finally{await r.app.close();}
});
test('T05 finishの競合・終了後の再実行は一度だけ生成',async()=>{
 let resolve,count=0;const r=await fixture({minutesGenerator:{generateDraft:s=>{count++;return new Promise(done=>{resolve=()=>done(draft(s));});}}});
 try{await r.utterance();await Promise.all([r.post(r.path+'/finish',{}),r.post(r.path+'/finish',{reason:'empty_timeout'})]);assert.equal(count,1);resolve();await wait(async()=> (await r.state()).status==='completed');await r.post(r.path+'/finish',{});assert.equal(count,1);}
 finally{await r.app.close();}
});
test('T06/T07 pausedでは新しいDiscord文字起こしを拒否、resumeから新規発言を保存',async()=>{
 const r=await fixture();try{await r.utterance();await r.post(r.path+'/events',{type:'lifecycle',action:'pause'});assert.equal((await r.utterance('u2')).status,400);assert.equal((await r.state()).utterances.length,1);await r.post(r.path+'/events',{type:'lifecycle',action:'resume'});assert.equal((await r.utterance('u3')).status,200);assert.deepEqual((await r.state()).utterances.map(u=>u.id),['u1','u3']);}finally{await r.app.close();}
});
test('T13 生成エラーは原本を保持、retryは新しい議事録の版を保存',async()=>{
 let calls=0;const r=await fixture({minutesGenerator:{generateDraft:async s=>{if(++calls===1)throw new Error('upstream sensitive error');return draft(s);}}});
 try{await r.utterance();await r.post(r.path+'/finish',{});await wait(async()=> (await r.state()).status==='finalize_failed');let state=await r.state();assert.equal(state.utterances.length,1);assert.ok(!JSON.stringify(state).includes('sensitive'));await r.post(r.path+'/minutes',{action:'retry'});await wait(async()=> (await r.state()).status==='completed');assert.equal((await r.state()).minutesVersion,1);await r.post(r.path+'/minutes',{action:'retry'});await wait(async()=> (await r.state()).minutesVersion===2);assert.equal((await r.state()).minutesHistory.length,2);}
 finally{await r.app.close();}
});
test('T17 訂正した原発言の旧議事録は確認・共有不可、再生成後だけ確認可能',async()=>{
 const r=await fixture();try{await r.utterance();await r.post(r.path+'/finish',{});await wait(async()=> (await r.state()).minutesVersion===1);await r.utterance('u1','訂正：設定作業は一時間でした。');
  // Manual correction of the original is allowed after completion; new audio is not.
  const corrected=await r.post(r.path+'/events',{type:'utterance',utterance:{id:'u1',text:'訂正：設定作業は一時間でした。',source:'manual',final:true}});assert.equal(corrected.status,200);assert.equal((await r.state()).minutesStatus,'needs_review');assert.equal((await r.post(r.path+'/minutes',{action:'approve',version:1})).status,400);
  await r.post(r.path+'/minutes',{action:'retry'});await wait(async()=> (await r.state()).minutesVersion===2);assert.equal((await r.post(r.path+'/minutes',{action:'approve',version:2,actorId:ownerId})).status,200);
 }finally{await r.app.close();}
});
test('T22 Discord記録はIDだけ知っていてもLANのHTTP/WebSocketから閲覧不可',async()=>{
 const r=await fixture();try{await r.utterance();for(const suffix of ['', '/markdown','/audit','/minutes','/transcript.md'])assert.equal((await r.get(r.path+suffix,false)).status,403);
  assert.equal((await r.post('/api/sessions',{discord:{guildId,voiceChannelId,ownerId}},false)).status,403);
  const ws=new WebSocket(r.base.replace('http','ws')+'/live?session='+r.path.split('/').at(-1),{origin:r.base});const error=once(ws,'error');await error;ws.terminate();
 }finally{await r.app.close();}
});
test('T09 自律モデル生成中に問いが解消するとAPIでも後着質問を受け付けない',async()=>{
 const old=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='mock-only';let complete,signal,tts=0;
 const r=await fixture({mode:'facilitator',modelAnalyze:args=>{signal=args.signal;return new Promise(resolve=>{complete=resolve;});},ttsSynthesize:()=>{tts++;return{abort(){}};}});
 const bridge=new MeetingBridge(r.base,{serviceToken:token});bridge.on('failure',()=>{});
 try{await bridge.open(undefined,{sessionId:r.path.split('/').at(-1)});await r.utterance();const asking=bridge.ask({automatic:true});await wait(()=>Boolean(complete));await r.utterance('u2','問題は解消しました。設定例を共有済みです。');assert.equal(signal.aborted,true);
  complete({result:{action:'question',text:'具体的には？',reason:'具体例不足',evidence:[{utteranceId:'u1',revision:1}],notes:[]},usage:{estimatedUsd:null}});await asking;assert.equal((await r.state()).reply,null);assert.equal(tts,0);
 }finally{await bridge.close();await r.app.close();if(old===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=old;}
});
test('T18 サーバー再起動は会議をpausedに復旧し、完了済みの会議を戻さない',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'wg-recovery-')),path=join(dir,'state.sqlite');let r;
 try{r=await fixture({store:new Store(path)});await r.utterance();const id=r.path;await r.app.close();r=null;
  const store=new Store(path);const app=createApp({store,serviceToken:token});try{assert.equal(store.load(id.split('/').at(-1)).status,'paused');assert.equal(store.load(id.split('/').at(-1)).utterances.length,1);}finally{await app.close();}
 }finally{if(r)await r.app.close();rmSync(dir,{recursive:true,force:true});}
});
test('T02/T11 minutes/quietは直接speak_replyを送ってもTTSを呼ばない',async()=>{
 const old=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='mock-only';let calls=0;
 const r=await fixture({modelAnalyze:async({state})=>({result:{action:'summary',text:'設定を検討しました。',reason:'整理',evidence:[{utteranceId:state.utterances[0].id,revision:1}],notes:[]},usage:{estimatedUsd:null}}),ttsSynthesize:()=>{calls++;return{abort(){}};}});
 const bridge=new MeetingBridge(r.base,{serviceToken:token});bridge.on('failure',()=>{});
 try{await bridge.open(undefined,{sessionId:r.path.split('/').at(-1)});await r.utterance();const answer=await bridge.ask();const rejected=once(bridge,'action_error');bridge.send({type:'speak_reply',requestId:answer.reply.requestId});assert.equal((await rejected)[0].code,'unavailable');assert.equal(calls,0);}
 finally{await bridge.close();await r.app.close();if(old===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=old;}
});
