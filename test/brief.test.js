import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Controller } from '../src/controller.js';
import { briefCommand,updateBrief,currentBrief,automaticSpeechAllowed } from '../src/meeting-brief.js';
import { conversationInput,analyze,focusPrompt } from '../src/models.js';
import { MinutesGenerator,emptyMinutes,minutesMarkdown,minutesStale } from '../src/minutes.js';
import { Store } from '../src/store.js';
import { fixedFixture,ids,waitFor } from './helpers/fixed.js';

test('本筋の明示設定・確認・脱線通知だけを受け付け、質問や単なる話題を設定しない',()=>{
 assert.deepEqual(briefCommand('今日の目的は配線方式を決めること。コストと作業時間を比較したい'),{operation:'set',text:'配線方式を決めること。コストと作業時間を比較したい'});
 assert.deepEqual(briefCommand('本筋をコストの比較に変更して'),{operation:'set',text:'コストの比較'});
 assert.deepEqual(briefCommand('今日の目的を教えて'),{operation:'read'});
 assert.deepEqual(briefCommand('脱線したら声をかけて'),{operation:'watch_on'});
 assert.deepEqual(briefCommand('脱線の声かけを止めて'),{operation:'watch_off'});
 for(const text of ['今日の目的は何だと思う？','今日は会議の目的について話している','これを目的にしてよい？','公開先を変えて','目的は','目的を変更して'])assert.equal(briefCommand(text),null);
});

test('本筋と履歴はSQLiteで復元でき、原発言の訂正で要再確認となり、旧版は書き換えない',()=>{
 const dir=mkdtempSync(join(tmpdir(),'waigaya-brief-')),path=join(dir,'test.sqlite');let store;
 try{
  const c=new Controller({status:'recording',ownerId:ids.owner});const u=c.upsert({id:'brief-u',text:'ワイガヤ、今日の目的は配線を決める',source:'discord',userId:ids.owner});
  updateBrief(c,{operation:'set',text:'配線を決める',actorId:ids.owner,evidence:{utteranceId:u.id,revision:u.revision}});
  const original=structuredClone(c.state.meetingBrief);store=new Store(path);store.save(c.state,'meeting_brief');store.close();store=new Store(path);
  const restored=new Controller(store.load(c.state.id));assert.deepEqual(restored.state.meetingBrief,original);assert.deepEqual(restored.state.briefHistory,[original]);
  restored.upsert({id:u.id,text:'ワイガヤ、今日の目的は配線の案を比較する',source:'discord',userId:ids.owner});assert.equal(currentBrief(restored.state),null);assert.deepEqual(restored.state.briefHistory,[original]);
  restored.state.focusGuard=true;assert.equal(automaticSpeechAllowed(restored.state),false);
  assert.throws(()=>updateBrief(restored,{operation:'set',text:'配線を決める',actorId:ids.owner,evidence:original.evidence}),/確定発言が更新/);
 }finally{store?.close();rmSync(dir,{recursive:true,force:true});}
});

test('開始一回のまま目的を事前入力でき、通常の会話では自動検討・TTSを呼ばない',async()=>{
 const r=await fixedFixture();try{
  await r.action('start',{strings:{purpose:'配線方式を決める。比較軸はコストと作業時間'}});
  let s=await r.state();assert.match(s.meetingBrief.text,/コストと作業時間/);assert.equal(s.focusGuard,false);assert.equal(r.joins(),1);
  for(let i=0;i<3;i++)await r.emit('別の話ですが旅行の宿泊先や食事について検討しています。');
  r.runtime.meeting.facilitator.clock=()=>Date.now()+60000;assert.equal(await r.runtime.meeting.facilitator.tick(),false);assert.equal(r.requests.length,0);assert.equal(r.tts.length,0);
  await r.action('end');s=await r.complete();assert.equal(s.minutesHistory[0].metadata.meetingBrief.text,s.meetingBrief.text);assert.match(r.created[0].message.content,/本筋：配線方式/);assert.match(r.created[0].message.files[0].attachment.toString(),/## 会議の本筋/);
 }finally{await r.close();}
});

test('声で本筋を設定し短く確認、後の質問と正式議事録へ引き継ぐ。設定にはLLMを使わない',async()=>{
 const r=await fixedFixture();try{
  await r.action('start');const id=await r.emit('ワイガヤ、今日の目的は配線方式を決めること。コストと作業時間を比較したい');
  await waitFor(()=>r.tts.length===1);await waitFor(()=>!r.runtime.meeting.voiceAsking);
  let s=await r.state();assert.match(s.meetingBrief.text,/コストと作業時間/);assert.equal(s.meetingBrief.evidence.utteranceId,id);assert.equal(r.requests.length,0);assert.match(r.tts[0].text,/本筋を記録しました/);
  const saved=s.utterances.find(u=>u.id===id);r.runtime.meeting.addressing.observe(saved,ids.owner);assert.equal(r.tts.length,1);
  await r.emit('ワイガヤ、A案とB案の違いを教えて');await waitFor(()=>r.requests.length===1);await waitFor(()=>!r.runtime.meeting.voiceAsking);
  assert.equal(r.requests[0].voiceRequest.briefOperation,undefined);const input=JSON.parse(conversationInput(await r.state()).input);assert.match(input.meetingBrief.text,/作業時間/);
  await r.action('end');s=await r.complete();assert.match(r.generated[0].meetingBrief.text,/配線方式/);assert.match(minutesMarkdown(s),new RegExp(id+'@1'));assert.equal(s.decisions.length,0);assert.equal(s.minutesHistory[0].approvedAt,null);
 }finally{await r.close();}
});

test('他の参加者は本筋を確認できるが上書きできず、pause中は声の設定を受け付けない',async()=>{
 const r=await fixedFixture();try{
  await r.action('start',{strings:{purpose:'配線の比較'}});await r.membership(true,{user:r.other});
  await r.emit('ワイガヤ、今日の目的は旅行の予定を決める',{userId:ids.other});await waitFor(()=>!r.runtime.meeting.voiceAsking);
  assert.equal((await r.state()).meetingBrief.text,'配線の比較');assert.ok(r.notices.some(n=>n.content.includes('管理担当者')));
  await r.emit('ワイガヤ、今日の目的を教えて',{userId:ids.other});await waitFor(()=>r.tts.length===1);await waitFor(()=>!r.runtime.meeting.voiceAsking);assert.match(r.tts[0].text,/配線の比較/);
  r.other.permissions={has:()=>true};await r.emit('ワイガヤ、本筋をコストの比較に変更して',{userId:ids.other});await waitFor(()=>r.tts.length===2);await waitFor(()=>!r.runtime.meeting.voiceAsking);assert.equal((await r.state()).meetingBrief.updatedBy,ids.other);
  await r.action('pause');const s=await r.state();await assert.rejects(()=>r.api(`/api/sessions/${s.id}/events`,{type:'meeting_brief',voiceSource:{utteranceId:s.utterances[0].id,revision:1,userId:ids.other,alias:'ワイガヤ',question:'今日の目的は旅行'}}),/現在の確定発言/);assert.equal((await r.state()).meetingBrief.text,'コストの比較');
 }finally{await r.close();}
});

test('議事録専用では本筋の設定・確認を文字だけで返し、脱線通知ONでもLLM・TTSはゼロ',async()=>{
 const r=await fixedFixture({responsePolicy:'minutes'});try{
  await r.action('start');await r.emit('ワイガヤ、今日の目的は配線の比較');await waitFor(()=>!r.runtime.meeting.voiceAsking);assert.equal((await r.state()).meetingBrief.text,'配線の比較');
  await r.emit('ワイガヤ、脱線したら声をかけて');await waitFor(()=>!r.runtime.meeting.voiceAsking);
  for(let i=0;i<3;i++)await r.emit('旅行の行き先や宿泊料金の話に変わっています。');
  r.runtime.meeting.facilitator.clock=()=>Date.now()+60000;assert.equal(await r.runtime.meeting.facilitator.tick(),false);assert.equal(r.tts.length,0);assert.equal(r.requests.length,0);assert.ok(r.notices.some(n=>n.content.includes('音声発言しません')));
 }finally{await r.close();}
});

test('本筋APIは原発言と異なる質問・一般参加者の変更・未認証操作を拒否する',async()=>{
 const r=await fixedFixture({responsePolicy:'minutes'});try{
  await r.action('start');await r.membership(true,{user:r.other});const id=await r.emit('ワイガヤ、今日の目的は旅行の計画',{userId:ids.other});await waitFor(()=>!r.runtime.meeting.voiceAsking);
  const s=await r.state(),path=`/api/sessions/${s.id}/events`,q={utteranceId:id,revision:1,userId:ids.other,alias:'ワイガヤ',question:'今日の目的は旅行の計画'};
  await assert.rejects(()=>r.api(path,{type:'meeting_brief',voiceSource:q}),/開始した人/);
  await assert.rejects(()=>r.api(path,{type:'meeting_brief',voiceSource:{...q,question:'今日の目的は公開すること'}}),/原発言と一致/);
  await assert.rejects(()=>r.api(path,{type:'meeting_brief',voiceSource:q},false));assert.equal((await r.state()).meetingBrief,null);
 }finally{await r.close();}
});

test('脱線通知は明示ON後だけ検討し、holdを正常に扱い、OFFで新しい検討を止める',async()=>{
 const considered=[];const r=await fixedFixture({modelAnalyze:async({state,autonomous})=>{considered.push({state,autonomous});return{result:{action:'hold',reason:'本筋へ戻ったため',text:'',evidence:[],notes:[]},usage:{estimatedUsd:0}};}});
 try{
  await r.action('start');await r.emit('ワイガヤ、今日の目的は配線方式を比較して選ぶこと。費用と作業時間と取り付けの難しさを確認したい。旅行の計画は今回扱わない。');await waitFor(()=>!r.runtime.meeting.voiceAsking);
  await r.emit('ワイガヤ、脱線したら声をかけて');await waitFor(()=>!r.runtime.meeting.voiceAsking);
  const f=r.runtime.meeting.facilitator;f.clock=()=>Date.now()+60000;await waitFor(()=>!r.runtime.meeting.bridge.state.playback&&!r.runtime.meeting.bridge.state.reply);assert.equal(await f.tick(),false);assert.equal(considered.length,0);
  for(let i=0;i<3;i++)await r.emit('旅行の行き先やホテルの予約について相談しています。');
  assert.equal(await f.tick(),false);assert.equal(considered.length,1);assert.equal(considered[0].autonomous,true);assert.equal(r.tts.length,2);
  await r.emit('ワイガヤ、脱線の声かけを止めて');await waitFor(()=>!r.runtime.meeting.voiceAsking);assert.equal((await r.state()).focusGuard,false);
  for(let i=0;i<3;i++)await r.emit('旅行の別の候補についてもっと相談しています。');f.clock=()=>Date.now()+120000;assert.equal(await f.tick(),false);assert.equal(considered.length,1);
 }finally{await r.close();}
});

test('明示ONの本筋戻しだけを模擬Discord・HTTP・TTS経由で発言し、通常進行を有効化しない',async()=>{
 let calls=0;const r=await fixedFixture({modelAnalyze:async({state,autonomous})=>{calls++;assert.equal(autonomous,true);const u=state.utterances.at(-1);return{result:{action:'summary',text:'今日は配線の比較なので、費用と作業時間に戻りませんか。',reason:'無関係な話が続いた',evidence:[{utteranceId:u.id,revision:u.revision}],notes:[]},usage:{estimatedUsd:0}};}});
 try{
  await r.action('start',{strings:{purpose:'配線を選ぶ。費用と作業時間を比較'}});await r.emit('ワイガヤ、脱線したら声をかけて');await waitFor(()=>!r.runtime.meeting.voiceAsking);
  for(let i=0;i<3;i++)await r.emit('旅行先のホテルと観光の予定を相談しています。');
  await waitFor(()=>!r.runtime.meeting.bridge.state.playback&&!r.runtime.meeting.bridge.state.reply);r.runtime.meeting.facilitator.clock=()=>Date.now()+60000;
  assert.equal(await r.runtime.meeting.facilitator.tick(),true);assert.equal(calls,1);assert.equal(r.tts.length,2);assert.match(r.tts[1].text,/費用と作業時間に戻り/);const s=await r.state();assert.equal(s.mode,'assistant');assert.equal(s.autonomous,false);
 }finally{await r.close();}
});

test('本筋の原発言訂正・変更は古い回答を取消し、議事録版も要再確認になる',()=>{
 const c=new Controller({status:'recording',ownerId:ids.owner});const u=c.upsert({text:'今日の目的は配線方式の比較',source:'discord',userId:ids.owner});
 updateBrief(c,{operation:'set',text:'配線方式の比較',actorId:ids.owner,evidence:{utteranceId:u.id,revision:1}});
 const v={document:emptyMinutes(),briefRevision:c.state.briefRevision,metadata:{meetingBrief:structuredClone(c.state.meetingBrief)}};
 const t=c.beginRequest({mode:'voice_request',voiceRequest:{utteranceId:u.id,revision:1,userId:ids.owner,question:'まとめて'}});
 updateBrief(c,{operation:'set',text:'コストの比較',actorId:ids.owner});assert.equal(c.accept({action:'summary',text:'古い回答',evidence:[{utteranceId:u.id,revision:1}],notes:[]},t),false);assert.equal(minutesStale(c.state,v),true);assert.equal(v.metadata.meetingBrief.text,'配線方式の比較');
});

test('本筋を伝えた発言の訂正後は古い設定で自動介入せず、正式版に要再確認を注記する',async()=>{
 const r=await fixedFixture({responsePolicy:'minutes'});try{
  await r.action('start');const id=await r.emit('ワイガヤ、今日の目的は配線方式を決める');await waitFor(()=>!r.runtime.meeting.voiceAsking);
  await r.emit('ワイガヤ、脱線したら声をかけて');await waitFor(()=>!r.runtime.meeting.voiceAsking);
  const s=await r.state();await r.api(`/api/sessions/${s.id}/events`,{type:'utterance',utterance:{id,text:'ワイガヤ、今日の目的は比較だけして決定しない',expectedRevision:1,source:'manual',final:true}});
  const changed=await r.state();assert.equal(changed.meetingBrief.needsReview,true);assert.equal(currentBrief(changed),null);assert.equal(automaticSpeechAllowed(changed),false);
  await r.action('end');const final=await r.complete();assert.equal(final.minutesHistory[0].metadata.meetingBrief,null);assert.equal(final.minutesHistory[0].metadata.briefNeedsReview,true);
  assert.match(r.created[0].message.content,/本筋：要再確認/);assert.match(r.created[0].message.files[0].attachment.toString(),/判断軸には使用していません/);assert.equal(r.tts.length,0);
 }finally{await r.close();}
});

test('本筋を回答入力と議事録全チャンクへ渡し、脱線監視は専用プロンプトでholdを受け付ける',async()=>{
 const c=new Controller({status:'recording',ownerId:ids.owner,mode:'assistant'});for(let i=0;i<6;i++)c.upsert({id:'u'+i,text:'配線の条件を比較します。'.repeat(5),source:'discord',userId:ids.owner});updateBrief(c,{operation:'set',text:'配線を選ぶ。コストと作業時間を比較',actorId:ids.owner});c.state.focusGuard=true;
 const inputs=[],generator=new MinutesGenerator({chunkLimit:500,generate:async({input})=>{inputs.push(input);const d=emptyMinutes();const u=input.utterances?.[0];if(u)d.overview=[{text:'配線の比較',evidence:[{utteranceId:u.id,revision:u.revision}]}];else d.overview=[{text:input.partialSummaries[0].text,evidence:input.partialSummaries[0].evidence}];return{result:d,usage:{}};}});
 await generator.generateDraft(c.state);assert.ok(inputs.length>1);assert.ok(inputs.every(i=>i.meetingBrief.text===c.state.meetingBrief.text));
 const old=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='mock-only';try{
  await analyze({provider:'openai',model:'gpt-6.1-sol',state:c.state,autonomous:true,fetchImpl:async(_,args)=>{const body=JSON.parse(args.body);assert.ok(body.instructions.startsWith(focusPrompt));assert.match(JSON.parse(body.input).meetingBrief.text,/作業時間/);return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({action:'hold',reason:'関連する発散',text:'',evidence:[],notes:[]})}]}],usage:{input_tokens:1,output_tokens:1}});}});
  await assert.rejects(()=>analyze({provider:'openai',model:'gpt-6.1-sol',state:c.state,autonomous:true,fetchImpl:async(_,args)=>{const u=JSON.parse(JSON.parse(args.body).input).utterances[0];return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({action:'question',reason:'普通の進行質問',text:'具体例を教えてください。',evidence:[{utteranceId:u.id,revision:u.revision}],notes:[]})}]}],usage:{input_tokens:1,output_tokens:1}});}}),/短い整理かhold/);
 }finally{if(old===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=old;}
});
