import { createHash } from 'node:crypto';
import { checkMinutes, minutesStale } from './minutes.js';

// Offline operation: stop the Bot/server and back up SQLite before calling.
// No model, network, human approval, transcript edit or publication is performed.
export function recoverMinutes(store, { sessionId, document, expectedRevision, clock = Date.now }) {
  const state=store.load(sessionId);
  if(!state||state.status!=='finalize_failed'||state.minutesHistory.length)throw new Error('終了処理に失敗し、正式版がまだない会議だけを復旧できます。');
  if(state.revision!==expectedRevision)throw new Error('原本が更新されています。再確認してください。');
  if(store.list().some(s=>['recording','empty_grace','paused','finalizing'].includes(s.status)))throw new Error('実行中・一時停止中の会議があるためオフライン復旧できません。');
  if(state.publications.length)throw new Error('公開履歴を照合してから復旧してください。');
  if(!state.endedAt)throw new Error('終了時刻を確認できません。');
  document=checkMinutes(structuredClone(document),state);
  const finals=state.utterances.filter(u=>u.final&&u.source!=='ai');
  if(!finals.length)throw new Error('原発言がない会議の内容は作成できません。');
  const now=clock(),version={
    version:state.minutesVersion+1,kind:'minutes',document,confirmedDecisions:structuredClone(state.decisions),
    metadata:{topic:state.topic,meetingBrief:structuredClone(state.meetingBrief),briefNeedsReview:Boolean(state.meetingBrief?.needsReview),startedAt:state.startedAt,endedAt:state.endedAt,
      participantNames:[...new Set(state.utterances.map(u=>u.speaker).filter(Boolean))].map(name=>name.replace(/\s+\(\d{17,22}\)$/,''))},
    briefRevision:state.briefRevision,generatedAt:now,contextRevision:state.revision,
    transcriptRefs:finals.map(u=>({utteranceId:u.id,revision:u.revision})),
    approvedAt:null,approvedBy:null,humanReviewedAt:null,humanReviewedBy:null,approvedMarkdown:null,
    recovery:{method:'assistant_without_api',at:now,documentHash:createHash('sha256').update(JSON.stringify(document)).digest('hex')}
  };
  if(minutesStale(state,version))throw new Error('原本との整合性を確認できません。');
  state.minutesHistory.push(version);state.minutesVersion=version.version;state.minutesStatus='draft';state.status='completed';state.lastError=null;
  state.completionJob={...state.completionJob,status:'pending',phase:'publication',nextAttemptAt:null,errorCategory:null,updatedAt:now};
  state.sequence=(state.sequence||0)+1;state.lastPersistedAt=now;
  store.save(state,'minutes_recovered_without_api',{version:version.version,documentHash:version.recovery.documentHash,sourceUtterances:finals.length});
  return state;
}
