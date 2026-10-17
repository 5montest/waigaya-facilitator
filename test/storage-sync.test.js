import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';
import { Controller } from '../src/controller.js';
import { stateMessage,applyStatePatch,partFields } from '../src/state-sync.js';
const normalize=s=>{const n=structuredClone(s);for(const key of partFields)n[key]??=[];return n;};
test('旧SQLiteの全文スナップショットはトランザクションで移行し、原文・版・監査を復元する',()=>{
 const dir=mkdtempSync(join(tmpdir(),'wg-parts-')),path=join(dir,'state.sqlite');let store;
 try{const old=new DatabaseSync(path),state=new Controller().state;state.utterances=[{id:'original',revision:2,text:'訂正済み原文',final:true}];state.minutesHistory=[{version:1,approvedMarkdown:'固定した本文'}];old.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY,state TEXT NOT NULL);CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT,at INTEGER,kind TEXT,payload TEXT);');old.prepare('INSERT INTO sessions VALUES (?,?)').run(state.id,JSON.stringify(state));old.prepare('INSERT INTO events(session_id,at,kind,payload) VALUES (?,?,?,?)').run(state.id,1,'utterance',JSON.stringify({text:'訂正前の原文'}));old.close();
  store=new Store(path);assert.deepEqual(store.load(state.id),normalize(state));assert.equal(store.events(state.id)[0].payload.text,'訂正前の原文');assert.ok(store.db.prepare('SELECT state FROM sessions').get().state.length<JSON.stringify(state).length);store.close();store=new Store(path);assert.deepEqual(store.load(state.id),normalize(state));
 }finally{store?.close();rmSync(dir,{recursive:true,force:true});}
});
test('高頻度進捗は巨大な発言・議事録を再保存せず、終了保存と再起動で全記録を保つ',()=>{
 const store=new Store(':memory:'),state=new Controller().state;
 try{state.utterances=Array.from({length:600},(_,i)=>({id:'u'+i,revision:1,text:'模擬原文'.repeat(100),final:true}));state.minutesHistory=[{version:1,approvedMarkdown:'確認済み本文'.repeat(10000)}];state.aiTurns=[{heardMs:0}];store.save(state,'created');const bytes=store.metrics.serializedBytes,parts=store.metrics.changedParts;
  for(let i=0;i<100;i++){state.aiTurns[0].heardMs=i;store.save(state,'playback_progress',{}, {volatile:true});}
  assert.equal(store.metrics.changedParts-parts,99);assert.ok(store.metrics.serializedBytes-bytes<200000);assert.equal(store.load(state.id).utterances.length,600);assert.equal(store.load(state.id).minutesHistory[0].approvedMarkdown,state.minutesHistory[0].approvedMarkdown);
  state.utterances[100].text='訂正';state.utterances[100].revision++;store.save(state,'utterance',{utterance:state.utterances[100]});assert.equal(store.load(state.id).utterances[100].revision,2);
 }finally{store.close();}
});
test('状態差分は発言追記・訂正・配列削除・割り込みを復元し、欠けた差分は再同期を要求する',()=>{
 const state=new Controller().state,cache={};state.sequence=1;let received=structuredClone(stateMessage(state,cache).state);
 state.utterances.push({id:'u',text:'原文',revision:1});state.sequence++;let message=stateMessage(state,cache);assert.equal(message.type,'state_patch');received=applyStatePatch(received,structuredClone(message));assert.equal(received.utterances[0].text,'原文');
 state.utterances[0].text='訂正';state.outputEpoch++;state.sequence++;message=stateMessage(state,cache);received=applyStatePatch(received,structuredClone(message));assert.equal(received.outputEpoch,1);assert.equal(received.utterances[0].text,'訂正');
 assert.throws(()=>applyStatePatch({...received,sequence:1},{...message,sequence:4}),/resync/);assert.equal(applyStatePatch(received,message),received);
 state.utterances=[];state.sequence++;received=applyStatePatch(received,stateMessage(state,cache));assert.equal(received.utterances.length,0);
});
test('サーバー既定の保存先はDB再起動後も残り、他ギルド設定と混ざらない',()=>{
 const dir=mkdtempSync(join(tmpdir(),'wg-settings-')),path=join(dir,'state.sqlite');let store=new Store(path);
 try{store.saveGuildSettings({guildId:'g1',defaultMinutesChannelId:'forum',updatedBy:'admin',updatedAt:1});store.close();store=new Store(path);assert.equal(store.guildSettings('g1').defaultMinutesChannelId,'forum');assert.equal(store.guildSettings('g2').defaultMinutesChannelId,null);}
 finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
