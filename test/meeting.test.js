import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../src/controller.js';
import { EmptyGrace, modes, transition } from '../src/meeting.js';
import { Store } from '../src/store.js';
import { MinutesGenerator, emptyMinutes, checkMinutes, minutesMarkdown, minutesStale, splitChunks } from '../src/minutes.js';
import { Confirmations, MinutesPublisher, requireAccess, requireOutput } from '../src/discord/access.js';
import { ChannelType, PermissionFlagsBits } from 'discord.js';

function fixture(mode='facilitator') {
 let now=10000;
 const c=new Controller({},()=>now);c.configure({mode});c.upsert({id:'u1',text:'設定に半日かかりました。担当は未定です。',speaker:'A',final:true});
 const result={action:'question',reason:'具体例を確認',text:'具体的には？',evidence:[{utteranceId:'u1',revision:1}],notes:[]};
 return {c,result,advance:ms=>{now+=ms;}};
}
test('T02/T11 minutesでは候補があっても再生不可、モード切替は文脈と音声を失効させる',()=>{
 const {c,result,advance}=fixture();c.healthy(true);advance(1000);const ticket=c.beginRequest({mode:'autonomous'});assert.equal(c.accept(result,ticket),true);
 c.configure({mode:'minutes'});assert.equal(c.state.id,ticket.state.id);assert.equal(c.state.utterances.length,1);assert.equal(c.state.reply,null);assert.throws(()=>c.permitReply(ticket.requestId));
 const manual=c.beginRequest({mode:'reply'});assert.equal(c.accept(result,manual),true);assert.throws(()=>c.permitReply(manual.requestId),/音声/);assert.equal(c.state.autonomous,false);
});
test('T08 quietは原本を保って音声を止める、modeを明示変更すると再開',()=>{
 const {c,result,advance}=fixture();c.healthy(true);advance(1000);c.accept(result,c.beginRequest());c.permit(c.state.candidate.id);c.configure({quiet:true});
 assert.equal(c.state.playback,null);assert.equal(c.state.utterances.length,1);assert.equal(c.state.autonomous,false);c.configure({mode:'facilitator'});assert.equal(c.state.quiet,false);
});
test('T09 自律質問の生成中に具体例が出たら質問を受理しない。手動回答は保持',()=>{
 for(const mode of ['autonomous','reply']){
  const {c,result}=fixture();const ticket=c.beginRequest({mode});c.upsert({id:'u2',text:'前回の設定に半日かかったんだよ。'});
  assert.equal(c.accept(result,ticket),mode==='reply');
 }
});
test('自律候補は生成後の意味のある発言・根拠訂正・TTLで破棄',()=>{
 for(const invalidate of [c=>c.upsert({id:'u2',text:'問題は説明書で解消しました。'}),c=>c.upsert({id:'u1',text:'訂正：設定は一時間でした。'}),(_,advance)=>advance(15000)]){
  const {c,result,advance}=fixture();c.healthy(true);advance(1000);const ticket=c.beginRequest({mode:'autonomous'});c.accept(result,ticket);invalidate(c,advance);assert.throws(()=>c.permitReply(ticket.requestId));
 }
});
test('T03 人間0人の猶予から3分未満で復帰すると終了せず同じ会議を継続',async()=>{
 let now=0,ended=0;const {c}=fixture('minutes');c.lifecycle('start');const id=c.state.id;
 const grace=new EmptyGrace({clock:()=>now,onEmpty:()=>c.lifecycle('empty'),onReturn:()=>c.lifecycle('returned'),onFinish:()=>{ended++;c.lifecycle('finish');}});
 await grace.members(0);assert.equal(c.state.status,'empty_grace');now=179999;assert.equal(await grace.tick(),false);await grace.members(1);
 assert.equal(c.state.id,id);assert.equal(c.state.status,'recording');now=300000;assert.equal(await grace.tick(),false);assert.equal(ended,0);grace.close();
});
test('T04/T05 退出3分と手動終了が競合しても終了は一度、古い猶予は動かない',async()=>{
 let now=0,ended=0;const c=new Controller();c.lifecycle('start');
 const finish=()=>{if(c.lifecycle('finish'))ended++;};
 const grace=new EmptyGrace({clock:()=>now,onEmpty:()=>c.lifecycle('empty'),onReturn:()=>{},onFinish:finish});await grace.members(0);now=180000;
 await Promise.all([grace.tick(),grace.tick(),Promise.resolve().then(finish)]);assert.equal(ended,1);assert.equal(c.state.status,'finalizing');grace.close();await grace.members(1);assert.equal(c.state.status,'finalizing');
});
test('T18 終了済み会議はstart/resumeで記録状態に戻らない',()=>{
 const c=new Controller({status:'completed'});assert.throws(()=>c.lifecycle('start'));assert.throws(()=>c.lifecycle('resume'));assert.equal(c.lifecycle('finish'),false);
});
test('T01 Discordの開始通知なしでは記録を開始しない',()=>{
 const c=new Controller({guildId:'123456789012345678'});assert.throws(()=>c.lifecycle('start'),/通知/);assert.equal(c.state.status,'created');
});
test('T12 決定候補と確認済み決定を分離、推定した担当・期限は不明',()=>{
 const {c}=fixture();const document=emptyMinutes();document.decisionCandidates=[{text:'試行する案',evidence:[{utteranceId:'u1',revision:1}]}];document.actionItems=[{text:'設定を試す',owner:'田中',deadline:'来週',evidence:[{utteranceId:'u1',revision:1}]}];
 checkMinutes(document,c.state);assert.equal(document.actionItems[0].owner,null);assert.equal(document.actionItems[0].deadline,null);
 const md=minutesMarkdown(c.state,{version:1,document});assert.match(md,/決定候補（確認待ち）/);assert.match(md,/人が確認済み）\n\n該当なし/);assert.match(md,/担当：不明/);assert.equal(c.state.decisions.length,0);
});
test('T17 原発言の訂正で議事録の根拠が要再確認になる',()=>{
 const {c}=fixture();const document=emptyMinutes();document.overview=[{text:'設定作業の検討',evidence:[{utteranceId:'u1',revision:1}]}];const v={version:1,document,approvedAt:1000};
 assert.equal(minutesStale(c.state,v),false);c.upsert({id:'u1',text:'訂正：対象は別の作業です。'});assert.equal(minutesStale(c.state,v),true);assert.match(minutesMarkdown(c.state,v),/要再確認/);
});
test('T19 空の会議ではモデルを呼ばず会議内容なしと表示',async()=>{
 const generator=new MinutesGenerator({generate:()=>assert.fail('空の会議でAPIを呼んだ')});const c=new Controller();const document=await generator.generateDraft(c.state);assert.deepEqual(document,emptyMinutes());assert.match(minutesMarkdown(c.state,{version:1,document}),/会議内容なし/);
});
test('T20 多量の原発言を欠落なく分割し、統合でも根拠を保持',async()=>{
 const c=new Controller();for(let i=0;i<40;i++)c.upsert({id:'u'+i,text:'設定を比較します。'.repeat(80)});
 const ids=new Set();let merges=0;
 const generator=new MinutesGenerator({chunkLimit:5000,generate:async({input})=>{
  const document=emptyMinutes();if(input.utterances){input.utterances.forEach(u=>ids.add(u.id));const u=input.utterances[0];document.overview=[{text:'設定比較',evidence:[{utteranceId:u.id,revision:u.revision}]}];}
  else{merges++;document.overview=[input.partialSummaries[0]];delete document.overview[0].provisional;}
  return {result:document,usage:{inputTokens:1}};
 }});
 const draft=await generator.generateDraft(c.state);assert.equal(ids.size,40);assert.ok(merges>0);assert.ok(draft.overview.length);assert.equal(c.state.utterances.length,40);
});
test('根拠のない議事録・AI発言の引用・過大な単独入力を拒否',()=>{
 const {c}=fixture(),document=emptyMinutes();document.ideas=[{text:'案',evidence:[{utteranceId:'missing',revision:1}]}];assert.throws(()=>checkMinutes(document,c.state));
 c.state.utterances[0].source='ai';document.ideas[0].evidence=[{utteranceId:'u1',revision:1}];assert.throws(()=>checkMinutes(document,c.state));assert.throws(()=>splitChunks([{text:'a'.repeat(100)}],20));
});
test('T15/T22 別サーバー・非担当者・VC閲覧不可では操作と閲覧を拒否',()=>{
 const state={guildId:'g',ownerId:'owner',voiceChannelId:'vc'},channel={permissionsFor:()=>({has:()=>true})};
 const interaction={guildId:'g',user:{id:'owner'},member:{},memberPermissions:{has:()=>false},guild:{voiceStates:{cache:new Map([['owner',{channelId:'vc'}]])}}};
 assert.doesNotThrow(()=>requireAccess(state,interaction,channel,{live:true}));assert.throws(()=>requireAccess(state,{...interaction,guildId:'other'},channel));assert.throws(()=>requireAccess(state,{...interaction,user:{id:'other'}},channel));assert.throws(()=>requireAccess(state,interaction,{permissionsFor:()=>({has:()=>false})}));
});
test('T14 公開先なし・投稿/添付権限不足を拒否',()=>{
 assert.throws(()=>requireOutput(null,{},{}));assert.throws(()=>requireOutput({type:ChannelType.GuildText,permissionsFor:()=>({has:()=>false})},{},{}));
});
test('T16/T21 確認ボタンは利用者・TTL・多重クリックを検証',()=>{
 let now=0;const confirmations=new Confirmations({clock:()=>now}),state={id:'s',minutesVersion:1};const id=confirmations.issue('publish',state,'owner');
 assert.throws(()=>confirmations.take(id,'other'));assert.equal(confirmations.take(id,'owner').version,1);assert.throws(()=>confirmations.take(id,'owner'));
 const expired=confirmations.issue('finish',state,'owner');now=60000;assert.throws(()=>confirmations.take(expired,'owner'));
});
test('T16 共有連打は同じ版を一度だけ送信・確定',async()=>{
 const publisher=new MinutesPublisher(),state={id:'s',minutesHistory:[{version:1}],publications:[]};let sends=0,reserves=0,commits=0;
 const options={state,channelId:'c',reserve:async()=>{reserves++;},send:async()=>{sends++;await new Promise(r=>setTimeout(r,10));return{id:'m'};},commit:async()=>{commits++;state.publications.push({version:1,channelId:'c'});}};
 await Promise.all([publisher.publish(options),publisher.publish(options)]);assert.equal(sends,1);assert.equal(reserves,1);assert.equal(commits,1);assert.equal((await publisher.publish(options)).duplicate,true);
});
test('送信の結果が不明でも予約を残し、自動再送しない',async()=>{
 const publisher=new MinutesPublisher(),state={id:'s',minutesHistory:[{version:1}],publications:[]};let sends=0;
 const options={state,channelId:'c',reserve:async()=>state.publications.push({version:1,channelId:'c',status:'pending'}),send:async()=>{sends++;throw new Error('network');},commit:assert.fail};
 await assert.rejects(()=>publisher.publish(options),/共有送信に失敗.*結果が不明/);assert.equal((await publisher.publish(options)).duplicate,true);assert.equal(sends,1);
});
test('Discord投稿成功後の保存失敗は送信失敗と区別し、同じ版を再送しない',async()=>{
 const publisher=new MinutesPublisher(),state={id:'s',minutesHistory:[{version:1}],publications:[]};let sends=0;
 const options={state,channelId:'c',reserve:async()=>state.publications.push({version:1,channelId:'c',status:'pending'}),send:async()=>{sends++;return{id:'posted'};},commit:async()=>{throw new Error('unsafe database exception');}};
 await assert.rejects(()=>publisher.publish(options),/送信は完了.*保存を確認できません/);assert.equal((await publisher.publish(options)).duplicate,true);assert.equal(sends,1);
});

test('原発言の訂正は版を検証し、Discord由来の情報を保つ',()=>{
 const c=new Controller();c.upsert({id:'u',text:'設定は半日でした。',source:'discord'});
 assert.throws(()=>c.upsert({id:'u',text:'訂正',expectedRevision:2}));c.upsert({id:'u',text:'訂正：設定は一時間でした。',expectedRevision:1,source:'manual'});assert.equal(c.state.utterances[0].source,'discord');assert.equal(c.state.utterances[0].revision,2);
});

test('旧Discord会議は人が実IDを指定して移行し、原本と会議IDを保つ',async()=>{
 const {migrateLegacyMeeting}=await import('../scripts/migrate-discord-meeting.js');const store=new Store(':memory:');const c=new Controller();c.upsert({id:'u',text:'既存の会議を記録した。',source:'discord'});store.save(c.state,'legacy');
 try{assert.throws(()=>migrateLegacyMeeting(store,{sessionId:c.state.id,guildId:'fake',voiceChannelId:'v',ownerId:'o'}));const result=migrateLegacyMeeting(store,{sessionId:c.state.id,guildId:'123456789012345678',voiceChannelId:'223456789012345678',ownerId:'323456789012345678'});assert.equal(result.id,c.state.id);assert.equal(result.utterances.length,1);assert.equal(result.status,'paused');assert.equal(result.mode,'minutes');assert.equal(result.startedAt,null);assert.equal(result.quiet,true);}finally{store.close();}
});
