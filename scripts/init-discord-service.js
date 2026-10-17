import { randomBytes } from 'node:crypto';
import { mkdirSync, lstatSync, realpathSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { loadServiceToken } from '../src/credentials.js';
const root=realpathSync(process.cwd()),folder=resolve(root,'seacret'),target=resolve(folder,'discord-service-token.txt');
try {
  mkdirSync(folder,{recursive:true,mode:0o700});
  if(lstatSync(folder).isSymbolicLink()||realpathSync(folder)!==folder)throw new Error();
  const local=relative(root,target);if(local.startsWith('..')||isAbsolute(local))throw new Error();
  if(!existsSync(target))writeFileSync(target,randomBytes(32).toString('hex')+'\n',{flag:'wx',mode:0o600});
  loadServiceToken({workspace:root,env:{WAIGAYA_DISCORD_SERVICE_TOKEN_FILE:'seacret/discord-service-token.txt'}});chmodSync(target,0o600);
  console.log('Bot・会議サーバー間の認証ファイルを準備しました。秘密値は表示しません。');
  console.log('.env.local と .env.discord に WAIGAYA_DISCORD_SERVICE_TOKEN_FILE=seacret/discord-service-token.txt を設定してください。');
} catch {console.error('認証ファイルを安全に準備できません。保存先・権限を確認してください。既存の秘密値は上書きしません。');process.exitCode=1;}
