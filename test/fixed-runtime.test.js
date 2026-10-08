import test from 'node:test';
import assert from 'node:assert/strict';
import { ids,fixedFixture,waitFor } from './helpers/fixed.js';
import { Events } from 'discord.js';
test('固定運用: 起動・VCイベントでは録音せず、start一回で選択なしに通知して記録を開始する',async()=>{
 const r=await fixedFixture();try{assert.equal(r.joins(),0);assert.equal(r.captures.length,0);await r.membership(true);assert.equal(r.joins(),0);
  const result=await r.action('start');assert.deepEqual(result.components,[]);assert.equal(r.joins(),1);const s=await r.state();assert.equal(s.mode,'assistant');assert.equal(s.fixedOperation,true);assert.equal(s.outputChannelId,ids.forum);assert.match(s.topic,/固定会議室/);assert.match(r.notices[0].content,/AI生成・未確認.*自動公開/);assert.match(r.notices[0].content,/原音声は保存せず/);assert.equal(r.notices.length,1);await r.action('start');assert.equal(r.joins(),1);
 }finally{await r.close();}
});
test('固定運用: 別VC・人間0人・通知失敗・権限不足では会議もSTTも開始しない',async()=>{
 const r=await fixedFixture();try{r.guild.voiceStates.cache.get(ids.owner).channel=await r.guild.channels.fetch(ids.otherVc);await r.action('start');assert.equal(r.joins(),0);r.guild.voiceStates.cache.get(ids.owner).channel=r.voice;r.voice.members.delete(ids.owner);await r.action('start');assert.equal(r.joins(),0);assert.equal(await r.state(),null);}finally{await r.close();}
 const failed=await fixedFixture({noticeFail:true});try{await failed.action('start');assert.equal(failed.joins(),0);assert.equal(await failed.state(),null);}finally{await failed.close();}
 const denied=await fixedFixture();try{denied.forum.permissionsFor=()=>({has:permissions=>!Array.isArray(permissions)||permissions.length<4});await denied.action('start');assert.equal(denied.joins(),0);}finally{await denied.close();}
});
test('固定運用: 確定STTの呼びかけから直接回答・TTSへ接続し、名称の話題と暫定・再送は応答しない',async()=>{
 const r=await fixedFixture();try{await r.action('start');await r.emit('ワイガヤっていうBotを作っている');await r.emit('前にワイガヤが言っていた件だけど');await r.emit('ワイガヤ、まとめて',{final:false});await new Promise(done=>setTimeout(done,30));assert.equal(r.requests.length,0);
  const id=await r.emit('ワイガヤ、さっきの2案を整理して');await waitFor(()=>r.tts.length===1);const state=await r.state();assert.equal(state.voiceRequests.length,1);assert.equal(state.voiceRequests[0].utteranceId,id);assert.equal(state.voiceRequests[0].userId,ids.owner);assert.equal(state.decisions.length,0);assert.equal(state.voiceRequests[0].question,'さっきの2案を整理して');assert.equal(r.requests[0].mode,'voice_request');assert.equal(r.notices.length,1);
  const u=state.utterances.find(u=>u.id===id);r.captures.at(-1).emit(u);await r.runtime.meeting.bridge.queue;await new Promise(done=>setTimeout(done,30));assert.equal(r.requests.length,1);
 }finally{await r.close();}
});
test('固定運用: 退出猶予から復帰で同一ID・pauseを維持し、期限後は無操作で退出・正式版を一度だけ投稿',async()=>{
 const r=await fixedFixture();try{await r.action('start');const id=(await r.state()).id;await r.emit('A案とB案を比べて配線図を検討します。');await r.action('pause');await r.membership(false);assert.equal((await r.state()).status,'empty_grace');await r.membership(true);assert.equal((await r.state()).status,'paused');assert.equal((await r.state()).id,id);assert.equal(r.created.length,0);await r.action('resume');await r.membership(false);const current=r.runtime.meeting;current.grace.emptyAt=Date.now()-2000;await Promise.all([current.grace.tick(),current.grace.tick()]);assert.equal(r.runtime.meeting,null);assert.equal(r.destroys(),1);const state=await r.complete();assert.equal(state.status,'completed');assert.equal(r.generated.length,1);assert.equal(r.created.length,1);assert.equal(state.completionJob.status,'completed');assert.equal(state.minutesHistory[0].approvedAt,null);assert.equal(state.minutesHistory[0].approvedBy,null);assert.match(r.created[0].message.content,/AI生成・未確認/);assert.equal(r.created[0].message.files.length,1);assert.match(r.created[0].message.files[0].name,/minutes-v1.md/);assert.deepEqual(r.created[0].appliedTags,['tag2']);await r.runtime.completionWorker.tick();assert.equal(r.created.length,1);
 }finally{await r.close();}
});
test('固定運用: ドレイン中の最終STTを含め、Bot退出後に生成し、訂正は同じスレッドへ未確認版を追記',async()=>{
 let last;const r=await fixedFixture({onDrain:args=>{last=args;args.emit({id:'last-drained',text:'最後に比較試験を提案しました。',source:'discord',final:true,startMs:args.startedAt,endMs:Date.now()});}});try{await r.action('start');await r.capture();await r.action('end');assert.equal(r.runtime.meeting,null);const s=await r.complete();assert.equal(r.destroys(),1);assert.ok(r.generated[0].utterances.some(u=>u.id==='last-drained'));assert.equal(r.created.length,1);
  const d=structuredClone(s.minutesHistory[0].document);d.overview[0].text='比較試験の案を検討した。';await r.api(`/api/sessions/${s.id}/minutes`,{action:'edit',version:1,document:d,actorId:ids.owner});await r.complete();assert.equal(r.created.length,1);assert.equal(r.replies.length,1);assert.match(r.replies[0].files[0].name,/minutes-v2.md/);assert.equal((await r.state()).minutesHistory[1].approvedAt,null);
 }finally{await r.close();}
});
test('固定運用: 人の後日確認は別版に保存して追記し、元のAI未確認版を人の承認扱いに書き換えない',async()=>{
 const r=await fixedFixture();try{await r.action('start');await r.emit('試行する案を検討しています。');await r.action('end');const s=await r.complete();const reviewed=await r.api(`/api/sessions/${s.id}/minutes`,{action:'approve',version:1,actorId:ids.owner});assert.equal(reviewed.minutesVersion,2);assert.equal(reviewed.minutesHistory[0].approvedAt,null);assert.equal(reviewed.minutesHistory[1].humanReviewedBy,ids.owner);await r.complete();assert.equal(r.replies.length,1);assert.match(r.replies[0].content,/議事録（確認済み）/);
 }finally{await r.close();}
});
test('固定運用: 空会議は親投稿を作らず、STT全欠損は正常な議事録と表示しない',async()=>{
 const r=await fixedFixture();try{await r.action('start');await r.action('end');const s=await r.complete();assert.equal(s.completionJob.status,'skipped_empty');assert.equal(r.created.length,0);assert.ok(r.dms.some(n=>n.content.includes('無発言')));}finally{await r.close();}
 const broken=await fixedFixture();try{await broken.action('start');broken.runtime.meeting.bridge.state.health.stt='failed';await broken.runtime.meeting.bridge.enqueue({type:'health',kind:'stt',healthy:false,gap:{startedAt:Date.now(),endedAt:Date.now()}});await broken.action('end');const s=await broken.complete();assert.equal(s.completionJob.status,'failed');assert.equal(s.completionJob.errorCategory,'recording_missing');assert.equal(broken.created.length,0);}finally{await broken.close();}
});
test('固定運用: Discord結果不明・LLM失敗でも退出し、原本を保持して機密本文なしに一度通知',async()=>{
 const r=await fixedFixture({sendUnknown:true});try{await r.action('start');await r.emit('非公開の検討内容です。');await r.action('end');const s=await r.complete();assert.equal(r.runtime.meeting,null);assert.equal(s.completionJob.status,'needs_reconciliation');assert.equal(s.publications[0].status,'needs_reconciliation');assert.ok(s.utterances.length);assert.equal(s.minutesHistory[0].approvedAt,null);const before=r.dms.length;await r.runtime.completionWorker.tick();assert.equal(r.dms.length,before);assert.equal(r.created.length,1);assert.ok(!JSON.stringify(r.dms).includes('非公開の検討内容'));}finally{await r.close();}
 const failed=await fixedFixture({minutesFail:true});try{await failed.action('start');await failed.emit('会議の内容を保持します。');await failed.action('end');const s=await failed.complete();assert.equal(s.status,'finalize_failed');assert.equal(s.completionJob.status,'failed');assert.equal(failed.generated.length,2);assert.equal(failed.created.length,0);assert.ok(s.utterances.length);assert.ok(!JSON.stringify(failed.dms).includes('private meeting'));}finally{await failed.close();}
});
test('固定運用: pause・minutes・quiet・入力障害・Bot音源では音声を生成せず、別VC移動も記録を継続しない',async()=>{
 const r=await fixedFixture({responsePolicy:'minutes'});try{await r.action('start');await r.emit('ワイガヤ、まとめて');assert.equal(r.requests.length,0);assert.equal(r.tts.length,0);await r.action('pause');const before=r.captures.length;await r.capture();assert.equal(r.captures.length,before);await r.action('resume');await r.action('mode',{admin:true,strings:{mode:'assistant'}});await r.action('quiet');await r.emit('ワイガヤ、説明して');assert.equal(r.requests.length,0);r.client.emit(Events.VoiceStateUpdate,{channelId:ids.vc},{id:ids.bot,channelId:ids.otherVc});await waitFor(()=>r.runtime.meeting===null);assert.equal(r.joins(),1);}finally{await r.close();}
});

test('固定運用: 複数人の連続呼びかけは古い依頼を取消し、遅い回答を逆順再生しない',async()=>{
 const pending=[];const r=await fixedFixture({modelAnalyze:args=>new Promise(resolve=>pending.push({args,resolve}))});try{await r.action('start');await r.emit('ワイガヤ、A案について答えて');await waitFor(()=>pending.length===1);await r.membership(true,{user:r.other});await r.emit('ワイガヤ、B案について答えて',{userId:ids.other});await waitFor(()=>pending.length===2);assert.equal(pending[0].args.signal.aborted,true);
  const answer=p=>({result:{action:'summary',reason:'直接回答',text:'こちらの案を整理します。',evidence:[{utteranceId:p.args.state.request.voiceRequest.utteranceId,revision:p.args.state.request.voiceRequest.revision}],notes:[]},usage:{estimatedUsd:null}});pending[1].resolve(answer(pending[1]));await waitFor(()=>r.tts.length===1);pending[0].resolve(answer(pending[0]));await new Promise(done=>setTimeout(done,50));assert.equal(r.tts.length,1);const s=await r.state();assert.equal(s.voiceRequests.length,2);assert.equal(s.voiceRequests[0].status,'cancelled');assert.equal(s.voiceRequests[1].userId,ids.other);
 }finally{for(const p of pending)p.resolve({result:{action:'hold',text:'',reason:'中止',evidence:[],notes:[]},usage:{estimatedUsd:null}});await r.close();}
});
test('固定運用: 質問が後続発言で解消・STT訂正されると生成を取消し、TTSも管理操作も実行しない',async()=>{
 let pending;const r=await fixedFixture({modelAnalyze:args=>new Promise(resolve=>pending={args,resolve})});try{await r.action('start');const id=await r.emit('ワイガヤ、設定にどれくらい掛かった？');await waitFor(()=>Boolean(pending));await r.emit('設定には前回半日かかりました。');assert.equal(pending.args.signal.aborted,true);pending.resolve({result:{action:'question',text:'具体的には？',reason:'古い依頼',evidence:[{utteranceId:id,revision:1}],notes:[]},usage:{estimatedUsd:null}});await new Promise(done=>setTimeout(done,50));assert.equal(r.tts.length,0);assert.equal(r.created.length,0);
 }finally{pending?.resolve({result:{action:'hold',text:'',reason:'中止',evidence:[],notes:[]},usage:{estimatedUsd:null}});await r.close();}
});
test('固定運用: AI再生中の発話は即時停止し、後着TTS片を捨てて自動再開しない',async()=>{
 const r=await fixedFixture({holdTts:true});try{await r.action('start');await r.emit('ワイガヤ、まとめて');await waitFor(()=>r.tts.length===1&&r.runtime.meeting.playback.epoch!==null);const current=r.runtime.meeting,oldEpoch=current.playback.epoch;await r.capture();assert.equal(current.playback.epoch,null);r.tts[0].onChunk(Buffer.alloc(960));r.tts[0].onDone();await new Promise(done=>setTimeout(done,30));assert.equal(current.playback.epoch,null);assert.ok((await r.state()).outputEpoch>oldEpoch);assert.ok((await r.state()).aiTurns.some(t=>t.outcome==='human_speaking'));
 }finally{await r.close();}
});
test('固定運用: Bot自身・エコー・入力障害・人間0人で呼びかけ経路を起動しない',async()=>{
 const r=await fixedFixture();try{await r.action('start');const before=r.captures.length;await r.capture(ids.bot);assert.equal(r.captures.length,before);
  await r.runtime.meeting.bridge.recording(false);await waitFor(()=>!r.runtime.meeting.bridge.state.inputHealthy);await r.emit('ワイガヤ、説明して');assert.equal(r.requests.length,0);await r.runtime.meeting.bridge.recording(true);await r.membership(false);assert.equal((await r.state()).status,'empty_grace');assert.equal(r.requests.length,0);
 }finally{await r.close();}
});

test('固定運用: 通知待ちの同時startは一度だけ記録し、参加者が残る無音では終了しない',async()=>{
 const r=await fixedFixture();let release;try{const original=r.voice.send;r.voice.send=payload=>new Promise(resolve=>{release=()=>original(payload).then(resolve);});const first=r.action('start');await waitFor(()=>Boolean(release));await r.action('start');assert.equal(r.joins(),0);release();await first;assert.equal(r.joins(),1);assert.equal(r.notices.length,1);r.runtime.completionWorker.clock=()=>Date.now()+3600000;await r.runtime.completionWorker.tick();assert.equal((await r.state()).status,'recording');assert.equal(r.destroys(),0);
 }finally{release?.();await r.close();}
});
test('固定運用: HTTPも固定範囲・通知・Bot認証を検査し、旧設定やdestinationで別公開先へ逃がさない',async()=>{
 const r=await fixedFixture();try{await assert.rejects(()=>r.api('/api/sessions',{discord:{guildId:ids.guild,voiceChannelId:ids.otherVc,ownerId:ids.owner}}));await assert.rejects(()=>r.api('/api/sessions',{discord:{guildId:ids.guild,voiceChannelId:ids.vc,ownerId:ids.owner}}));await assert.rejects(()=>r.api(`/api/guilds/${ids.guild}/fixed-policy`,r.policy,false));await assert.rejects(()=>r.api(`/api/guilds/${ids.guild}/settings`,{channelId:ids.other,actorId:ids.owner}));await r.action('start');const s=await r.state();await assert.rejects(()=>r.api(`/api/sessions/${s.id}/minutes`,{action:'destination',channelId:ids.other,actorId:ids.owner}));assert.equal((await r.state()).outputChannelId,ids.forum);
 }finally{await r.close();}
});
test('固定運用: STT依頼訂正と生成中のminutes切替で旧回答を止め、エコーを再依頼にしない',async()=>{
 const pending=[];const r=await fixedFixture({modelAnalyze:args=>new Promise(resolve=>pending.push({args,resolve}))});try{await r.action('start');const id=await r.emit('ワイガヤ、A案を整理して');await waitFor(()=>pending.length===1);await r.runtime.meeting.bridge.enqueue({type:'utterance',utterance:{...(await r.state()).utterances.find(u=>u.id===id),text:'ワイガヤっていうBotの名称です。'}});assert.equal(pending[0].args.signal.aborted,true);r.runtime.meeting.addressing.observe(r.runtime.meeting.bridge.state.utterances.find(u=>u.id===id),ids.owner);pending[0].resolve({result:{action:'hold',text:'',reason:'訂正',evidence:[],notes:[]},usage:{}});await r.runtime.meeting.addressing.running;assert.equal(r.tts.length,0);
  await r.emit('ワイガヤ、B案を整理して');await waitFor(()=>pending.length===2);await r.action('mode',{admin:true,strings:{mode:'minutes'}});assert.equal(pending[1].args.signal.aborted,true);pending[1].resolve({result:{action:'hold',text:'',reason:'停止',evidence:[],notes:[]},usage:{}});await r.runtime.meeting.addressing.running;assert.equal(r.tts.length,0);
  await r.action('mode',{admin:true,strings:{mode:'assistant'}});const echo='ワイガヤ、いまの比較を整理します。';r.runtime.meeting.bridge.state.aiTurns.push({text:echo});r.runtime.meeting.addressing.observe({id:'echo',revision:1,source:'discord',final:true,text:echo},ids.owner);assert.equal(pending.length,2);
 }finally{for(const p of pending)p.resolve({result:{action:'hold',text:'',reason:'終了',evidence:[],notes:[]},usage:{}});await r.close();}
});
test('固定運用: TTS失敗と応答LLM失敗は原本記録を継続し、同じエラーを連投しない',async()=>{
 const t=await fixedFixture({ttsFail:true});try{await t.action('start');await t.emit('ワイガヤ、まとめて');await waitFor(()=>t.tts.length===1);await waitFor(async()=>(await t.state()).health.tts==='failed');await t.emit('音声返答の失敗後も議論します。');assert.equal((await t.state()).status,'recording');assert.equal((await t.state()).utterances.length,2);assert.ok(!JSON.stringify(t.notices).includes('private tts'));}finally{await t.close();}
 const r=await fixedFixture({modelAnalyze:async()=>{throw new Error('private voice request');}});try{await r.action('start');await r.emit('ワイガヤ、A案を教えて');await waitFor(()=>r.notices.length===2);await r.emit('ワイガヤ、B案を教えて');await r.runtime.meeting.addressing.running;assert.equal(r.notices.length,2);assert.equal((await r.state()).utterances.length,2);assert.equal((await r.state()).status,'recording');assert.ok(!JSON.stringify(r.notices).includes('private voice'));}finally{await r.close();}
});
test('固定運用: フォーラム削除は本文なしの異常通知になり、別チャンネルへ自動投稿しない',async()=>{
 const r=await fixedFixture();try{await r.action('start');await r.emit('会議の秘密の本文です。');const fetch=r.guild.channels.fetch;r.guild.channels.fetch=async id=>id===ids.forum?null:fetch(id);await r.action('end');await r.runtime.completionWorker.running;await r.runtime.completionWorker.tick();const s=await r.state();assert.equal(r.runtime.meeting,null);assert.equal(s.completionJob.errorCategory,'discord_rejected');assert.ok(s.utterances.length);assert.ok(r.dms.length);assert.ok(!JSON.stringify(r.dms).includes('秘密'));assert.equal(r.created.length,0);
 }finally{await r.close();}
});

test('固定運用: 自動投稿成功後のDB結果保存失敗は要照合とし、親投稿を再作成しない',async()=>{
 const r=await fixedFixture();try{await r.action('start');await r.emit('根拠付きの記録を保全します。');const save=r.store.save.bind(r.store);let once=true;r.store.save=(state,kind,payload)=>{if(kind==='publication'&&once){once=false;throw new Error('simulated commit failure');}return save(state,kind,payload);};await r.action('end');const s=await r.complete();assert.equal(r.created.length,1);assert.equal(s.completionJob.status,'needs_reconciliation');assert.equal(s.publications[0].status,'needs_reconciliation');assert.ok(s.publications[0].publicationMarkdown);await r.runtime.completionWorker.tick();assert.equal(r.created.length,1);assert.ok(s.utterances.length);
 }finally{await r.close();}
});
