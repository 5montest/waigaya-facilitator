import {readFileSync} from 'node:fs';
import {Store} from '../src/store.js';
import {mergeMinutes} from '../src/minutes-merge.js';
const args=process.argv.slice(2),value=flag=>args[args.indexOf(flag)+1];
if(!args.includes('--offline-confirmed')||!args.includes('--database')||!args.includes('--manifest')){
 console.error('サービスを停止してDBをバックアップ後、--offline-confirmed --database <SQLite> --manifest <非公開JSON> を指定してください。');process.exit(1);
}
const store=new Store(value('--database'));
try{const s=mergeMinutes(store,JSON.parse(readFileSync(value('--manifest'),'utf8')));console.log(JSON.stringify({id:s.id,status:s.status,sourceCount:s.merge.sources.length,finalUtterances:s.minutesHistory[0].transcriptRefs.length,completionJob:s.completionJob.status}));}
catch(e){console.error(e.message);process.exitCode=1;}finally{store.close();}
