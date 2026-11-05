// 11/5 実会議などの保存済み文字起こしから、未公開の議事録プレビューを再生成する診断スクリプト。
// - 本番DBは読み取り専用で開く（書き込み・変更をしない）。
// - 生成物は指定ディレクトリへ保存するだけで、Discordへは投稿しない。
// - 実会議本文を含むため、出力先はgit管理外（work/ など）を指定する。
//
// 使い方:
//   node --env-file=.env.local scripts/generate-minutes-preview.js \
//     --db /immich/media/agent-work/20261009-waigaya-fixed-ops/data/live-validation.sqlite \
//     --session 84eb2cd9-1d27-43e5-80a9-76c35e9fc363 \
//     --out work/preview-20261106
// 追加オプション:
//   --max-utterances N  先頭N件だけを使って安価に試す（省略時は全会議）
//   --mock              LLMを呼ばず、入力から決定的なダミーv2文書を作る（パイプライン検証用）
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  db: { type: 'string' }, session: { type: 'string' }, out: { type: 'string' },
  'max-utterances': { type: 'string' }, mock: { type: 'boolean', default: false },
  'checkpoint-db': { type: 'string' }, fresh: { type: 'boolean', default: false },
} });
if (!values.db || !values.session) throw new Error('--db と --session を指定してください。');
const outDir = resolve(values.out || 'work/preview');

const PART_FIELDS = ['aiTurns', 'contextMemory', 'minutesHistory', 'publications', 'usage', 'utterances', 'voiceRequests'];
function loadState(path, sessionId) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare('SELECT state FROM sessions WHERE id=?').get(sessionId);
    if (!row) throw new Error('指定した会議IDが見つかりません。');
    const state = JSON.parse(row.state);
    if (state._partsFormat) {
      delete state._partsFormat;
      for (const field of PART_FIELDS) state[field] = [];
      const parts = db.prepare('SELECT field,ordinal,state FROM session_parts WHERE session_id=? ORDER BY field,ordinal').all(sessionId);
      for (const part of parts) {
        if (!Array.isArray(state[part.field])) state[part.field] = [];
        state[part.field][part.ordinal] = JSON.parse(part.state);
      }
    }
    return state;
  } finally { db.close(); }
}

const state = loadState(values.db, values.session);
const allUtterances = state.utterances.filter(u => u.final && u.source !== 'ai');
const max = Number(values['max-utterances']);
const utterances = Number.isInteger(max) && max > 0 ? allUtterances.slice(0, max) : allUtterances;
if (!utterances.length) throw new Error('確定済みの人間の発言がありません。');
const view = { ...state, utterances };

const minutesModule = await import('../src/minutes.js');
const { MinutesGenerator, checkMinutes } = minutesModule;
const minutesMarkdown = minutesModule.minutesMarkdown;
// 表示担当の実装中でも動くよう、正規化までは控えめなフォールバックを使う。
const minutesItems = minutesModule.minutesItems || (document => ['overview','ideas','comparisons','decisionCandidates','openIssues','actionItems'].flatMap(k => document[k] || []).concat((document.discussionTopics || []).flatMap(t => t.entries || []), document.keyFacts || []));
const canonicalMinutes = minutesModule.canonicalMinutes || (document => ({ overview: document.overview || [], topics: document.discussionTopics || [], decisionCandidates: document.decisionCandidates || [], openIssues: document.openIssues || [], keyFacts: document.keyFacts || [], actionItems: document.actionItems || [] }));
const log = message => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${message}`);
const started = Date.now();
const usage = [];
// 途中失敗しても高額な抽出をやり直さないよう、チェックポイントは作業用SQLiteへ保存する。
let checkpointStore = null;
let checkpoints = { load: () => null, save: () => {} };
if (values['checkpoint-db'] !== undefined) {
  const { Store } = await import('../src/store.js');
  const { rmSync } = await import('node:fs');
  const cpPath = resolve(values['checkpoint-db'] || resolve(outDir, 'checkpoints.sqlite'));
  mkdirSync(resolve(cpPath, '..'), { recursive: true, mode: 0o700 });
  if (values.fresh) rmSync(cpPath, { force: true });
  checkpointStore = new Store(cpPath);
  checkpoints = {
    load: key => checkpointStore.minutesCheckpoint('preview-' + state.id, key),
    save: (key, document) => checkpointStore.saveMinutesCheckpoint('preview-' + state.id, key, document),
  };
}
const mockGenerate = async ({ input }) => {
  const list = input.utterances || [];
  const u = list[0] || { id: 'u1', revision: 1 };
  const document = { schemaVersion: 2, overview: [{ text: '合成プレビュー（実LLMなし）。', evidence: [{ utteranceId: u.id, revision: u.revision }] }], discussionTopics: [], decisionCandidates: [], openIssues: [], keyFacts: [], actionItems: [] };
  return { result: document, usage: { provider: 'mock', model: 'mock', kind: 'minutes', inputTokens: null, outputTokens: null, estimatedUsd: null } };
};
const generator = new MinutesGenerator(values.mock ? { generate: mockGenerate } : {});
log(`議事録生成を開始（確定発言 ${utterances.length}件 / 全${allUtterances.length}件${values.mock ? ' / モック' : ''}）`);
const document = await generator.generateDraft(view, {
  checkpoints,
  onUsage: u => { usage.push(u); log(`usage ${u.provider}/${u.model} in=${u.inputTokens ?? '?'} out=${u.outputTokens ?? '?'} usd=${u.estimatedUsd ?? '?'}`); },
  onProgress: p => log(`progress ${p.phase} ${p.completed}/${p.total}${p.reused ? ` 再利用${p.reused}` : ''}`),
});
checkMinutes(document, view);
const canonical = canonicalMinutes(document);
const inputTokens = usage.reduce((n, u) => n + (u.inputTokens || 0), 0);
const outputTokens = usage.reduce((n, u) => n + (u.outputTokens || 0), 0);
const estimatedUsd = usage.reduce((n, u) => n + (u.estimatedUsd || 0), 0);
const version = { version: 1, kind: 'minutes', document, confirmedDecisions: structuredClone(state.decisions ?? []), metadata: { topic: state.topic, startedAt: state.startedAt, endedAt: state.endedAt, participantNames: [...new Set(allUtterances.map(u => u.speaker).filter(Boolean))] } };
const markdown = minutesMarkdown(state, version);
let short = null;
try {
  const { shortMinutes } = await import('../src/discord/minutes-publication.js');
  short = shortMinutes(state, version);
} catch { /* 表示担当の変更中はスキップ */ }
mkdirSync(outDir, { recursive: true, mode: 0o700 });
writeFileSync(resolve(outDir, 'document.json'), JSON.stringify(document, null, 2));
writeFileSync(resolve(outDir, 'minutes.md'), markdown);
if (short) writeFileSync(resolve(outDir, 'discord-short.md'), short);
const report = {
  sessionId: state.id, generatedAt: new Date().toISOString(), mock: Boolean(values.mock),
  inputUtterances: utterances.length, allFinalUtterances: allUtterances.length,
  elapsedMs: Date.now() - started, calls: usage.length, inputTokens, outputTokens, estimatedUsd,
  items: minutesItems(document).length,
  categories: [...new Set(canonical.topics.flatMap(t => t.entries.map(e => e.category)))],
  topics: canonical.topics.length, markdownChars: markdown.length, discordChars: short?.length ?? null,
};
writeFileSync(resolve(outDir, 'report.json'), JSON.stringify(report, null, 2));
log(`完了: ${JSON.stringify(report)}`);
log(`出力: ${outDir}（document.json / minutes.md${short ? ' / discord-short.md' : ''} / report.json）`);
