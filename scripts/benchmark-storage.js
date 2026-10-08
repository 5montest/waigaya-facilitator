import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';
import { Controller } from '../src/controller.js';
import { stateMessage,partFields } from '../src/state-sync.js';
import { mkdtempSync,rmSync,statSync,mkdirSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const dir=mkdtempSync(join(tmpdir(),'wg-storage-benchmark-'));
class LegacyStore {
 constructor(path){this.db=new DatabaseSync(path);this.db.exec('PRAGMA journal_mode=WAL;PRAGMA wal_autocheckpoint=0;CREATE TABLE sessions(id TEXT PRIMARY KEY,state TEXT);CREATE TABLE events(session_id TEXT,kind TEXT,payload TEXT);');this.metrics={serializedBytes:0,saves:0};}
 save(state,kind,payload){const text=JSON.stringify(state),event=JSON.stringify(payload);this.db.exec('BEGIN');this.db.prepare('INSERT INTO events VALUES(?,?,?)').run(state.id,kind,event);this.db.prepare('INSERT INTO sessions VALUES(?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state').run(state.id,text);this.db.exec('COMMIT');this.metrics.serializedBytes+=Buffer.byteLength(text)+Buffer.byteLength(event);this.metrics.saves++;}
 load(id){return JSON.parse(this.db.prepare('SELECT state FROM sessions WHERE id=?').get(id).state);}
 close(){this.db.close();}
}
try {
 const report={node:process.version,architecture:process.arch,conditions:{durationEquivalentSeconds:3600,utterances:600,progressEvents:300,utteranceTextCharacters:240,clients:1,apiCalls:0,progressThrottleApplied:false},measurements:[]};
 for(const [name,Factory] of [['before',LegacyStore],['after',Store]]){
  const path=join(dir,name+'.sqlite'),store=new Factory(path);store.db.exec('PRAGMA wal_autocheckpoint=0;');
  const state=new Controller({topic:'模擬1時間会議',sequence:0}).state,cache={};for(const key of partFields)state[key]??=[];
  let wireBytes=0;const started=performance.now();
  const save=(kind,payload)=>{state.sequence++;store.save(state,kind,payload,{volatile:kind==='playback_progress'});wireBytes+=Buffer.byteLength(JSON.stringify(name==='before'?{type:'state',state}:stateMessage(state,cache,{volatile:kind==='playback_progress'})));};
  save('created',{});
  for(let i=0;i<600;i++){const u={id:'u'+i,revision:1,text:'模擬会議の原文。'.repeat(30),speaker:'A',source:'sample',final:true,startMs:i*6000,endMs:i*6000+3000};state.utterances.push(u);save('utterance',{utterance:u});}
  state.aiTurns.push({text:'模擬整理',heardMs:0});save('speech_permitted',{});
  for(let i=1;i<=300;i++){state.aiTurns[0].heardMs=i*200;save('playback_progress',{heardMs:i*200});}
  state.utterances[50].text='訂正した原文';state.utterances[50].revision=2;save('utterance',{utterance:state.utterances[50]});
  const elapsedMs=Math.round(performance.now()-started);assert.deepEqual(store.load(state.id),state);
  report.measurements.push({name,elapsedMs,serializedWriteBytes:store.metrics.serializedBytes,wireBytes,saves:store.metrics.saves,sqliteBytes:statSync(path).size,walBytes:statSync(path+'-wal').size,restoredUtterances:store.load(state.id).utterances.length});store.close();
 }
 mkdirSync('results',{recursive:true,mode:0o700});writeFileSync('results/storage-benchmark.json',JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(report,null,2));
}finally{rmSync(dir,{recursive:true,force:true});}
