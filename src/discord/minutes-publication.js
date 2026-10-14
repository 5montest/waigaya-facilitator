import { AttachmentBuilder,ChannelType,PermissionFlagsBits,ChannelFlagsBitField,MessageFlags,escapeMarkdown } from 'discord.js';
import { UserError } from '../errors.js';
import { requireFormal,digest,unresolved,publicationMarkdown } from '../publication.js';
import { requireOutput } from './access.js';

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
const previewText=(text,limit)=>safeText(Array.from(String(text??'')).length>limit?Array.from(String(text)).slice(0,limit).join('')+'…':text);
export function shortMinutes(state,version) {
  const m=version.metadata||state,d=version.document;
  const start=meetingTime(m.startedAt),end=meetingTime(m.endedAt),sameDay=start!=='不明'&&end!=='不明'&&start.slice(0,10)===end.slice(0,10);
  const participants=(m.participantNames||[]).map(name=>String(name).replace(/\s+\(\d{17,22}\)$/,''));
  const lines=[`**議事録（${version.approvedAt?'確認済み':'AI生成・未確認'}）｜版${version.version}**`,`${start}〜${sameDay?end.slice(11):end}（日本時間）`,`議題：${previewText(m.topic||state.topic,120)}`,`参加者：${previewText(participants.join('、')||'不明',160)}`];
  for(const [label,items] of [['概要',d.overview],['確認済み決定',version.confirmedDecisions||[]],['決定候補（未確認）',d.decisionCandidates],['未決事項',d.openIssues],['アクション（候補）',d.actionItems]]){
    if(!items.length)continue;
    const block=`\n**${label}**\n`+items.slice(0,2).map(i=>'- '+previewText(i.text,130)+(label.startsWith('アクション')?`\n  担当：${previewText(i.owner||'不明',40)}／期限：${previewText(i.deadline||'不明',40)}`:'')).join('\n');
    if(lines.join('\n').length+block.length<=1450)lines.push(block);
  }
  if(!version.confirmedDecisions?.length)lines.push('\n確認済みの決定はありません。');
  lines.push('\n'+(version.approvedAt?'操作担当者が確認した版です。参加者全員の合意を保証するものではありません。':'AIによる下書きです。内容・参加者の合意は未確認です。'),'詳細・根拠・記録欠損の注記は添付のMarkdownをご覧ください。');
  return lines.join('\n');
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
export async function preparePublication({state,channel,actor,bot,attachmentLimit}) {
  const version=state.minutesHistory.at(-1);requireFormal(state,version);requireOutput(channel,actor,bot);
  const files=splitAttachments(publicationMarkdown(state,version),`minutes-v${version.version}.md`,Math.min(attachmentLimit||8*1024*1024,8*1024*1024));
  const previous=state.publications.find(p=>p.channelId===channel.id&&p.status==='published');
  let thread;
  if(previous?.threadId){try{thread=await channel.guild.channels.fetch(previous.threadId);}catch{throw new UserError('既存の議事録投稿を取得できません。削除・権限を管理者が確認してください。');}requireThread(thread,actor,bot,channel.id);}
  const tags=resolveTags(channel,bot,{reviewed:Boolean(version.approvedAt)}),content=shortMinutes(state,version);
  return {version,files,thread,tags,title:forumTitle(state,version),content};
}
export class DiscordMinutesPublisher {
  constructor(){this.jobs=new Map();}
  busy(sessionId){return [...this.jobs.keys()].some(k=>k.startsWith(sessionId+':'));}
  async publish({state,channel,actor,bot,api,attachmentLimit}) {
    const key=state.id+':'+channel.id;
    if(this.jobs.has(key))return this.jobs.get(key);
    const job=this.perform({state,channel,actor,bot,api,attachmentLimit});this.jobs.set(key,job);
    try{return await job;}finally{this.jobs.delete(key);}
  }
  async perform({state,channel,actor,bot,api,attachmentLimit}) {
    const version=state.minutesHistory.at(-1),existing=state.publications.find(p=>p.version===version?.version&&p.channelId===channel.id);
    if(existing?.status==='published')return {duplicate:true,...existing};
    if(existing&&unresolved(existing))throw new UserError('送信結果を /reconcile で照合してください。二重投稿しません。');
    const prepared=await preparePublication({state,channel,actor,bot,attachmentLimit});
    const reserved=await api({action:'publication_reserve',version:version.version,channelId:channel.id,destinationType:channel.type===ChannelType.GuildForum?'forum':'text',actorId:actor.id,outputRevision:state.outputRevision||0});
    const p=reserved.publications.find(p=>p.version===version.version&&p.channelId===channel.id);
    const frozenVersion=reserved.minutesHistory.find(v=>v.version===p.version);
    prepared.files=splitAttachments(p.publicationMarkdown||p.approvedMarkdown,`minutes-v${p.version}.md`,Math.min(attachmentLimit||8*1024*1024,8*1024*1024));prepared.content=shortMinutes(reserved,frozenVersion);
    prepared.files[0].setDescription(marker(state,version,p));
    const message={content:(p.starterMessageId?'訂正版を追加しました。\n\n':'')+prepared.content,files:prepared.files,allowedMentions:{parse:[]},flags:MessageFlags.SuppressEmbeds};
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
    try{await api({action:'publication',version:version.version,channelId:channel.id,reservationId:p.reservationId,actorId:actor.id,...delivery});}
    catch{await api({action:'publication_failure',version:version.version,channelId:channel.id,reservationId:p.reservationId,confirmedUnsent:false}).catch(()=>{});throw new UserError(`Discordへの送信は完了しましたが結果保存を確認できません。/reconcile で照合してください。投稿：${delivery.url}`);}
    return delivery;
  }
}
