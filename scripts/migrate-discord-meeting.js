import { Store } from '../src/store.js';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function migrateLegacyMeeting(store,{sessionId,guildId,voiceChannelId,ownerId}) {
  if(!/^[0-9a-f-]{36}$/.test(sessionId||'')||![guildId,voiceChannelId,ownerId].every(id=>/^\d{17,22}$/.test(id||'')))throw new Error('実際の会議・サーバー・VC・開始者のIDを指定してください。');
  const state=store.load(sessionId);
  if(!state||state.guildId||!state.utterances.some(u=>u.source==='discord'))throw new Error('未移行のDiscord会議だけが対象です。');
  Object.assign(state,{guildId,voiceChannelId,ownerId,mode:'minutes',status:'paused',quiet:true,autonomous:false,startedAt:state.startedAt??null,endedAt:state.endedAt??null,endReason:'legacy_migration_requires_resume',health:{...state.health,connection:'failed'}});
  store.save(state,'legacy_discord_access_assigned',{guildId,voiceChannelId,ownerId});return state;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 let store;
 try{
  if(!process.argv.includes('--offline'))throw new Error('Botと会議サーバーを停止してから --offline を指定してください。');
  for(const filename of ['data/server.pid','data/discord-bot.pid'])if(existsSync(filename)){
    const pid=Number(readFileSync(filename,'utf8').trim());if(!Number.isInteger(pid)||pid<=0)continue;
    let active=false;try{process.kill(pid,0);active=true;}catch{}if(active)throw new Error('稼働中のプロセスが見つかりました。Botとサーバーを停止してください。');
  }
  const option=name=>{const i=process.argv.indexOf('--'+name);return i<0?undefined:process.argv[i+1];};
  store=new Store();migrateLegacyMeeting(store,{sessionId:option('session'),guildId:option('guild'),voiceChannelId:option('voice'),ownerId:option('owner')});
  console.log('元の会議IDと記録を保持して、閲覧担当を設定しました。記録は停止中です。必要な場合だけDiscordで /resume を操作してください。');
 }catch(e){console.error(e.message);process.exitCode=1;}finally{store?.close();}
}
