import { createHash } from 'node:crypto';
import { Controller } from './controller.js';
import { checkMinutes, minutesStale } from './minutes.js';
import { automaticPublicationAllowed, unresolved } from './publication.js';

// Offline repair only. Stop the service and back up SQLite first. Originals are
// never edited. The existing publication worker distributes the new unreviewed
// version using its durable reservation/reconciliation protocol (no AI API).
export function mergeMinutes(store,{sources,document,title,clock=Date.now}) {
  if(!Array.isArray(sources)||sources.length<2||new Set(sources.map(s=>s.id)).size!==sources.length)throw new Error('異なる原会議を2件以上指定してください。');
  if(typeof title!=='string'||!title.trim()||title.length>200)throw new Error('統合版の議題を指定してください。');
  const all=store.list();
  if(all.some(s=>['created','recording','paused','empty_grace','finalizing'].includes(s.status)))throw new Error('実行中の会議があります。サービスを停止して復旧してください。');
  const originals=sources.map(ref=>{const s=store.load(ref.id);if(!s||s.status!=='completed'||s.revision!==ref.revision||!s.startedAt||!s.endedAt)throw new Error('終了状態と原本の版を再確認してください。');if(s.publications.some(unresolved))throw new Error('原会議の送信結果を照合してください。');return s;}).sort((a,b)=>a.startedAt-b.startedAt);
  const first=originals[0];
  for(const s of originals)if(!automaticPublicationAllowed(s)||['guildId','voiceChannelId','outputChannelId','fixedVoiceChannelId','fixedMinutesForumId'].some(k=>s[k]!==first[k]))throw new Error('同じ通知済み固定VC・フォーラムの会議だけを統合できます。');
  const sourceKey=originals.map(s=>s.id).sort().join(':');
  const existing=all.find(s=>s.merge?.sourceKey===sourceKey);
  if(existing)return existing; // Retrying an offline import never creates another post.
  const state=new Controller().state,now=clock();
  for(const key of ['guildId','voiceChannelId','ownerId','outputChannelId','fixedVoiceChannelId','fixedMinutesForumId','fixedOperation','publicationPolicy','recordingNoticeSentAt','autoPublicationNoticeAt'])state[key]=first[key];
  Object.assign(state,{topic:title,mode:'minutes',quiet:true,status:'completed',startedAt:first.startedAt,endedAt:Math.max(...originals.map(s=>s.endedAt)),endReason:'merged_recovery',revision:1,sequence:1,lastPersistedAt:now,health:{storage:'ok'},participantIds:[...new Set(originals.flatMap(s=>s.participantIds||[]))]});
  const ids=new Set();
  for(const s of originals){
    for(const u of s.utterances){if(ids.has(u.id))throw new Error('原発言IDが重複しています。自動で上書きしません。');ids.add(u.id);state.utterances.push(structuredClone(u));}
    state.gaps.push(...structuredClone(s.gaps||[]));state.aiTurns.push(...structuredClone(s.aiTurns||[]));
    if(s.health.stt==='failed')state.health.stt='failed';
    for(const d of s.decisions)if(!state.decisions.some(old=>JSON.stringify(old)===JSON.stringify(d)))state.decisions.push(structuredClone(d));
  }
  state.utterances.sort((a,b)=>(a.startMs??a.receivedAt)-(b.startMs??b.receivedAt));
  for(let i=1;i<originals.length;i++)if(originals[i-1].endedAt<originals[i].startedAt)state.gaps.push({kind:'session_interruption',startedAt:originals[i-1].endedAt,endedAt:originals[i].startedAt});
  state.merge={sourceKey,createdAt:now,sources:originals.map(s=>({id:s.id,revision:s.revision,startedAt:s.startedAt,endedAt:s.endedAt,minutesVersion:s.minutesVersion,publicationUrl:s.publications.findLast(p=>p.status==='published')?.url||null}))};
  document=checkMinutes(structuredClone(document),state);
  const version={version:1,kind:'minutes',document,confirmedDecisions:structuredClone(state.decisions),metadata:{topic:title,startedAt:state.startedAt,endedAt:state.endedAt,participantNames:[...new Set(state.utterances.map(u=>u.speaker).filter(Boolean))].map(n=>n.replace(/\s+\(\d{17,22}\)$/,''))},briefRevision:0,generatedAt:now,contextRevision:state.revision,transcriptRefs:state.utterances.filter(u=>u.final&&u.source!=='ai').map(u=>({utteranceId:u.id,revision:u.revision})),approvedAt:null,approvedBy:null,humanReviewedAt:null,humanReviewedBy:null,approvedMarkdown:null,recovery:{method:'assistant_merge_without_api',at:now,documentHash:createHash('sha256').update(JSON.stringify(document)).digest('hex')}};
  if(!version.transcriptRefs.length||minutesStale(state,version))throw new Error('統合版の原発言・根拠を確認してください。');
  state.minutesHistory=[version];state.minutesVersion=1;state.minutesStatus='draft';state.completionJob={status:'pending',phase:'publication',nextAttemptAt:null,errorCategory:null,updatedAt:now};
  // One transaction inserts the new state and audit event; source records and
  // their model usage remain untouched (do not double count the original cost).
  store.save(state,'minutes_merged_without_api',{sources:state.merge.sources,documentHash:version.recovery.documentHash});
  return state;
}
