// One local test process. Uses an existing credential profile without copying secrets.
import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadOpenAIKey } from '../src/credentials.js';
import { discordConfig } from '../src/discord/config.js';
import { commandFor } from '../src/discord/commands.js';
import { createApp } from '../src/server.js';
import { Store } from '../src/store.js';
import { runBot } from '../src/discord/bot.js';
const {values}=parseArgs({options:{profile:{type:'string'},port:{type:'string',default:'8875'},database:{type:'string',default:'data/discord-test.sqlite'},register:{type:'boolean',default:false}}});
const profile=resolve(values.profile||'.'),port=Number(values.port);
if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('テスト用ポートを1024〜65535で指定してください。');
for(const file of ['.env.local','.env.discord']){const path=resolve(profile,file);if(existsSync(path))process.loadEnvFile(path);}
let app,store;
try {
 loadOpenAIKey({workspace:profile});const config=discordConfig({workspace:profile});if(!process.env.OPENAI_API_KEY||!config.serviceToken)throw new Error('認証設定が必要です。');config.server=`http://127.0.0.1:${port}`;
 store=new Store(resolve(values.database));app=createApp({store,serviceToken:config.serviceToken,fixed:config.fixed});
 await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(port,'127.0.0.1',resolve);});
 if(values.register){const r=await fetch(`https://discord.com/api/v10/applications/${config.applicationId}/guilds/${config.guildId}/commands`,{method:'POST',headers:{authorization:`Bot ${config.token}`,'content-type':'application/json'},body:JSON.stringify(commandFor({fixed:true})),signal:AbortSignal.timeout(15000)});if(!r.ok)throw new Error('コマンド登録失敗');}
 process.once('exit',()=>{try{store.close();}catch{}});
 await runBot({config});console.log(`テスト用Botがオンラインです。会議開始は固定VCの /waigaya start だけです。HTTPは端末内のみ、ポート${port}。`);
} catch {console.error('テスト用Botを起動できません。固定ID・キー・接続認証・ポートを確認してください。');await app?.close().catch(()=>{});process.exitCode=1;}
