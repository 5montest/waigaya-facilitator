import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { Store } from '../src/store.js';
import { Controller } from '../src/controller.js';
import { createApp } from '../src/server.js';
import { MinutesGenerator, emptyMinutes, minutesProgressLabel } from '../src/minutes.js';
import { fixedStatus } from '../src/discord/status.js';

const cache = (store, id) => ({load:key=>store.minutesCheckpoint(id,key),save:(key,document)=>store.saveMinutesCheckpoint(id,key,document)});
function state() {
 const c = new Controller();
 for(let i=0;i<3;i++) c.upsert({id:'u'+i,text:'設定作業の条件を比較します。'.repeat(30),final:true});
 return c.state;
}
function response(input) {
 const d=emptyMinutes();
 if(input.utterances) d.overview=[{text:'条件の比較',evidence:input.utterances.map(u=>({utteranceId:u.id,revision:u.revision}))}];
 else d.overview=[{text:'条件の統合',evidence:input.partialSummaries.flatMap(p=>p.evidence)}];
 return {result:d,usage:{inputTokens:10,outputTokens:2}};
}
test('統合失敗後はSQLite再接続・新しいGeneratorでも完了した全分割を再利用する', async()=>{
 const dir=mkdtempSync(join(tmpdir(),'waigaya-checkpoints-')),path=join(dir,'state.sqlite'),s=state();let store=new Store(path),sources=0,merges=0,fail=true,usage=0;
 const generate=async({input})=>{if(input.utterances)sources++;else{merges++;if(fail)throw new Error('simulated timeout');}return response(input);};
 try {
  await assert.rejects(new MinutesGenerator({chunkLimit:700,generate}).generateDraft(s,{checkpoints:cache(store,s.id),onUsage:()=>usage++}),/simulated timeout/);
  assert.equal(sources,3);assert.equal(merges,1);assert.equal(usage,3);
  store.close();store=new Store(path);fail=false;const progress=[];
  const d=await new MinutesGenerator({chunkLimit:700,generate}).generateDraft(s,{checkpoints:cache(store,s.id),onProgress:p=>progress.push(p),onUsage:()=>usage++});
  assert.equal(sources,3);assert.equal(merges,2);assert.equal(usage,4);assert.equal(d.overview[0].evidence.length,3);
  assert.ok(progress.some(p=>p.phase==='source'&&p.completed===3&&p.reused===3));
 } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});
test('分割の途中で失敗しても成功済みの分割だけを再利用する',async()=>{
 const store=new Store(':memory:'),s=state();let sources=0,fail=true;
 const generate=async({input})=>{if(input.utterances){sources++;if(fail&&input.utterances[0].id==='u1')throw new Error('source failed');}return response(input);};
 const generator=new MinutesGenerator({chunkLimit:700,generate});
 try {await assert.rejects(generator.generateDraft(s,{checkpoints:cache(store,s.id)}));fail=false;await generator.generateDraft(s,{checkpoints:cache(store,s.id)});assert.equal(sources,4);}finally{store.close();}
});
test('統合の途中で失敗した場合も、成功済みの統合グループを再利用する',async()=>{
 const store=new Store(':memory:'),s=state();let phase=0,sources=0,merges=0,fail=true;
 const generator=new MinutesGenerator({chunkLimit:700,generate:async({input})=>{
  if(input.utterances)sources++;else{merges++;if(phase===1&&input.partialSummaries.some(p=>p.evidence.some(e=>e.utteranceId==='u2'))&&fail)throw new Error('second merge failed');}
  const result=response(input);if(input.utterances)result.result.overview[0].text='比較の説明'.repeat(75);return result;
 }});
 try {
  await assert.rejects(generator.generateDraft(s,{checkpoints:cache(store,s.id),onProgress:p=>{if(p.phase==='integration')phase=p.depth;}}),/second merge failed/);
  const before=merges;fail=false;
  await generator.generateDraft(s,{checkpoints:cache(store,s.id),onProgress:p=>{if(p.phase==='integration')phase=p.depth;}});
  assert.equal(sources,3);assert.equal(merges-before,2);
 }finally{store.close();}
});
test('発言訂正は該当分割と統合だけを再生成し、summary・会議・モデル・議題を混同しない',async()=>{
 const store=new Store(':memory:'),s=state();let calls=0;
 const generate=async({input})=>{calls++;return response(input);};
 const generator=new MinutesGenerator({chunkLimit:700,generate});const run=(state=s,options={})=>generator.generateDraft(state,{checkpoints:cache(store,state.id),...options});
 try {
  await run();assert.equal(calls,4);await run();assert.equal(calls,4);
  s.utterances[0].revision++;s.utterances[0].text+='訂正';await run();assert.equal(calls,6);
  await run(s,{kind:'summary'});assert.equal(calls,10);
  await run({...s,id:'another-session'});assert.equal(calls,14);
  await run({...s,topic:'新しい議題'});assert.equal(calls,18);
  await new MinutesGenerator({chunkLimit:700,model:'mock-other-model',generate}).generateDraft(s,{checkpoints:cache(store,s.id)});assert.equal(calls,22);
 } finally {store.close();}
});
test('不正な根拠の出力はチェックポイントへ保存せず、abort後は追加APIを呼ばない',async()=>{
 const store=new Store(':memory:'),s=state();let saves=0,calls=0;
 const generator=new MinutesGenerator({chunkLimit:700,generate:async({input})=>{calls++;const r=response(input);r.result.overview[0].evidence[0].revision=999;return r;}});
 try {
  await assert.rejects(generator.generateDraft(s,{checkpoints:{...cache(store,s.id),save:()=>{saves++;}}}),/根拠/);assert.equal(saves,0);
  const abort=new AbortController();abort.abort();await assert.rejects(generator.generateDraft(s,{signal:abort.signal}));assert.equal(calls,1);
 }finally{store.close();}
});
test('保存失敗を成功と扱わず、進捗は完了件数を増やさない',async()=>{
 const s=state(),progress=[];
 const generator=new MinutesGenerator({chunkLimit:700,generate:async({input})=>response(input)});
 await assert.rejects(generator.generateDraft(s,{checkpoints:{load:()=>null,save:()=>{throw new Error('disk full');}},onProgress:p=>progress.push(p)}),/disk full/);
 assert.equal(progress.at(-1).completed,0);assert.equal(minutesProgressLabel({minutesProgress:progress.at(-1)}),'発言の整理0/3件');
});

test('HTTP finish→統合失敗→サーバー/SQLite再起動→retryは分割APIを再実行しない',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'waigaya-checkpoint-http-')),path=join(dir,'state.sqlite');let app,sources=0,fail=true;
 const make=()=>createApp({store:new Store(path),serviceToken:'test-only',minutesGenerator:new MinutesGenerator({chunkLimit:700,generate:async({input})=>{if(input.utterances)sources++;else if(fail)throw new Error('simulated upstream private error');return response(input);}})});
 const start=async()=>{app=make();app.server.listen(0,'127.0.0.1');await once(app.server,'listening');return 'http://127.0.0.1:'+app.server.address().port;};
 let base=await start();
 const post=async(url,body)=>{const r=await fetch(base+url,{method:'POST',headers:{origin:base,authorization:'Bearer test-only','content-type':'application/json'},body:JSON.stringify(body)});assert.ok(r.ok);return r.json();};
 const get=async url=>(await fetch(base+url,{headers:{authorization:'Bearer test-only'}})).json();
 const wait=async check=>{const end=Date.now()+3000;while(!await check()){if(Date.now()>end)throw new Error('wait timeout');await new Promise(r=>setTimeout(r,10));}};
 try {
  const s=await post('/api/sessions',{discord:{guildId:'123456789012345678',voiceChannelId:'223456789012345678',ownerId:'323456789012345678',recordingNoticeSentAt:Date.now()}}),route='/api/sessions/'+s.id;
  await post(route+'/events',{type:'lifecycle',action:'start'});
  for(const u of state().utterances) await post(route+'/events',{type:'utterance',utterance:u});
  await post(route+'/finish',{});await wait(async()=>(await get(route)).minutesStatus==='failed');assert.equal(sources,3);
  const failed=await get(route);assert.equal(failed.minutesProgress.phase,'integration');assert.equal(failed.minutesProgress.completed,0);assert.ok(!JSON.stringify(failed).includes('upstream private error'));
  await app.close();app=null;fail=false;base=await start();
  await post(route+'/minutes',{action:'retry'});await wait(async()=>(await get(route)).status==='completed');
  const done=await get(route);assert.equal(sources,3);assert.equal(done.minutesVersion,1);assert.equal(done.utterances.length,3);assert.equal(done.minutesHistory[0].kind,'minutes');
  assert.equal(done.usage.filter(u=>u.outcome==='received').length,4);assert.equal(done.usage.filter(u=>u.outcome==='failed_billing_unknown').length,1);assert.equal(done.publications.length,0);
 }finally{await app?.close();rmSync(dir,{recursive:true,force:true});}
});

test('固定VCのstatusに統合の進捗と保存済み結果の再利用を表示する',()=>{
 const c=new Controller({status:'finalizing',minutesStatus:'generating',minutesProgress:{phase:'integration',depth:1,completed:2,total:4,reused:2}});
 assert.match(fixedStatus(c.state),/統合（1段目）2\/4件・保存済み2件を再利用/);
 c.state.minutesStatus='failed';assert.match(fixedStatus(c.state),/統合（1段目）2\/4件/);
});

test('今回と同じ17分割完了→統合失敗でも17件をやり直さず、根拠を保持して完成する',async()=>{
 const c=new Controller(),store=new Store(':memory:');for(let i=0;i<17;i++)c.upsert({id:'u'+i,text:'会議で検討した設定の比較条件です。'.repeat(45),final:true});
 let sources=0,fail=true;const progress=[];
 const generator=new MinutesGenerator({chunkLimit:1500,generate:async({input})=>{if(input.utterances)sources++;else if(fail)throw new Error('integration timeout');return response(input);}});
 try {
  await assert.rejects(generator.generateDraft(c.state,{checkpoints:cache(store,c.state.id)}),/integration timeout/);assert.equal(sources,17);
  fail=false;const document=await generator.generateDraft(c.state,{checkpoints:cache(store,c.state.id),onProgress:p=>progress.push(p)});
  assert.equal(sources,17);assert.equal(new Set(document.overview[0].evidence.map(e=>e.utteranceId)).size,17);
  assert.ok(progress.some(p=>p.phase==='source'&&p.completed===17&&p.reused===17));
 }finally{store.close();}
});
