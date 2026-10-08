import { UserError } from '../errors.js';
import { ChannelType,PermissionFlagsBits } from 'discord.js';
export function fixedPolicy(env=process.env,{required=false}={}) {
  const voiceChannelId=env.WAIGAYA_DISCORD_VOICE_CHANNEL_ID,minutesForumId=env.WAIGAYA_DISCORD_MINUTES_FORUM_ID;
  if(!voiceChannelId&&!minutesForumId&&!required)return null;
  for(const [name,value] of [['DISCORD_GUILD_ID',env.DISCORD_GUILD_ID],['WAIGAYA_DISCORD_VOICE_CHANNEL_ID',voiceChannelId],['WAIGAYA_DISCORD_MINUTES_FORUM_ID',minutesForumId]])if(!/^\d{17,22}$/.test(value||''))throw new UserError(`${name}に固定チャンネルのIDを設定してください。`);
  const responsePolicy=env.WAIGAYA_DISCORD_RESPONSE_POLICY||'on_call';
  if(!['on_call','minutes','facilitator'].includes(responsePolicy))throw new UserError('応答方針はon_call / minutes / facilitatorから設定してください。');
  const emptyGraceMs=Number(env.WAIGAYA_DISCORD_EMPTY_GRACE_MS||180000);
  if(!Number.isInteger(emptyGraceMs)||emptyGraceMs<1000||emptyGraceMs>3600000)throw new UserError('退出猶予は1000〜3600000msで設定してください。');
  const auto=env.WAIGAYA_DISCORD_AUTO_PUBLISH??'true';if(!['true','false'].includes(auto))throw new UserError('自動投稿はtrue / falseで設定してください。');
  return {guildId:env.DISCORD_GUILD_ID,voiceChannelId,minutesForumId,responsePolicy,emptyGraceMs,autoPublish:auto==='true'};
}
export const policyMode=policy=>policy.responsePolicy==='on_call'?'assistant':policy.responsePolicy;
export function validatePolicy(policy) {
  return fixedPolicy({DISCORD_GUILD_ID:policy.guildId,WAIGAYA_DISCORD_VOICE_CHANNEL_ID:policy.voiceChannelId,WAIGAYA_DISCORD_MINUTES_FORUM_ID:policy.minutesForumId,WAIGAYA_DISCORD_RESPONSE_POLICY:policy.responsePolicy,WAIGAYA_DISCORD_EMPTY_GRACE_MS:String(policy.emptyGraceMs),WAIGAYA_DISCORD_AUTO_PUBLISH:String(policy.autoPublish)},{required:true});
}
export async function validateChannels(guild,policy) {
  if(guild.id!==policy.guildId)throw new UserError('固定設定のサーバーが一致しません。');
  let voice,forum;try{[voice,forum]=await Promise.all([guild.channels.fetch(policy.voiceChannelId),guild.channels.fetch(policy.minutesForumId)]);}catch{throw new UserError('固定VC・フォーラムを取得できません。ID・所属・閲覧権限を確認してください。');}
  const inGuild=c=>(c?.guildId||c?.guild?.id)===guild.id;
  if(!inGuild(voice)||voice.type!==ChannelType.GuildVoice||!inGuild(forum)||forum.type!==ChannelType.GuildForum)throw new UserError('固定先は同じサーバーの通常VCとフォーラムにしてください。');
  const bot=guild.members.me;
  if(!voice.permissionsFor(bot)?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.Connect,PermissionFlagsBits.Speak,PermissionFlagsBits.SendMessages]))throw new UserError('固定VCでBotの閲覧・接続・発言・通知送信権限が必要です。');
  if(!forum.permissionsFor(bot)?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.AttachFiles,PermissionFlagsBits.SendMessagesInThreads,PermissionFlagsBits.ReadMessageHistory]))throw new UserError('固定フォーラムでBotの閲覧・送信・添付・スレッド送信・履歴権限が必要です。');
  return {voice,forum};
}
export function automaticTitle(channel,now=Date.now()) {
  const date=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(now));
  return `${date}｜${channel.name}`.slice(0,160);
}
