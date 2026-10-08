import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Controller } from '../src/controller.js';
import { emptyMinutes } from '../src/minutes.js';
import { applyPublication } from '../src/publication.js';
import { ids,fixedFixture } from './helpers/fixed.js';
function seed(kind){
 const root=mkdtempSync(join(tmpdir(),'waigaya-fixed-recovery-')),path=join(root,'records.sqlite'),store=new Store(path),now=Date.now();
 const c=new Controller({mode:'assistant',guildId:ids.guild,voiceChannelId:ids.vc,fixedVoiceChannelId:ids.vc,fixedMinutesForumId:ids.forum,ownerId:ids.owner,fixedOperation:true,publicationPolicy:'auto_publish_ai_draft',outputChannelId:ids.forum,autoPublicationNoticeAt:now-10000,recordingNoticeSentAt:now-10000,autoFinishAfterMs:1000},()=>now-10000);
 c.lifecycle('start');c.upsert({id:'seed-u',source:'discord',userId:ids.owner,text:'A案の試行を提案しました。'});
 if(kind==='empty')c.lifecycle('empty');
 if(kind==='draft'||kind==='reserved'||kind==='finalizing'){
  c.lifecycle('finish');c.state.completionJob={status:'pending',phase:'generation',generationAttempts:0};
  if(kind!=='finalizing'){
   const d=emptyMinutes();d.overview=[{text:'A案の試行を検討した。',evidence:[{utteranceId:'seed-u',revision:1}]}];c.state.minutesHistory=[{version:1,kind:'minutes',document:d,approvedAt:null,approvedBy:null,confirmedDecisions:[],transcriptRefs:[{utteranceId:'seed-u',revision:1}]}];c.state.minutesVersion=1;c.state.status='completed';c.state.minutesStatus='draft';c.state.completionJob.phase='publication';
   if(kind==='reserved')applyPublication(c.state,{action:'publication_reserve',version:1,channelId:ids.forum,destinationType:'forum',actorId:ids.bot});
  }
 }
 store.save(c.state,'fixture_seed');store.close();return {root,path,id:c.state.id};
}
test('再起動: 全員退出の永続猶予から録音再開せず終了・生成・投稿を完了する',async()=>{
 const data=seed('empty'),r=await fixedFixture({path:data.path,voiceEmpty:true});try{const state=await r.complete();assert.equal(state.id,data.id);assert.equal(state.status,'completed');assert.equal(r.joins(),0);assert.equal(r.captures.length,0);assert.equal(r.created.length,1);assert.equal(state.completionJob.status,'completed');}finally{await r.close();rmSync(data.root,{recursive:true,force:true});}
});
test('再起動: 人が戻っていれば記録停止を維持し、明示resumeだけで同じIDを再開する',async()=>{
 const data=seed('empty'),r=await fixedFixture({path:data.path});try{assert.equal((await r.state()).status,'paused');assert.equal(r.joins(),0);assert.equal(r.created.length,0);await r.action('resume');assert.equal((await r.state()).id,data.id);assert.equal((await r.state()).status,'recording');assert.equal((await r.state()).quiet,false);assert.equal(r.joins(),1);assert.match(r.notices[0].content,/AI生成・未確認/);}finally{await r.close();rmSync(data.root,{recursive:true,force:true});}
});
test('再起動: Bot不在中に無人になった会議も新規作成せず猶予から終了する',async()=>{
 const data=seed('recording'),r=await fixedFixture({path:data.path,voiceEmpty:true});try{assert.equal((await r.state()).status,'empty_grace');r.runtime.completionWorker.clock=()=>Date.now()+2000;await r.runtime.completionWorker.tick();const state=await r.complete();assert.equal(state.id,data.id);assert.equal(r.created.length,1);assert.equal(r.joins(),0);}finally{await r.close();rmSync(data.root,{recursive:true,force:true});}
});
test('再起動: 終了途中と未公開下書きのジョブをVCへ戻らず完了し、再走査でも二重投稿しない',async()=>{
 for(const kind of ['finalizing','draft']){const data=seed(kind),r=await fixedFixture({path:data.path});try{const state=await r.complete();assert.equal(state.completionJob.status,'completed');assert.equal(r.created.length,1);assert.equal(r.joins(),0);assert.equal(state.minutesHistory.at(-1).approvedAt,null);await r.runtime.completionWorker.tick();assert.equal(r.created.length,1);}finally{await r.close();rmSync(data.root,{recursive:true,force:true});}}
});
test('再起動: 送信中に死亡した予約は要照合に保ち、自動再送せず原本・公開本文を保持する',async()=>{
 const data=seed('reserved'),r=await fixedFixture({path:data.path});try{const state=await r.state();assert.equal(state.publications[0].status,'needs_reconciliation');assert.ok(state.publications[0].publicationMarkdown);assert.equal(r.created.length,0);assert.equal(r.joins(),0);assert.equal(state.completionJob.status,'needs_reconciliation');const notifications=r.dms.length;await r.runtime.completionWorker.tick();assert.equal(r.dms.length,notifications);}finally{await r.close();rmSync(data.root,{recursive:true,force:true});}
});

test('再起動: 公開済みAI未確認版のDiscord ID・本文・原本を復元して自動再送しない',async()=>{
 const data=seed('draft');let first,second;try{first=await fixedFixture({path:data.path});const published=await first.complete();assert.equal(first.created.length,1);assert.equal(published.publications[0].status,'published');const p=structuredClone(published.publications[0]);await first.close();first=null;second=await fixedFixture({path:data.path});await second.runtime.completionWorker.tick();const s=await second.state();assert.equal(second.created.length,0);assert.equal(second.joins(),0);assert.deepEqual(s.publications[0],p);assert.equal(s.minutesHistory[0].approvedAt,null);assert.equal(s.utterances[0].id,'seed-u');}
 finally{await first?.close();await second?.close();rmSync(data.root,{recursive:true,force:true});}
});
