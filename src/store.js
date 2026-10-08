import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { partFields } from './state-sync.js';

export class Store {
  constructor(path = 'data/waigaya.sqlite') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, at INTEGER, kind TEXT, payload TEXT);
      CREATE TABLE IF NOT EXISTS session_parts (session_id TEXT, field TEXT, ordinal INTEGER, state TEXT NOT NULL, PRIMARY KEY(session_id,field,ordinal));
      CREATE TABLE IF NOT EXISTS guild_settings (guild_id TEXT PRIMARY KEY, state TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_session_seq ON events(session_id,seq);`);
    this.cache=new Map();this.metrics={serializedBytes:0,changedParts:0,saves:0};
    // Transactional, additive migration. Existing audit events and record IDs remain intact.
    for(const row of this.db.prepare('SELECT id,state FROM sessions').all())if(!JSON.parse(row.state)._partsFormat)this.save(JSON.parse(row.state),'storage_parts_migrated');
  }
  load(id) {
    const row=this.db.prepare('SELECT state FROM sessions WHERE id=?').get(id);if(!row)return null;
    const state=JSON.parse(row.state);if(!state._partsFormat)return state;
    delete state._partsFormat;
    for(const key of partFields)state[key]=[];
    for(const part of this.db.prepare('SELECT field,ordinal,state FROM session_parts WHERE session_id=? ORDER BY field,ordinal').all(id))state[part.field][part.ordinal]=JSON.parse(part.state);
    return state;
  }
  save(state,kind,payload={}, {volatile=false}={}) {
    const core={...state,_partsFormat:1},changes=[],removals=[];
    let cached=this.cache.get(state.id);
    if(!cached){cached=new Map();for(const part of this.db.prepare('SELECT field,ordinal,state FROM session_parts WHERE session_id=?').all(state.id))cached.set(part.field+':'+part.ordinal,part.state);}
    for(const field of partFields){delete core[field];const values=state[field]||[];
      if(volatile&&field!=='aiTurns')continue;
      const from=volatile&&field==='aiTurns'?Math.max(0,values.length-1):0;
      for(let i=from;i<values.length;i++){const value=JSON.stringify(values[i]),key=field+':'+i;if(cached.get(key)!==value)changes.push({field,i,value,key});}
      for(const key of cached.keys())if(key.startsWith(field+':')&&Number(key.slice(field.length+1))>=values.length)removals.push(key);
    }
    const coreJSON=JSON.stringify(core),eventJSON=JSON.stringify(payload);
    this.db.exec('BEGIN');
    try {
      this.db.prepare('INSERT INTO events(session_id,at,kind,payload) VALUES (?,?,?,?)').run(state.id,Date.now(),kind,eventJSON);
      this.db.prepare('INSERT INTO sessions(id,state) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state').run(state.id,coreJSON);
      const insert=this.db.prepare('INSERT INTO session_parts(session_id,field,ordinal,state) VALUES (?,?,?,?) ON CONFLICT(session_id,field,ordinal) DO UPDATE SET state=excluded.state');
      for(const p of changes)insert.run(state.id,p.field,p.i,p.value);
      for(const key of removals){const [field,index]=key.split(':');this.db.prepare('DELETE FROM session_parts WHERE session_id=? AND field=? AND ordinal=?').run(state.id,field,Number(index));}
      this.db.exec('COMMIT');
    }catch(e){this.db.exec('ROLLBACK');throw e;}
    for(const p of changes)cached.set(p.key,p.value);for(const key of removals)cached.delete(key);this.cache.set(state.id,cached);
    this.metrics.saves++;this.metrics.changedParts+=changes.length;this.metrics.serializedBytes+=Buffer.byteLength(coreJSON)+Buffer.byteLength(eventJSON)+changes.reduce((n,p)=>n+Buffer.byteLength(p.value),0);
  }
  list(){return this.db.prepare('SELECT id FROM sessions').all().map(row=>this.load(row.id));}
  guildSettings(id){const row=this.db.prepare('SELECT state FROM guild_settings WHERE guild_id=?').get(id);return row?JSON.parse(row.state):{guildId:id,defaultMinutesChannelId:null};}
  saveGuildSettings(state){this.db.prepare('INSERT INTO guild_settings(guild_id,state) VALUES (?,?) ON CONFLICT(guild_id) DO UPDATE SET state=excluded.state').run(state.guildId,JSON.stringify(state));return state;}
  events(id){return this.db.prepare('SELECT seq,at,kind,payload FROM events WHERE session_id=? ORDER BY seq').all(id).map(r=>({...r,payload:JSON.parse(r.payload)}));}
  close(){this.db.close();}
}

export function markdown(state) {
  const line = text => text.replace(/[\r\n]/g, ' ');
  const refs = evidence => evidence.map(r => `${r.utteranceId}@${r.revision}`).join(', ');
  const stale = d => !d.evidence.every(r => state.utterances.some(u => u.final && u.id === r.utteranceId && u.revision === r.revision));
  return `# ${line(state.topic)}\n\n人が確認した決定と、AIの提案を分けて記録しています。話者ラベルは個人名の確定ではありません。\n\n## 人が確認した決定\n\n${state.decisions.map(d => `- ${line(d.text)}（操作担当者による確認。根拠：${refs(d.evidence)}${stale(d) ? '。根拠発言が更新されています：要再確認' : ''}）`).join('\n') || '未確認'}\n\n## 文字起こし\n\n${state.utterances.map(u => `- ${line(u.speaker ?? '話者不明')} [${u.id}@${u.revision}; ${u.final ? '確定' : '暫定'}; 時刻:${u.startMs == null ? '不明' : u.startMs}〜${u.endMs == null ? '不明' : u.endMs}]：${line(u.text)}`).join('\n')}\n\n## AIの発言履歴\n\n${state.aiTurns.map(t => `- ${line(t.text)}（${t.startedAt ? '再生開始済み' : '再生開始前'}、${t.outcome}、端末報告の再生経過：約${t.heardMs}ms）`).join('\n') || 'なし'}\n\n※再生開始・経過時間の記録は、文全体が参加者に聞こえたことの証明ではありません。\n`;
}
