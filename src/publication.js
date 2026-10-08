import { randomUUID,createHash } from 'node:crypto';
import { UserError } from './errors.js';
import { minutesStale,minutesMarkdown } from './minutes.js';
export const digest = text => createHash('sha256').update(text).digest('hex');
export const unresolved = p => ['pending','publish_reserved','needs_reconciliation'].includes(p.status);
export function publicationState(state,version=state.minutesVersion) {
  const p=state.publications.findLast(p=>p.version===version&&p.channelId===state.outputChannelId);
  if(p)return p.status==='pending'?'needs_reconciliation':p.status;
  return state.minutesHistory.at(-1)?.approvedAt?'approved_unpublished':'private_draft';
}
export const publicationLabels={private_draft:'下書き・未確認',approved_unpublished:'確認済み・未公開',publish_reserved:'送信予約・処理中',needs_reconciliation:'送信結果要照合',failed_confirmed:'未送信確認済み・再試行可',published:'公開済み'};
export function requireFormal(state,version) {
  if(!version||version.kind!=='minutes'||state.status!=='completed')throw new UserError('途中要約は正式議事録として投稿できません。/finish 後の議事録を確認してください。');
  if(minutesStale(state,version))throw new UserError('原発言が変わっています。再生成・確認してください。');
}
export function changeDestination(state,{channelId,actorId},now=Date.now()) {
  if(channelId!==null&&!/^\d{17,22}$/.test(channelId||''))throw new UserError('保存先を選び直してください。');
  if(state.publications.some(unresolved))throw new UserError('送信結果の照合が必要です。/reconcile で解決してから保存先を変更してください。');
  state.outputChannelId=channelId;state.outputRevision=(state.outputRevision||0)+1;
  state.destinationHistory??=[];state.destinationHistory.push({channelId,actorId,at:now});
}
export function approveVersion(state,version,actorId,now=Date.now()) {
  requireFormal(state,version);
  if(!version.approvedAt){version.approvedAt=now;version.approvedBy=actorId;state.minutesStatus='approved';version.approvedMarkdown=null;version.approvedMarkdown=minutesMarkdown(state,version);}
}
export function applyPublication(state,body,now=Date.now()) {
  const version=state.minutesHistory.find(v=>v.version===body.version);
  const current=state.publications.find(p=>p.version===body.version&&p.channelId===body.channelId);
  if(body.action==='publication_recover') {for(const p of state.publications)if(['pending','publish_reserved'].includes(p.status)){p.status='needs_reconciliation';p.errorCategory='process_restarted';}return;}
  if(body.action==='publication_reserve') {
    requireFormal(state,version);
    if(version!==state.minutesHistory.at(-1)||!version.approvedAt||body.channelId!==state.outputChannelId)throw new UserError('最新の確認済み版と指定保存先が必要です。');
    if(body.outputRevision!==undefined&&body.outputRevision!==(state.outputRevision||0))throw new UserError('保存先が変わりました。確認し直してください。');
    if(current&&current.status!=='failed_confirmed')throw new UserError('この版は公開済みか送信結果の確認待ちです。二重投稿しません。');
    if(state.publications.some(p=>unresolved(p)&&p!==current))throw new UserError('前の送信結果を /reconcile で照合してから投稿してください。');
    if(!['forum','text'].includes(body.destinationType))throw new UserError('保存先の種類を確認してください。');
    const prior=state.publications.find(p=>p.channelId===body.channelId&&p.status==='published');
    const p={sessionId:state.id,version:body.version,channelId:body.channelId,destinationChannelId:body.channelId,destinationType:body.destinationType,reservationId:randomUUID(),attemptedAt:now,actorId:body.actorId,status:'publish_reserved',threadId:prior?.threadId||null,starterMessageId:prior?.starterMessageId||prior?.messageId||null,messageId:null,approvedAt:version.approvedAt,approvedBy:version.approvedBy,approvedMarkdown:version.approvedMarkdown,markdownHash:digest(version.approvedMarkdown),outputRevision:state.outputRevision||0,attempts:current?[...(current.attempts||[]),{...current,attempts:undefined}]:[]};
    if(current)state.publications[state.publications.indexOf(current)]=p;else state.publications.push(p);return p;
  }
  if(!current||body.reservationId!==current.reservationId)throw new UserError('投稿予約が変わりました。状態を確認してください。');
  if(body.action==='publication'||body.action==='publication_link') {
    if(current.status==='published'){if(current.messageId===body.messageId)return current;throw new UserError('公開結果は記録済みです。');}
    if(!unresolved(current))throw new UserError('照合可能な送信予約がありません。');
    if(!/^\d{17,22}$/.test(body.messageId||'')||body.threadId&&!/^\d{17,22}$/.test(body.threadId))throw new UserError('Discordの投稿識別情報が不正です。');
    Object.assign(current,{status:'published',messageId:body.messageId,threadId:body.threadId||current.threadId,starterMessageId:body.starterMessageId||current.starterMessageId||body.messageId,publishedAt:now,errorCategory:null,url:body.url||null,reconciledBy:body.action==='publication_link'?body.actorId:null});return current;
  }
  if(body.action==='publication_failure') {
    if(!unresolved(current))return current;
    current.status=body.confirmedUnsent?'failed_confirmed':'needs_reconciliation';current.errorCategory=body.confirmedUnsent?'discord_rejected':'delivery_unknown';return current;
  }
  if(body.action==='publication_absence') {
    if(!unresolved(current)||!body.complete||now-current.attemptedAt<600000)throw new UserError('完全な照合と送信から10分の待機が必要です。自動再送しません。');
    current.absenceVerifiedAt=now;current.absenceVerifiedBy=body.actorId;current.absenceToken=randomUUID();return current;
  }
  if(body.action==='publication_retry') {
    if(current.status==='failed_confirmed')return current;
    if(!unresolved(current)||!current.absenceToken||body.absenceToken!==current.absenceToken||current.absenceVerifiedBy!==body.actorId||now-current.absenceVerifiedAt>60000)throw new UserError('未投稿の照合が必要です。/reconcile で確認し直してください。');
    current.status='failed_confirmed';current.errorCategory='administrator_confirmed_absent';current.absenceToken=null;return current;
  }
  throw new UserError('投稿操作を確認してください。');
}

export function normalizePublications(state) {
  state.outputRevision??=0;state.destinationHistory??=[];
  for(const p of state.publications||[]){
    const version=state.minutesHistory?.find(v=>v.version===p.version);
    if(!p.reservationId){p.reservationId=randomUUID();p.legacyMarker=true;}
    p.sessionId??=state.id;p.destinationChannelId??=p.channelId;p.destinationType??='text';
    p.attemptedAt??=p.at??null;p.approvedMarkdown??=version?.approvedMarkdown??null;
    p.markdownHash??=p.approvedMarkdown?digest(p.approvedMarkdown):null;
    p.starterMessageId??=p.status==='published'?p.messageId:null;
    if(['pending','publish_reserved'].includes(p.status)){p.status='needs_reconciliation';p.errorCategory='process_restarted';}
  }
}
