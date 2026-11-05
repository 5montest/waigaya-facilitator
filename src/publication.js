import { randomUUID,createHash } from 'node:crypto';
import { UserError } from './errors.js';
import { checkMinutes,minutesStale,minutesMarkdown } from './minutes.js';
export const digest = text => createHash('sha256').update(text).digest('hex');
export const unresolved = p => ['pending','publish_reserved','needs_reconciliation'].includes(p.status);

// 担当者メンションの公開スナップショット。Discord固有の解決結果をデータとして保持し、
// 二重通知防止と照合の判断をサーバー側の純関数で行えるようにする。
export const MENTION_SNAPSHOT_SCHEMA_VERSION = 1;
const MENTION_SNOWFLAKE = /^\d{17,22}$/;
const MENTION_UNRESOLVED_STATUSES = ['pending','publish_reserved','needs_reconciliation'];
const mentionTextNormalization = /[\s\u3000!-/:-@[-`{-~、。，．・：；？！「」『』（）()【】〔〕〈〉《》…‥〜～]/g;
export const normalizeMentionText = text => String(text??'').normalize('NFKC').toLowerCase().replace(mentionTextNormalization,'');
export const mentionTextDigest = text => {const normalized=normalizeMentionText(text);return normalized?digest(normalized).slice(0,16):null;};
const mentionEvidence = list => (Array.isArray(list)?list:[]).slice(0,20).map(ref=>({utteranceId:String(ref?.utteranceId??''),revision:Number(ref?.revision??NaN)})).filter(ref=>ref.utteranceId&&Number.isInteger(ref.revision));
const mentionUnique = list => [...new Set(list)];
export function normalizeMentionSnapshot(raw) {
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return null;
  const actions=(Array.isArray(raw.actions)?raw.actions:[]).slice(0,64).map((entry,index)=>{
    if(!entry||typeof entry!=='object')return null;
    const actionIndex=Number.isInteger(entry.actionIndex)?entry.actionIndex:index;
    if(actionIndex<0||actionIndex>999)return null;
    const evidence=mentionEvidence(entry.evidence);
    const utteranceIds=mentionUnique((Array.isArray(entry.utteranceIds)?entry.utteranceIds:evidence.map(ref=>ref.utteranceId)).map(String).filter(Boolean)).slice(0,20);
    const ownerUserId=MENTION_SNOWFLAKE.test(String(entry.ownerUserId??''))?String(entry.ownerUserId):null;
    return {actionIndex,
      assignment:['explicit','proposed','none','conflict','unknown','legacy'].includes(entry.assignment)?entry.assignment:'unknown',
      owner:entry.owner==null?null:String(entry.owner).slice(0,120),
      displayName:typeof entry.displayName==='string'&&entry.displayName?entry.displayName.slice(0,120):null,
      ownerUserId,
      resolution:typeof entry.resolution==='string'?entry.resolution.slice(0,60):'unknown',
      suppressReason:typeof entry.suppressReason==='string'?entry.suppressReason.slice(0,80):null,
      notify:entry.notify===true&&Boolean(ownerUserId),
      notified:entry.notified===true,
      notifiedAt:Number.isFinite(entry.notifiedAt)?entry.notifiedAt:null,
      assignmentEvidence:evidence[0]??null,
      evidence,
      utteranceIds,
      textDigest:/^[0-9a-f]{16,64}$/.test(String(entry.textDigest??''))?String(entry.textDigest):null};
  }).filter(Boolean);
  return {schemaVersion:MENTION_SNAPSHOT_SCHEMA_VERSION,
    guildId:MENTION_SNOWFLAKE.test(String(raw.guildId??''))?String(raw.guildId):null,
    dictionaryVersion:typeof raw.dictionaryVersion==='string'?raw.dictionaryVersion.slice(0,64):null,
    resolvedAt:Number.isFinite(raw.resolvedAt)?raw.resolvedAt:null,
    enabled:raw.enabled===true,
    reason:typeof raw.reason==='string'?raw.reason.slice(0,80):null,
    actions,
    allowedUserIds:mentionUnique(actions.filter(action=>action.notify&&action.ownerUserId).map(action=>action.ownerUserId))};
}
// 同一会議内の「同一担当者userId + 同一根拠発言」を同一アクションとみなす。
// 根拠のrevisionが訂正で変わった場合は新規通知にせず不明扱いで抑止する。
function sameMentionAction(candidate,prior) {
  if(!candidate.ownerUserId||!prior.ownerUserId||candidate.ownerUserId!==prior.ownerUserId)return 'different';
  if(candidate.evidence.some(ref=>prior.evidence.some(p=>p.utteranceId===ref.utteranceId&&p.revision===ref.revision)))return 'exact';
  if(candidate.utteranceIds.some(id=>prior.utteranceIds.includes(id)))return 'revision_changed';
  if(candidate.textDigest&&prior.textDigest&&candidate.textDigest===prior.textDigest)return 'same_text';
  return 'different';
}
function legacyMentionAction(document,candidate) {
  const items=Array.isArray(document?.actionItems)?document.actionItems:[];
  return items.some(item=>{
    const refs=Array.isArray(item?.evidence)?item.evidence:[];
    if(refs.some(ref=>ref&&candidate.utteranceIds.includes(ref.utteranceId)))return true;
    const textDigest=mentionTextDigest(item?.text);
    return Boolean(textDigest&&candidate.textDigest&&textDigest===candidate.textDigest);
  });
}
// 送信前の候補スナップショットに、既存の公開記録に基づく二重通知抑止を適用する。
// 通知済み/不明（送信結果不明・旧形式・根拠訂正）は通知しない。未送信が確認済みの記録は抑止しない。
export function applyMentionSuppression(snapshot,{publications=[],minutesHistory=[],now=Date.now()}={}) {
  const normalized=normalizeMentionSnapshot(snapshot);
  if(!normalized)return null;
  normalized.resolvedAt=Number.isFinite(normalized.resolvedAt)?normalized.resolvedAt:now;
  if(!normalized.enabled){for(const action of normalized.actions)if(action.notify){action.notify=false;action.suppressReason??=normalized.reason||'notifications_disabled';}normalized.allowedUserIds=[];return normalized;}
  const versionDocument=version=>minutesHistory?.find(entry=>entry?.version===version)?.document??null;
  const notified=[],unknown=[],legacyDocuments=[];
  let legacyUnknownAll=false;
  for(const publication of publications||[]){
    if(!publication||typeof publication!=='object')continue;
    if(publication.status==='failed_confirmed')continue;
    const unresolvedPublication=MENTION_UNRESOLVED_STATUSES.includes(publication.status);
    if(publication.status!=='published'&&!unresolvedPublication)continue;
    const prior=normalizeMentionSnapshot(publication.mentions);
    if(prior){
      for(const action of prior.actions){
        if(!action.notify||!action.ownerUserId)continue;
        if(publication.status==='published'&&action.notified)notified.push(action);
        else if(unresolvedPublication)unknown.push(action);
        // published かつ notified=false は本文長などでトークンが入らなかった既知の未通知。再通知を許可する。
      }
    }else{
      const document=versionDocument(publication.version);
      if(document)legacyDocuments.push(document);else legacyUnknownAll=true;
    }
  }
  for(const action of normalized.actions){
    if(!action.notify)continue;
    const suppress=reason=>{action.notify=false;action.suppressReason=reason;};
    if(legacyUnknownAll){suppress('prior_state_unknown');continue;}
    let suppressed=false;
    for(const prior of notified){const level=sameMentionAction(action,prior);if(level==='exact'){suppress('already_notified');suppressed=true;break;}if(level==='revision_changed'||level==='same_text'){suppress('prior_revision_changed');suppressed=true;break;}}
    if(suppressed)continue;
    for(const prior of unknown){if(sameMentionAction(action,prior)!=='different'){suppress('prior_delivery_unknown');suppressed=true;break;}}
    if(suppressed)continue;
    for(const document of legacyDocuments){if(legacyMentionAction(document,action)){suppress('prior_state_unknown');suppressed=true;break;}}
  }
  normalized.allowedUserIds=mentionUnique(normalized.actions.filter(action=>action.notify&&action.ownerUserId).map(action=>action.ownerUserId));
  return normalized;
}
// 送信後に報告された「本文に実在したトークン」がスナップショットのallowlistの部分集合かを検証する。
// 不一致はfail-closedで通知済みにしない（別のユーザーへ誤通知した可能性を残さない）。
export function verifyMentionDelivery(publication,notifiedUserIds) {
  const snapshot=normalizeMentionSnapshot(publication?.mentions);
  const requested=mentionUnique((Array.isArray(notifiedUserIds)?notifiedUserIds:[]).filter(id=>typeof id==='string'&&MENTION_SNOWFLAKE.test(id)));
  if(!snapshot||!snapshot.enabled||!snapshot.actions.length)return {ok:requested.length===0,accepted:[],rejected:requested,truncated:[],reason:snapshot?'notifications_disabled':'no_mention_snapshot'};
  const allowed=new Set(snapshot.allowedUserIds);
  const rejected=requested.filter(id=>!allowed.has(id));
  if(rejected.length)return {ok:false,accepted:[],rejected,truncated:[],reason:'notified_user_not_allowed'};
  const notifyIds=mentionUnique(snapshot.actions.filter(action=>action.notify&&action.ownerUserId).map(action=>action.ownerUserId));
  const accepted=requested.filter(id=>notifyIds.includes(id));
  const truncated=notifyIds.filter(id=>!requested.includes(id));
  return {ok:true,accepted,rejected:[],truncated,reason:truncated.length?'truncated':'delivered'};
}
export function markMentionNotifications(publication,userIds,now=Date.now()) {
  const ids=new Set((Array.isArray(userIds)?userIds:[]).filter(id=>typeof id==='string'&&MENTION_SNOWFLAKE.test(id)));
  if(!publication?.mentions?.actions||!ids.size)return publication;
  for(const action of publication.mentions.actions)if(action.notify&&action.ownerUserId&&ids.has(action.ownerUserId)){action.notified=true;action.notifiedAt=now;}
  return publication;
}
// 照合で復旧した送信は「配信済みの可能性」を優先し、通知済みとして記録して再送しない。
export function markAllMentionNotifications(publication,now=Date.now()) {
  if(!publication?.mentions?.actions)return publication;
  for(const action of publication.mentions.actions)if(action.notify&&action.ownerUserId&&!action.notified){action.notified=true;action.notifiedAt=now;}
  return publication;
}
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
export function automaticPublicationAllowed(state) {
  return state.fixedOperation===true && state.publicationPolicy==='auto_publish_ai_draft' &&
    state.voiceChannelId===state.fixedVoiceChannelId && state.outputChannelId===state.fixedMinutesForumId && Boolean(state.autoPublicationNoticeAt);
}
export function publicationMarkdown(state,version) {
  return version.approvedMarkdown||minutesMarkdown(state,version);
}
export function requirePublishable(state,version) {
  requireFormal(state,version);checkMinutes(structuredClone(version.document),state);
  if(!version.approvedAt&&!automaticPublicationAllowed(state))throw new UserError('人の確認か、通知済みの固定VC・フォーラム自動公開ポリシーが必要です。');
}
export function changeDestination(state,{channelId,actorId},now=Date.now()) {
  if(state.fixedOperation&&channelId!==state.fixedMinutesForumId)throw new UserError('この会議の保存先は固定フォーラムです。管理者が導入設定を確認してください。');
  if(channelId!==null&&!/^\d{17,22}$/.test(channelId||''))throw new UserError('保存先を選び直してください。');
  if(state.publications.some(unresolved))throw new UserError('送信結果の照合が必要です。/reconcile で解決してから保存先を変更してください。');
  state.outputChannelId=channelId;state.outputRevision=(state.outputRevision||0)+1;
  state.destinationHistory??=[];state.destinationHistory.push({channelId,actorId,at:now});
}
export function approveVersion(state,version,actorId,now=Date.now()) {
  requireFormal(state,version);
  if(!version.approvedAt){version.approvedAt=now;version.approvedBy=actorId;version.humanReviewedAt=now;version.humanReviewedBy=actorId;state.minutesStatus='approved';version.approvedMarkdown=null;version.approvedMarkdown=minutesMarkdown(state,version);}
}
export function applyPublication(state,body,now=Date.now()) {
  const version=state.minutesHistory.find(v=>v.version===body.version);
  const current=state.publications.find(p=>p.version===body.version&&p.channelId===body.channelId);
  if(body.action==='publication_recover') {for(const p of state.publications)if(['pending','publish_reserved'].includes(p.status)){p.status='needs_reconciliation';p.errorCategory='process_restarted';}return;}
  if(body.action==='publication_reserve') {
    requirePublishable(state,version);
    if(version!==state.minutesHistory.at(-1)||body.channelId!==state.outputChannelId)throw new UserError('最新の正式版と指定保存先が必要です。');
    if(body.outputRevision!==undefined&&body.outputRevision!==(state.outputRevision||0))throw new UserError('保存先が変わりました。確認し直してください。');
    if(current&&current.status!=='failed_confirmed')throw new UserError('この版は公開済みか送信結果の確認待ちです。二重投稿しません。');
    if(state.publications.some(p=>unresolved(p)&&p!==current))throw new UserError('前の送信結果を /reconcile で照合してから投稿してください。');
    if(state.fixedOperation&&(body.channelId!==state.fixedMinutesForumId||body.destinationType!=='forum'))throw new UserError('固定フォーラム以外へは投稿しません。');
    if(!['forum','text'].includes(body.destinationType))throw new UserError('保存先の種類を確認してください。');
    const prior=state.publications.find(p=>p.channelId===body.channelId&&p.status==='published');
    // 送信前の候補スナップショットに、既存の公開記録に基づく二重通知抑止を最終適用する。
    const mentions=normalizeMentionSnapshot(body.mentions);
    const suppressedMentions=mentions?applyMentionSuppression(mentions,{publications:state.publications.filter(item=>item!==current),minutesHistory:state.minutesHistory,now}):null;
    const p={sessionId:state.id,version:body.version,channelId:body.channelId,destinationChannelId:body.channelId,destinationType:body.destinationType,reservationId:randomUUID(),attemptedAt:now,actorId:body.actorId,status:'publish_reserved',threadId:prior?.threadId||null,starterMessageId:prior?.starterMessageId||prior?.messageId||null,messageId:null,approvedAt:version.approvedAt,approvedBy:version.approvedBy,approvedMarkdown:version.approvedMarkdown||null,publicationMarkdown:publicationMarkdown(state,version),reviewStatus:version.approvedAt?'human_reviewed':'ai_unreviewed',markdownHash:digest(publicationMarkdown(state,version)),outputRevision:state.outputRevision||0,mentions:suppressedMentions,mentionDelivery:null,attempts:current?[...(current.attempts||[]),{...current,attempts:undefined}]:[]};
    if(current)state.publications[state.publications.indexOf(current)]=p;else state.publications.push(p);return p;
  }
  if(!current||body.reservationId!==current.reservationId)throw new UserError('投稿予約が変わりました。状態を確認してください。');
  if(body.action==='publication'||body.action==='publication_link') {
    if(current.status==='published'){if(current.messageId===body.messageId)return current;throw new UserError('公開結果は記録済みです。');}
    if(!unresolved(current))throw new UserError('照合可能な送信予約がありません。');
    if(!/^\d{17,22}$/.test(body.messageId||'')||body.threadId&&!/^\d{17,22}$/.test(body.threadId))throw new UserError('Discordの投稿識別情報が不正です。');
    Object.assign(current,{status:'published',messageId:body.messageId,threadId:body.threadId||current.threadId,starterMessageId:body.starterMessageId||current.starterMessageId||body.messageId,publishedAt:now,errorCategory:null,url:body.url||null,reconciledBy:body.action==='publication_link'?body.actorId:null});
    // 通知済み記録は「本文に実在したトークン」だけを対象にする。allowlist外のIDが報告されたら
    // fail-closedで1件も通知済みにしない（誤通知の可能性を通知済みと偽らない）。
    if(body.action==='publication_link'){markAllMentionNotifications(current,now);current.mentionDelivery={ok:true,reason:'reconciled_assume_delivered',notifiedCount:(current.mentions?.allowedUserIds||[]).length,truncatedCount:0};}
    else{const verification=verifyMentionDelivery(current,body.notifiedUserIds);if(verification.ok)markMentionNotifications(current,verification.accepted,now);current.mentionDelivery={ok:verification.ok,reason:verification.reason,notifiedCount:verification.accepted.length,truncatedCount:verification.truncated.length};}
    return current;
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
    // 旧記録（mentionsなし）はnullのまま。存在する場合は形を正規化して後方互換を保つ。
    p.mentions=normalizeMentionSnapshot(p.mentions);
    p.mentionDelivery??=null;
    if(['pending','publish_reserved'].includes(p.status)){p.status='needs_reconciliation';p.errorCategory='process_restarted';}
  }
}
