import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.js';
import {Controller} from '../src/controller.js';
import {mergeMinutes} from '../src/minutes-merge.js';
import {emptyMinutes,minutesMarkdown,minutesStale} from '../src/minutes.js';
import {requirePublishable} from '../src/publication.js';
function fixture(){
 const store=new Store(':memory:');const states=[1,2].map(i=>{const c=new Controller({guildId:'guild',voiceChannelId:'voice',fixedVoiceChannelId:'voice',outputChannelId:'forum',fixedMinutesForumId:'forum',fixedOperation:true,publicationPolicy:'auto_publish_ai_draft',autoPublicationNoticeAt:1,startedAt:i*1000,endedAt:i*1000+500,status:'completed'});c.upsert({id:'u'+i,text:'案'+i+'を検討する。'});c.state.usage=[{input:100}];store.save(c.state,'fixture');return c.state;});
 const document=emptyMinutes();document.overview=[{text:'二案を検討した。',evidence:states.map(s=>({utteranceId:s.utterances[0].id,revision:1}))}];
 return {store,states,args:{sources:states.map(s=>({id:s.id,revision:s.revision})),document,title:'統合版'}};
}
test('統合は両原本を変更せず全発言を新規記録へ保持し、API費用・承認を捏造しない',()=>{
 const {store,states,args}=fixture();try{const before=states.map(s=>store.load(s.id));const s=mergeMinutes(store,args),v=s.minutesHistory[0];assert.equal(s.utterances.length,2);assert.deepEqual(states.map(s=>store.load(s.id)),before);assert.deepEqual(s.usage,[]);assert.equal(v.approvedAt,null);assert.equal(v.humanReviewedBy,null);assert.equal(minutesStale(s,v),false);assert.doesNotThrow(()=>requirePublishable(s,v));assert.equal(s.completionJob.phase,'publication');assert.equal(s.gaps[0].kind,'session_interruption');assert.match(minutesMarkdown(s),/中断区間/);assert.equal(mergeMinutes(store,args).id,s.id);assert.equal(store.list().length,3);assert.deepEqual(store.load(s.id).merge,s.merge);}finally{store.close();}
});
test('別ギルド・別公開先・無通知・古い原本・発言ID重複・不正根拠・記録中の統合を拒否する',()=>{
 for(const fault of ['guild','destination','notice','revision','collision','evidence','active','unknown_publication']){
  const {store,states,args}=fixture();try{const s=states[1];if(fault==='guild')s.guildId='other';if(fault==='destination')s.outputChannelId='other';if(fault==='notice')s.autoPublicationNoticeAt=null;if(fault==='revision')args.sources[1].revision++;if(fault==='collision')s.utterances[0].id='u1';if(fault==='evidence')args.document.overview[0].evidence[0].revision=99;if(fault==='active')s.status='recording';if(fault==='unknown_publication')s.publications=[{status:'needs_reconciliation'}];store.save(s,'fault');assert.throws(()=>mergeMinutes(store,args),fault);assert.equal(store.list().length,2);}finally{store.close();}
 }
});
test('統合保存の失敗は原本を保持し、再実行で一度だけ作成する',()=>{const {store,states,args}=fixture();try{const save=store.save.bind(store),before=states.map(s=>store.load(s.id));store.save=()=>{throw new Error('disk failure');};assert.throws(()=>mergeMinutes(store,args));store.save=save;assert.deepEqual(states.map(s=>store.load(s.id)),before);const s=mergeMinutes(store,args);assert.equal(mergeMinutes(store,args).id,s.id);}finally{store.close();}});

test('統合版はHTTP・SQLiteの既存ワーカーから一度だけ投稿され、モデルを再呼び出ししない',async()=>{
 const {fixedFixture}=await import('./helpers/fixed.js');const r=await fixedFixture();
 try{
  const sources=[];
  for(let i=0;i<2;i++){await r.action('start');await r.emit('修正案を確認し、次のレビューで比較します。');await r.action('end');const s=await r.complete();sources.push({id:s.id,revision:s.revision});}
  const document=emptyMinutes();document.overview=[{text:'修正案を次のレビューで比較する話をした。',evidence:sources.map(ref=>{const u=r.store.load(ref.id).utterances[0];return{utteranceId:u.id,revision:u.revision};})}];
  const state=mergeMinutes(r.store,{sources,document,title:'統合版'});assert.equal(r.generated.length,2);await r.runtime.completionWorker.tick();
  const published=await r.api('/api/sessions/'+state.id);assert.equal(published.completionJob.status,'completed');assert.equal(published.publications[0].status,'published');assert.equal(published.minutesHistory[0].approvedAt,null);assert.equal(r.created.length,3);assert.equal(r.generated.length,2);
  await r.runtime.completionWorker.tick();assert.equal(r.created.length,3);assert.equal(r.generated.length,2);
 }finally{await r.close();}
});
