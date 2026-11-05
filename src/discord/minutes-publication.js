import { AttachmentBuilder,ChannelType,PermissionFlagsBits,ChannelFlagsBitField,MessageFlags,escapeMarkdown } from 'discord.js';
import { UserError } from '../errors.js';
import { requireFormal,digest,unresolved,publicationMarkdown } from '../publication.js';
import { requireOutput } from './access.js';
import { canonicalMinutesDocument,describeMentionPlan,prepareMentionPlan,mentionPlanIndex,mentionPlanPreview,snapshotMentionPlan,mentionReasonLabel } from './owner-mentions.js';

export const safeText = text => escapeMarkdown(String(text??'').replace(/[\r\n\t]/g,' ').replace(/@/g,'＠').replace(/</g,'＜').replace(/>/g,'＞'));
export function splitAttachments(text,name,limit=8*1024*1024) {
  if(!Number.isInteger(limit)||limit<128)throw new UserError('添付容量を確認できません。管理者に相談してください。');
  const bytes=Buffer.from(text),parts=[];
  for(let offset=0;offset<bytes.length;){let end=Math.min(offset+limit,bytes.length);while(end<bytes.length&&(bytes[end]&0xc0)===0x80)end--;parts.push(bytes.subarray(offset,end));offset=end;}
  if(parts.length>10)throw new UserError('添付容量を超えています。非公開ダウンロードを使うか管理者へ相談してください。本文を切り捨てて投稿しません。');
  return parts.map((part,i)=>new AttachmentBuilder(part,{name:parts.length===1?name:name.replace(/\.[^.]+$/,'')+`.part${String(i+1).padStart(2,'0')}${name.match(/\.[^.]+$/)?.[0]||'.md'}`}));
}
export const marker = (state,version,reservation) => `waigaya:${state.id}:v${version.version}:${(reservation.markdownHash||digest(publicationMarkdown(state,version))).slice(0,16)}:r${reservation.reservationId}`;
// Attachment descriptions keep delivery identifiers out of the visible meeting text.
// Older publications carried the same identifier in their message body.
export const hasPublicationMarker = (message,keys) => keys.some(key=>message.content?.includes(key)||[...(message.attachments?.values()||[])].some(a=>a.description===key));
export function forumTitle(state,version) {
  const m=version.metadata||state;
  const date=m.startedAt?new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(m.startedAt)):'日付不明';
  return Array.from(`${date}｜${String(m.topic||state.topic).replace(/[\r\n\t]/g,' ').replace(/@/g,'＠')}`).slice(0,100).join('');
}
const meetingTime=at=>at==null||!Number.isFinite(new Date(at).getTime())?'不明':new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(at)).replaceAll('-','/');
const previewText=(text,limit)=>{const chars=Array.from(String(text??''));return chars.length>limit?chars.slice(0,limit).join('')+'…':chars.join('');};

// Discord本文は2000字上限。安全側に余白を残し、アクション節に通知トークン用の優先枠を確保する。
export const SHORT_MINUTES_LIMIT = 1900;
const plain=text=>({text:String(text??'')});
const mention=id=>({mention:String(id)});
const renderSegments=segments=>segments.map(segment=>segment.mention?`<@${segment.mention}>`:safeText(segment.text)).join('');
const renderBlock=block=>`\n**${block.label}**\n`+block.lines.map(renderSegments).join('\n');
const CATEGORY_LABELS={idea:'案',reason:'理由',constraint:'制約',comparison:'比較',disagreement:'対立',decision_candidate:'決定候補',open_issue:'未決',action:'行動',fact:'事実',verification:'検証',background:'背景'};
const CATEGORY_WEIGHT={disagreement:6,comparison:5,constraint:5,reason:4,verification:4,decision_candidate:4,idea:3,fact:3,open_issue:3,action:2,background:1};
const normalizeForCompare=text=>String(text??'').normalize('NFKC').toLowerCase().replace(/[\s\u3000!-/:-@[-`{-~、。，．・：；？！「」『』（）()【】〔〕〈〉《》…‥〜～]/g,'');
const scoreEntry=entry=>{let score=CATEGORY_WEIGHT[entry.category]??1;if(/\d/.test(entry.text))score+=2;score+=Math.min(entry.evidence?.length||0,3)*0.5;if(Array.from(entry.text).length>40)score+=0.5;return score;};
// 「議論の要点」: 重要度・重複・論点分布で選択する（各節2件固定にしない）。
// v2はdiscussionTopics（idea/reason/comparison/constraint/disagreement等）、v1はideas/comparisonsを
// canonicalMinutesDocument()がtopicsへ写したものを使う。keyFactsも数値・前提として候補に含める。
export function selectMinutesHighlights(document,{max=6}={}) {
  const groups=[];
  for(const topic of document.topics||[]){
    const entries=(topic.entries||[]).filter(entry=>entry&&typeof entry.text==='string'&&entry.text.trim()).map(entry=>({category:entry.category,text:entry.text,evidence:entry.evidence||[],topic:topic.title||topic.topicKey}));
    if(entries.length)groups.push({title:topic.title||topic.topicKey,entries});
  }
  const facts=(document.keyFacts||[]).filter(item=>item&&typeof item.text==='string'&&item.text.trim()).map(item=>({category:'fact',text:item.text,evidence:item.evidence||[],topic:'数値・前提'}));
  if(facts.length)groups.push({title:'数値・前提',entries:facts});
  if(!groups.length)return [];
  const prepared=groups.map(group=>({title:group.title,entries:group.entries.map(entry=>({...entry,score:scoreEntry(entry)})).sort((a,b)=>b.score-a.score)})).filter(group=>group.entries.length);
  prepared.sort((a,b)=>(b.entries[0]?.score??0)-(a.entries[0]?.score??0));
  const picked=[],seen=[];
  const isDuplicate=normalized=>seen.some(existing=>existing===normalized||(existing.length>=8&&normalized.length>=8&&(existing.startsWith(normalized)||normalized.startsWith(existing))));
  let added=true;
  while(picked.length<max&&added){
    added=false;
    for(const group of prepared){
      if(picked.length>=max)break;
      const next=group.entries.shift();
      if(!next)continue;
      const normalized=normalizeForCompare(next.text);
      if(!normalized||isDuplicate(normalized))continue;
      seen.push(normalized);picked.push(next);added=true;
    }
  }
  return picked;
}
const decisionStatusLabel=item=>item?.status==='deferred'?'（保留）':item?.status==='rejected'?'（却下）':'';
function actionStatusLabel(item,action) {
  const owner=previewText(item?.owner||'担当者',40);
  const assignment=item?.assignment;
  if(assignment==='explicit'){
    if(action?.ownerUserId&&action?.suppressReason)return `担当：${owner}（通知なし：${mentionReasonLabel(action.suppressReason)}）`;
    return `担当：${owner}（発言上の指定・ID未確認）`;
  }
  if(assignment==='proposed')return `担当候補：${previewText(item?.owner||'不明',40)}（通知しません）`;
  if(assignment==='conflict')return '担当：担当未確定（要確認）';
  if(assignment==='none')return '担当：担当者特定不可';
  // v1文書: 従来どおり担当文字列を表示（通知対象外）。
  return `担当：${previewText(item?.owner||'不明',40)}`;
}
const ACTION_ITEM_LIMIT=5;
function actionItemLines(item,action,{compact=false}={}) {
  const lines=[[plain('- '+previewText(item.text,compact?100:160))]];
  if(compact){
    // 本文長でトークンを落とす場合は通知せず「担当者特定不可」へフォールバックする。
    const explicit=item?.assignment==='explicit'||item?.assignment===undefined;
    lines.push([plain(`  ${explicit?'担当：担当者特定不可（本文の長さ制限）':actionStatusLabel(item,action)}／期限：${previewText(item?.deadline||'不明',40)}`)]);
  }else if(action?.notify&&action?.ownerUserId){
    lines.push([plain('  担当：'),mention(action.ownerUserId),plain('（発言上の指定・未確認）'),plain(`／期限：${previewText(item?.deadline||'不明',40)}`)]);
  }else lines.push([plain(`  ${actionStatusLabel(item,action)}／期限：${previewText(item?.deadline||'不明',40)}`)]);
  return lines;
}
const segmentsLength=segments=>Array.from(renderSegments(segments)).length;
const linesLength=lines=>lines.reduce((total,segments)=>total+1+segmentsLength(segments),0);
// アクション節は通知トークンの優先枠。入り切らない項目はトークンを落として
// 「担当者特定不可（本文の長さ制限）」へフォールバックし、通知を抑止する。
function buildActionBlockWithBudget(items,planByIndex,budget) {
  const list=(items||[]).slice(0,ACTION_ITEM_LIMIT);
  if(!list.length)return {block:null,used:0};
  const labelLength=Array.from(`\n**アクション（候補）**\n`).length;
  let used=labelLength;
  const lines=[];
  for(const [index,item] of list.entries()){
    const action=planByIndex.get(index);
    const full=actionItemLines(item,action,{compact:false});
    const fullLength=linesLength(full);
    if(used+fullLength<=budget){lines.push(...full);used+=fullLength;continue;}
    const compact=actionItemLines(item,action,{compact:true});
    const compactLength=linesLength(compact);
    if(used+compactLength<=budget){lines.push(...compact);used+=compactLength;continue;}
    break;
  }
  return lines.length?{block:{label:'アクション（候補）',lines},used}:{block:null,used:0};
}
function assembleShortMinutes({headerText,blocks,actionItems,planByIndex,footerText,limit=SHORT_MINUTES_LIMIT}) {
  const footerLength=Array.from(footerText).length;
  const headerLength=Array.from(headerText).length;
  const available=limit-headerLength-footerLength-3;
  // アクション節を先に確保し、残りを概要・議論の要点などへ配分する。
  const action=available>0?buildActionBlockWithBudget(actionItems,planByIndex,available):{block:null,used:0};
  const blockLimit=available-action.used;
  const parts=[headerText];
  let used=headerLength;
  for(const block of blocks){
    const text=renderBlock(block);
    const needed=1+Array.from(text).length;
    if(used-headerLength+needed<=blockLimit){parts.push(text);used+=needed;continue;}
    // 収まらない場合は見出しと入る行だけを残す（本文を恣意的に切らない）。
    let partial=`\n**${block.label}**`;
    for(const segments of block.lines){
      const lineText=renderSegments(segments);
      if(used-headerLength+1+Array.from(partial).length+1+Array.from(lineText).length>blockLimit)break;
      partial+='\n'+lineText;
    }
    if(partial.includes('\n-')&&used-headerLength+1+Array.from(partial).length<=blockLimit){parts.push(partial);used+=1+Array.from(partial).length;}
  }
  if(action.block)parts.push(renderBlock(action.block));
  let content=parts.join('\n')+'\n\n'+footerText;
  // 万一の最終防衛: 上限超過時は文字境界で切る。トークンが途中で切れてもusersには入れない
  // （allowedMentionsは本文の実トークンから再計算する）ため誤通知しない。
  if(Array.from(content).length>limit){content=Array.from(content).slice(0,limit-1).join('')+'…';}
  return {content,actionIncluded:Boolean(action.block)};
}
// 概要・議論の要点・決定・未決・アクションを一読で分かるコンパクト版にする。
// mentions には describeMentionPlan()/公開スナップショットを渡す。通知トークンは
// safeTextで無害化した本文の後に、検証済みsnowflakeから構築した <@id> だけを別ルートで差し込む。
export function shortMinutes(state,version,{mentions,limit=SHORT_MINUTES_LIMIT}={}) {
  const m=version.metadata||state,d=canonicalMinutesDocument(version.document);
  const planByIndex=mentionPlanIndex(mentions);
  const start=meetingTime(m.startedAt),end=meetingTime(m.endedAt),sameDay=start!=='不明'&&end!=='不明'&&start.slice(0,10)===end.slice(0,10);
  const participants=(m.participantNames||[]).map(name=>String(name).replace(/\s+\(\d{17,22}\)$/,''));
  // 見出しのMarkdown記法はそのままに、動的な値だけをsafeTextで無害化する。
  const headerLines=[`**議事録（${version.approvedAt?'確認済み':'AI生成・未確認'}）｜版${version.version}**`,
    `${start}〜${sameDay?end.slice(11):end}（日本時間）`,
    `議題：${safeText(previewText(m.topic||state.topic,120))}`,
    `参加者：${safeText(previewText(participants.join('、')||'不明',160))}`];
  if(m.meetingBrief)headerLines.push(`本筋：${safeText(previewText(m.meetingBrief.text,180))}${m.meetingBrief.needsReview?'（要再確認）':''}`);
  if(m.briefNeedsReview)headerLines.push('本筋：要再確認（指定した発言が訂正されています）');
  const headerText=headerLines.join('\n');
  const blocks=[];
  if(d.overview.length)blocks.push({label:'概要',lines:d.overview.slice(0,3).map(item=>[plain('- '+previewText(item.text,150))])});
  const highlights=selectMinutesHighlights(d,{max:6});
  if(highlights.length)blocks.push({label:'議論の要点',lines:highlights.map(entry=>[plain(`- [${CATEGORY_LABELS[entry.category]||'議論'}] ${previewText(entry.text,140)}`)])});
  const confirmed=version.confirmedDecisions||[];
  if(confirmed.length)blocks.push({label:'確認済み決定',lines:confirmed.slice(0,3).map(item=>[plain('- '+previewText(item.text,140))])});
  if(d.decisionCandidates.length)blocks.push({label:'決定候補（未確認）',lines:d.decisionCandidates.slice(0,3).map(item=>[plain('- '+previewText(item.text,140)+decisionStatusLabel(item))])});
  if(d.openIssues.length)blocks.push({label:'未決事項',lines:d.openIssues.slice(0,3).map(item=>[plain('- '+previewText(item.text,140))])});
  const footer=[];
  if(!confirmed.length)footer.push('確認済みの決定はありません。');
  footer.push(version.approvedAt?'操作担当者が確認済みの版です。':'AIによる下書きです。内容・参加者の合意は未確認です。');
  footer.push('詳細は添付のMarkdownをご覧ください。');
  const footerText=footer.map(text=>renderSegments([plain(text)])).join('\n');
  return assembleShortMinutes({headerText,blocks,actionItems:d.actionItems,planByIndex,footerText,limit}).content;
}
export function mentionTokensInContent(content) {return [...new Set([...String(content??'').matchAll(/<@(\d{17,22})>/g)].map(match=>match[1]))];}
// 本文の実トークンとallowlistを双方向に一致させる。allowlist外のトークンは無害化し、
// allowlistにあるが本文に無いIDはusersへ入れない（通知対象にしない）。
export function applyMentionAllowlist(content,allowedUserIds) {
  const allowed=new Set((Array.isArray(allowedUserIds)?allowedUserIds:[]).filter(id=>/^\d{17,22}$/.test(String(id))));
  let text=String(content??'');
  for(const id of mentionTokensInContent(text))if(!allowed.has(id))text=text.split(`<@${id}>`).join('（通知対象外）');
  return {content:text,userIds:mentionTokensInContent(text).filter(id=>allowed.has(id))};
}
export function renderPublishedContent(state,version,plan) {
  const content=shortMinutes(state,version,{mentions:plan});
  return applyMentionAllowlist(content,plan?.allowedUserIds??[]);
}
async function buildMentionPlanSafely({state,version,channel,mentions}) {
  try{
    return await prepareMentionPlan({state,version,dictionary:mentions?.dictionary,guild:mentions?.guild??channel?.guild??null,
      guildId:mentions?.guildId??state.guildId??channel?.guild?.id??null,guildMembers:mentions?.guildMembers??undefined,now:mentions?.now});
  }catch{
    // メンション計画の失敗で投稿を止めない（安全側=通知なし）。
    return describeMentionPlan(state,version,null,{guildId:state.guildId??channel?.guild?.id??null,now:mentions?.now});
  }
}
export function resolveTags(channel,bot,{reviewed=true}={}) {
  if(channel.type!==ChannelType.GuildForum)return [];
  const manage=channel.permissionsFor(bot)?.has(PermissionFlagsBits.ManageThreads);
  const allowed=(channel.availableTags||[]).filter(t=>(!t.moderated||manage)&&(reviewed||!['確認済み','承認済み'].includes(t.name)));
  let chosen=allowed.filter(t=>(reviewed?['議事録','確認済み']:['議事録','未確認','要再確認','AI生成']).includes(t.name));
  if(channel.flags?.has(ChannelFlagsBitField.Flags.RequireTag)&&!chosen.length){if(!allowed.length)throw new UserError('必須タグを適用できません。管理者が使えるタグまたはBotの権限を設定してください。');chosen=[allowed[0]];}
  return chosen.slice(0,5);
}
export function requireThread(thread,actor,bot,parentId) {
  if(!thread||thread.parentId!==parentId)throw new UserError('既存の議事録投稿が削除・移動されています。管理者に相談し、無断で別投稿を作らないでください。');
  if(!thread.permissionsFor(actor)?.has(PermissionFlagsBits.ViewChannel))throw new UserError('議事録投稿を閲覧できる権限が必要です。');
  if(!thread.permissionsFor(bot)?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessagesInThreads,PermissionFlagsBits.AttachFiles]))throw new UserError('既存投稿でBotの閲覧・スレッド送信・添付権限が必要です。');
  const manage=thread.permissionsFor(bot)?.has(PermissionFlagsBits.ManageThreads);
  if(thread.locked&&!manage)throw new UserError('投稿がロックされています。管理者が解除するかBotの管理権限を確認してください。');
  if(thread.archived&&!manage&&thread.ownerId!==(bot.id||bot.user?.id))throw new UserError('投稿がアーカイブされています。管理者が再開してください。');
}
export async function preparePublication({state,channel,actor,bot,attachmentLimit,mentions}) {
  const version=state.minutesHistory.at(-1);requireFormal(state,version);requireOutput(channel,actor,bot);
  const plan=await buildMentionPlanSafely({state,version,channel,mentions});
  const files=splitAttachments(publicationMarkdown(state,version),`minutes-v${version.version}.md`,Math.min(attachmentLimit||8*1024*1024,8*1024*1024));
  const previous=state.publications.find(p=>p.channelId===channel.id&&p.status==='published');
  let thread;
  if(previous?.threadId){try{thread=await channel.guild.channels.fetch(previous.threadId);}catch{throw new UserError('既存の議事録投稿を取得できません。削除・権限を管理者が確認してください。');}requireThread(thread,actor,bot,channel.id);}
  const tags=resolveTags(channel,bot,{reviewed:Boolean(version.approvedAt)}),content=shortMinutes(state,version,{mentions:plan});
  return {version,files,thread,tags,title:forumTitle(state,version),content,mentions:plan,mentionsSnapshot:snapshotMentionPlan(plan),mentionSummary:mentionPlanPreview(plan)};
}
export class DiscordMinutesPublisher {
  constructor(){this.jobs=new Map();}
  busy(sessionId){return [...this.jobs.keys()].some(k=>k.startsWith(sessionId+':'));}
  async publish({state,channel,actor,bot,api,attachmentLimit,mentions}) {
    const key=state.id+':'+channel.id;
    if(this.jobs.has(key))return this.jobs.get(key);
    const job=this.perform({state,channel,actor,bot,api,attachmentLimit,mentions});this.jobs.set(key,job);
    try{return await job;}finally{this.jobs.delete(key);}
  }
  async perform({state,channel,actor,bot,api,attachmentLimit,mentions}) {
    const version=state.minutesHistory.at(-1),existing=state.publications.find(p=>p.version===version?.version&&p.channelId===channel.id);
    if(existing?.status==='published')return {duplicate:true,...existing};
    if(existing&&unresolved(existing))throw new UserError('送信結果を /reconcile で照合してください。二重投稿しません。');
    const prepared=await preparePublication({state,channel,actor,bot,attachmentLimit,mentions});
    const reserved=await api({action:'publication_reserve',version:version.version,channelId:channel.id,destinationType:channel.type===ChannelType.GuildForum?'forum':'text',actorId:actor.id,outputRevision:state.outputRevision||0,mentions:prepared.mentionsSnapshot});
    const p=reserved.publications.find(p=>p.version===version.version&&p.channelId===channel.id);
    const frozenVersion=reserved.minutesHistory.find(v=>v.version===p.version);
    prepared.files=splitAttachments(p.publicationMarkdown||p.approvedMarkdown,`minutes-v${p.version}.md`,Math.min(attachmentLimit||8*1024*1024,8*1024*1024));
    // 予約時にサーバー側で抑止適用済みのスナップショットを唯一の正として本文を描画する。
    const rendered=renderPublishedContent(reserved,frozenVersion,p.mentions);
    prepared.content=rendered.content;
    const notifiedUserIds=rendered.userIds;
    prepared.files[0].setDescription(marker(state,version,p));
    const message={content:(p.starterMessageId?'訂正版を追加しました。\n\n':'')+prepared.content,files:prepared.files,
      allowedMentions:notifiedUserIds.length?{parse:[],users:notifiedUserIds,repliedUser:false}:{parse:[]},flags:MessageFlags.SuppressEmbeds};
    let delivery;
    try {
      // Recheck immediately before side effects; never switch to another channel.
      requireOutput(channel,actor,bot);
      if(state.fixedOperation&&channel.id!==state.fixedMinutesForumId)throw new UserError('固定フォーラム以外には投稿しません。');
      if(prepared.thread){requireThread(prepared.thread,actor,bot,channel.id);if(prepared.thread.archived)await prepared.thread.setArchived(false,'議事録の版更新');const sent=await prepared.thread.send(message);delivery={messageId:sent.id,threadId:prepared.thread.id,starterMessageId:p.starterMessageId,url:sent.url};}
      else if(channel.type===ChannelType.GuildForum){const thread=await channel.threads.create({name:prepared.title,message,appliedTags:prepared.tags.map(t=>t.id)});delivery={messageId:thread.id,threadId:thread.id,starterMessageId:thread.id,url:`https://discord.com/channels/${state.guildId}/${thread.id}/${thread.id}`};}
      else {const sent=await channel.send(message);delivery={messageId:sent.id,threadId:null,starterMessageId:p.starterMessageId||sent.id,url:sent.url};
        if(!p.starterMessageId&&channel.permissionsFor(bot)?.has([PermissionFlagsBits.CreatePublicThreads,PermissionFlagsBits.SendMessagesInThreads])){try{const thread=await sent.startThread({name:prepared.title});delivery.threadId=thread.id;}catch{delivery.warning='親メッセージは投稿済みです。スレッドを作れなかったため版更新は元チャンネルに追記します。';}}
      }
    }catch(e){const confirmedUnsent=e instanceof UserError||Number(e.status)>=400&&Number(e.status)<500&&![408,429].includes(Number(e.status));await api({action:'publication_failure',version:version.version,channelId:channel.id,reservationId:p.reservationId,confirmedUnsent}).catch(()=>{});
      throw new UserError(confirmedUnsent?'Discordが投稿を受け付けませんでした。公開する本文は保持しています。権限・タグ・容量を直して再試行できます。':'Discord送信結果が不明です。議事録本文と予約を保持しています。/reconcile で照合するまで再送しません。');}
    try{await api({action:'publication',version:version.version,channelId:channel.id,reservationId:p.reservationId,actorId:actor.id,...delivery,notifiedUserIds});}
    catch{await api({action:'publication_failure',version:version.version,channelId:channel.id,reservationId:p.reservationId,confirmedUnsent:false}).catch(()=>{});throw new UserError(`Discordへの送信は完了しましたが結果保存を確認できません。/reconcile で照合してください。投稿：${delivery.url}`);}
    return delivery;
  }
}
