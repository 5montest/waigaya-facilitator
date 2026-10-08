import { PermissionFlagsBits,ChannelType } from 'discord.js';
import { UserError } from '../errors.js';
import { marker } from './minutes-publication.js';

export function requireAdministrator(interaction) {
  if(!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild))throw new UserError('保存先の既定設定・送信結果の照合はサーバー管理者だけが操作できます。');
}
export async function inspectPublication({state,publication,channel,bot,maxPages=10}) {
  if(!channel.permissionsFor(bot)?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.ReadMessageHistory]))throw new UserError('照合にはBotの閲覧・メッセージ履歴権限が必要です。管理者が設定してください。');
  if(publication.legacyMarker)throw new UserError('旧予約には照合用識別子がありません。投稿URLを指定した照合を使ってください。旧投稿の添付本文を検証します。');
  const version=state.minutesHistory.find(v=>v.version===publication.version),markers=[publication,...(publication.attempts||[])].map(p=>marker(state,version,p));
  const botId=bot.id||bot.user?.id,matches=[];let complete=true;
  const read=async(target,threadId=null)=>{
    if(!target.permissionsFor(bot)?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.ReadMessageHistory])){complete=false;return;}
    let before,done=false;
    for(let i=0;i<maxPages;i++){
      const batch=await target.messages.fetch({limit:100,...(before?{before}:{})});
      for(const m of batch.values())if(m.author?.id===botId&&markers.some(key=>m.content?.includes(key)))matches.push({messageId:m.id,threadId:threadId||(m.hasThread?m.id:null),starterMessageId:publication.starterMessageId||(threadId||m.id),url:m.url});
      if(batch.size<100||[...batch.values()].some(m=>m.createdTimestamp<Math.min(publication.attemptedAt,...(publication.attempts||[]).map(a=>a.attemptedAt))-5000)){done=true;break;}
      before=batch.last().id;
    }
    if(!done)complete=false;
  };
  try{
    if(publication.threadId){const thread=await channel.guild.channels.fetch(publication.threadId);if(!thread||thread.parentId!==channel.id)throw new Error();await read(thread,thread.id);}
    else if(channel.type===ChannelType.GuildForum){
      const threads=new Map();for(const t of (await channel.threads.fetchActive()).threads.values())if(t.parentId===channel.id)threads.set(t.id,t);
      let before,done=false;
      for(let i=0;i<maxPages;i++){const result=await channel.threads.fetchArchived({type:'public',limit:100,...(before?{before}:{})});for(const t of result.threads.values())threads.set(t.id,t);if(!result.hasMore){done=true;break;}before=result.threads.last()?.archiveTimestamp;if(!before){break;}}
      if(!done)complete=false;
      const candidates=[...threads.values()].filter(t=>!t.createdTimestamp||t.createdTimestamp>=publication.attemptedAt-5000);
      if(candidates.length>100){complete=false;}
      for(const t of candidates.slice(0,100))await read(t,t.id);
    }else await read(channel);
  }catch{throw new UserError('投稿一覧を完全に照合できません。権限・接続・削除を確認してください。自動再送しません。');}
  return {matches,complete};
}
export async function verifyMessageLink({state,publication,guild,bot,url,fetchImpl=fetch}) {
  const match=String(url||'').match(/^https:\/\/(?:canary\.|ptb\.)?discord\.com\/channels\/(\d{17,22})\/(\d{17,22})\/(\d{17,22})$/);
  if(!match||match[1]!==state.guildId)throw new UserError('同じサーバーの投稿URLを指定してください。');
  const target=await guild.channels.fetch(match[2]);
  if(!target||(target.id!==publication.channelId&&target.parentId!==publication.channelId))throw new UserError('予約した保存先の投稿URLが必要です。');
  if(!target.permissionsFor(bot)?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.ReadMessageHistory]))throw new UserError('投稿の閲覧・履歴権限が必要です。');
  const message=await target.messages.fetch(match[3]);
  if(message.author?.id!==(bot.id||bot.user?.id))throw new UserError('このBotが投稿した議事録だけを照合できます。');
  const version=state.minutesHistory.find(v=>v.version===publication.version);
  let valid=[publication,...(publication.attempts||[])].some(p=>message.content?.includes(marker(state,version,p)));
  if(!valid&&publication.legacyMarker){
    const attachment=[...message.attachments.values()].find(a=>a.name===`minutes-v${publication.version}.md`);
    if(attachment&&attachment.size<=8*1024*1024){const cdn=new URL(attachment.url);if(cdn.protocol==='https:'&&['cdn.discordapp.com','media.discordapp.net'].includes(cdn.hostname)){
      const response=await fetchImpl(cdn,{signal:AbortSignal.timeout(10000)});if(response.ok){const {digest}=await import('../publication.js');valid=digest(await response.text())===publication.markdownHash;}
    }}
  }
  if(!valid)throw new UserError('会議・版・確認済み本文の識別が一致しません。別の投稿へ紐付けません。');
  return {messageId:message.id,threadId:target.parentId===publication.channelId?target.id:message.hasThread?message.id:null,starterMessageId:publication.starterMessageId||(target.parentId===publication.channelId?target.id:message.id),url:message.url};
}
