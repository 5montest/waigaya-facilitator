import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

export class Store {
  constructor(path = 'data/waigaya.sqlite') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, at INTEGER, kind TEXT, payload TEXT);`);
  }
  load(id) { const row = this.db.prepare('SELECT state FROM sessions WHERE id = ?').get(id); return row ? JSON.parse(row.state) : null; }
  save(state, kind, payload = {}) {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('INSERT INTO events(session_id,at,kind,payload) VALUES (?,?,?,?)').run(state.id, Date.now(), kind, JSON.stringify(payload));
      this.db.prepare('INSERT INTO sessions(id,state) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state').run(state.id, JSON.stringify(state));
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  events(id) { return this.db.prepare('SELECT seq,at,kind,payload FROM events WHERE session_id=? ORDER BY seq').all(id).map(r => ({ ...r, payload: JSON.parse(r.payload) })); }
  close() { this.db.close(); }
}

export function markdown(state) {
  const line = text => text.replace(/[\r\n]/g, ' ');
  const refs = evidence => evidence.map(r => `${r.utteranceId}@${r.revision}`).join(', ');
  const stale = d => !d.evidence.every(r => state.utterances.some(u => u.final && u.id === r.utteranceId && u.revision === r.revision));
  return `# ${line(state.topic)}\n\n人が確認した決定と、AIの提案を分けて記録しています。話者ラベルは個人名の確定ではありません。\n\n## 人が確認した決定\n\n${state.decisions.map(d => `- ${line(d.text)}（操作担当者による確認。根拠：${refs(d.evidence)}${stale(d) ? '。根拠発言が更新されています：要再確認' : ''}）`).join('\n') || '未確認'}\n\n## 文字起こし\n\n${state.utterances.map(u => `- ${line(u.speaker ?? '話者不明')} [${u.id}@${u.revision}; ${u.final ? '確定' : '暫定'}]：${line(u.text)}`).join('\n')}\n\n## AIの発言履歴\n\n${state.aiTurns.map(t => `- ${line(t.text)}（${t.startedAt ? '再生開始済み' : '再生開始前'}、${t.outcome}、端末報告の再生経過：約${t.heardMs}ms）`).join('\n') || 'なし'}\n\n※再生開始・経過時間の記録は、文全体が参加者に聞こえたことの証明ではありません。\n`;
}
