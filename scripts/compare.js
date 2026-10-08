import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { randomUUID, randomInt } from 'node:crypto';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { analyze, catalog, keyFor } from '../src/models.js';
import { loadOpenAIKey } from '../src/credentials.js';

const { values } = parseArgs({ options: { run: { type: 'boolean', default: false }, providers: { type: 'string' }, cases: { type: 'string', default: 'eval/cases.json' } } });
loadOpenAIKey();
const dataset = JSON.parse(await readFile(values.cases, 'utf8'));
const providers = values.providers?.split(',') ?? ['openai'];
const models = catalog.filter(m => providers.includes(m.provider) && keyFor(m.provider));
console.log(`評価セット：${dataset.cases.length}会話。状態：${dataset.status}`);
console.log(`利用可能：${models.map(m => m.label).join('、') || 'なし（キー未設定）'}`);
if (!values.run) {
  console.log(`準備確認のみ。API呼出なし。--run で ${models.length * dataset.cases.length}回の比較を実行します。`);
  console.log('採用判断には、盲検での有用性・条件保持・根拠のない決定等の人による採点と、実会議での検証が必要です。');
  process.exit(0);
}
if (!models.length) { console.error('比較対象のキーが設定されていません。'); process.exit(1); }
const directory = resolve(`results/${new Date().toISOString().replace(/[:.]/g, '-')}`);
await mkdir(directory, { recursive: true, mode: 0o700 });
const rows = [], review = [];
for (const item of dataset.cases) {
  const state = { topic: item.topic, phase: item.phase, decisions: [], utterances: item.utterances.map((text, i) => ({ id: `${item.id}-${i + 1}`, revision: 1, speaker: null, final: true, text })) };
  for (const model of models) {
    const blindId = randomUUID();
    try {
      const { result, usage } = await analyze({ provider: model.provider, model: model.model, state });
      rows.push({ blindId, caseId: item.id, provider: model.provider, model: model.model, result, usage, checks: { schemaAndEvidence: true, actionInDraftReference: item.allowedActions.includes(result.action) } });
      review.push({ blindId, caseId: item.id, conversation: state, output: result, reviewPoints: item.humanChecks, rating: { usefulness1to5: null, preservesConditions: null, unsupportedDecision: null, inventedOwnerOrDeadline: null, comment: '' } });
      console.log(`${item.id} / ${model.label}: 応答 ${usage.elapsedMs}ms / 概算 ${usage.estimatedUsd === null ? '不明' : '$' + usage.estimatedUsd.toFixed(6)}`);
    } catch (e) {
      rows.push({ blindId, caseId: item.id, provider: model.provider, model: model.model, error: e.message, usage: e.usage ?? { estimatedUsd: null } });
      console.log(`${item.id} / ${model.label}: ${e.message}`);
    }
    // 途中で終了しても、既に取得した評価と使用量を残す。
    await writeFile(resolve(directory, 'results.json'), JSON.stringify({ datasetStatus: dataset.status, rows }, null, 2), { mode: 0o600 });
  }
}
for (let i = review.length - 1; i > 0; i--) { const j = randomInt(i + 1); [review[i], review[j]] = [review[j], review[i]]; }
await writeFile(resolve(directory, 'blind-review.json'), JSON.stringify(review, null, 2), { mode: 0o600 });
const lines = models.map(m => {
  const done = rows.filter(r => r.model === m.model && !r.error), known = done.filter(r => Number.isFinite(r.usage.estimatedUsd));
  const times = done.map(r => r.usage.elapsedMs).sort((a,b) => a-b);
  const median = times.length ? (times[Math.floor((times.length - 1) / 2)] + times[Math.floor(times.length / 2)]) / 2 : '—';
  return `| ${m.label} | ${done.length}/${dataset.cases.length} | ${median} | $${known.reduce((s,r) => s + r.usage.estimatedUsd, 0).toFixed(6)}（${known.length}件分） | 未採点 |`;
});
await writeFile(resolve(directory, 'comparison.md'), `# 初期比較の実測結果\n\n${dataset.status}\n\n構文・根拠参照の通過は内容の正しさの証明ではありません。失敗・中断・キャッシュの料金は不明の場合があります。概算は請求額ではありません。\n\n| モデル | 正常応答 | 応答時間中央値ms | 公開料金による概算 | 品質 |\n|---|---:|---:|---:|---|\n${lines.join('\n')}\n\nblind-review.jsonを人が採点してください。提供元との対応はresults.jsonにあるため、採点者へはblind-review.jsonだけ渡します。\n`, { mode: 0o600 });
console.log(`保存先：${directory}`);
