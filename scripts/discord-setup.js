import { parseArgs } from 'node:util';
import { discordConfig, inviteUrl } from '../src/discord/config.js';
import { command } from '../src/discord/commands.js';
const {values}=parseArgs({options:{register:{type:'boolean',default:false}}});
try{
  const config=discordConfig({requireToken:values.register});
  console.log('招待URL：'+inviteUrl(config));
  if(!values.register){console.log('準備確認のみ。Discord APIは呼びません。--register で /waigaya を指定サーバーへ登録します。');}
  else{
    const response=await fetch(`https://discord.com/api/v10/applications/${config.applicationId}/guilds/${config.guildId}/commands`,{
      method:'POST',headers:{authorization:`Bot ${config.token}`,'content-type':'application/json'},body:JSON.stringify(command),signal:AbortSignal.timeout(15000),
    });
    if(!response.ok)throw new Error(`コマンド登録: HTTP ${response.status}。Botトークン・アプリID・サーバーIDを確認してください。`);
    console.log('/waigaya を登録しました。他のコマンドは変更していません。');
  }
}catch(e){console.error(e.message?.startsWith('コマンド登録:')?e.message:'Discordの設定が不足しているか、接続できません。discord-setup.mdを参照してください。');process.exitCode=1;}
