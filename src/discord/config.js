import { fixedPolicy } from './fixed-policy.js';
import { loadServiceToken } from '../credentials.js';
import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';

export function discordConfig({env=process.env,workspace=process.cwd(),requireToken=true,requireFixed=requireToken}={}) {
  const id = (value, name) => { if (!/^\d{17,22}$/.test(value || '')) throw new Error(`${name}を設定してください。`); return value; };
  const applicationId=id(env.DISCORD_APPLICATION_ID,'DISCORD_APPLICATION_ID');
  const guildId=id(env.DISCORD_GUILD_ID,'DISCORD_GUILD_ID');
  let token=env.DISCORD_BOT_TOKEN?.trim();
  if (!token && env.DISCORD_BOT_TOKEN_FILE) {
    const root=realpathSync(workspace),target=resolve(root,env.DISCORD_BOT_TOKEN_FILE),local=relative(root,target);
    if(local.startsWith('..')||isAbsolute(local))throw new Error('Botトークンのファイルは作業フォルダー内で指定してください。');
    const stat=lstatSync(target);
    if(!stat.isFile()||stat.isSymbolicLink()||realpathSync(target)!==target||stat.size>4096)throw new Error('Botトークンのファイルを安全に読めません。');
    token=readFileSync(target,'utf8').trim();
  }
  if(token && (!/^[A-Za-z0-9_.-]{30,300}$/.test(token)||token.includes('\n')))throw new Error('Botトークンは値だけを一つ設定してください。');
  if(requireToken&&!token)throw new Error('DISCORD_BOT_TOKEN_FILE又はDISCORD_BOT_TOKENを設定してください。');
  const server=new URL(env.WAIGAYA_DISCORD_SERVER || `http://127.0.0.1:${env.WAIGAYA_PORT || 8765}`);
  if(server.protocol!=='http:'||!['127.0.0.1','localhost'].includes(server.hostname)||server.username||server.password||server.pathname!=='/'||server.search||server.hash)throw new Error('Discord Botの接続先は同じ端末のHTTPサーバーにしてください。');
  const addressNames=(env.WAIGAYA_DISCORD_ADDRESS_NAMES||'ワイガヤ,わいがや,我ヶ谷,我が谷').split(',').map(s=>s.trim()).filter(Boolean);
  if(!addressNames.length||addressNames.length>20||addressNames.some(s=>s.length<2||s.length>32))throw new Error('呼び名は2〜32文字、最大20件で設定してください。');
  return {applicationId,guildId,token,fixed:fixedPolicy(env,{required:requireFixed}),addressNames,server:server.origin,serviceToken:loadServiceToken({env,workspace}),controlRoleIds:(env.WAIGAYA_DISCORD_CONTROL_ROLE_IDS||'').split(',').filter(Boolean)};
}

export function inviteUrl({applicationId,guildId}) {
  // ViewChannel / SendMessages / Connect / Speak。管理者権限は要求しない。
  const permissions=(1024n|2048n|32768n|65536n|34359738368n|274877906944n|1048576n|2097152n).toString();
  const url=new URL('https://discord.com/oauth2/authorize');
  url.search=new URLSearchParams({client_id:applicationId,scope:'bot applications.commands',permissions,guild_id:guildId,disable_guild_select:'true'}).toString();
  return url.href;
}
