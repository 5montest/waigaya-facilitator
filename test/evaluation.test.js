// 議事録評価基盤（scripts/evaluate-minutes.js / eval/cases-v2.json / eval/legacy-v1.mjs）の単体テスト。
// 合成・匿名フィクスチャのみを使用し、実会議データ・実DB・外部APIに依存しない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  canonicalizeDocument, flattenItems, documentText, computeDocumentMetrics,
  computeMarkdownMetrics, computeShortMetrics, computeTranscriptMetrics,
  computeDiscourseMarkers, computeStageRetention, numbersIn, latinTokensIn,
  normalizeText, probeMatches, loadProbes, synthesizeCase, validateCasesFile,
  scoreCase, parseArgs, runCli, summarizeForStdout, resolveCanonicalizer,
  splitSourceChunks, aggregateUsage, DISCORD_MESSAGE_LIMIT,
} from '../scripts/evaluate-minutes.js';
import { legacyMinutesMarkdown, legacyShortMinutes } from '../eval/legacy-v1.mjs';

const ROOT = resolve(import.meta.dirname, '..');

const evidence = (id, revision = 1) => ({ utteranceId: id, revision });

const v1Document = () => ({
  overview: [{ text: '合成の概要A', evidence: [evidence('u1')] }],
  ideas: [{ text: '合成の案B', evidence: [evidence('u2')] }],
  comparisons: [{ text: '合成の比較C', evidence: [evidence('u3')] }],
  decisionCandidates: [{ text: '合成の候補D', evidence: [evidence('u4')] }],
  openIssues: [{ text: '合成の未決E', evidence: [evidence('u5')] }],
  actionItems: [{ text: '合成の行動F', evidence: [evidence('u6')], owner: 'Aさん', deadline: null }],
});

const v2Document = () => ({
  schemaVersion: 2,
  overview: [{ text: '合成の概要A', evidence: [evidence('u1')] }],
  discussionTopics: [{
    topicKey: '合成論点', title: '合成論点',
    entries: [
      { category: 'reason', text: '合成の理由G', evidence: [evidence('u2')] },
      { category: 'comparison', text: '合成の比較H', evidence: [evidence('u3')] },
    ],
  }],
  decisionCandidates: [{ text: '合成の候補I', evidence: [evidence('u4')], status: 'deferred', reason: '合成の保留理由' }],
  openIssues: [{ text: '合成の未決J', evidence: [evidence('u5')] }],
  keyFacts: [{ kind: 'number', text: '合成の数値1,234円', evidence: [evidence('u3')] }],
  actionItems: [{ text: '合成の行動K', evidence: [evidence('u6')], owner: null, deadline: null, assignment: 'none' }],
});

const utterances = [
  { id: 'u1', revision: 1, speaker: 'A', text: '合成の概要Aを話した。', final: true, startMs: 0, endMs: 1000 },
  { id: 'u2', revision: 1, speaker: 'B', text: '合成の理由Gと案Bについて話した。', final: true, startMs: 1000, endMs: 2000 },
  { id: 'u3', revision: 1, speaker: 'A', text: '合成の比較Hと1,234円の数値を話した。', final: true, startMs: 2000, endMs: 3000 },
  { id: 'u4', revision: 1, speaker: 'C', text: '合成の候補Iを話した。', final: true, startMs: 3000, endMs: 4000 },
  { id: 'u5', revision: 1, speaker: 'B', text: '合成の未決Eと未決Jを話した。', final: true, startMs: 4000, endMs: 5000 },
  { id: 'u6', revision: 1, speaker: 'A', text: 'Aさんが合成の行動Fと行動Kを担当する。', final: true, startMs: 5000, endMs: 6000 },
];

const syntheticState = () => ({
  id: 'synthetic-session',
  topic: '合成議題',
  status: 'completed',
  fixedOperation: true,
  endReason: 'manual',
  utterances,
  decisions: [],
  gaps: [],
});

const syntheticVersion = document => ({
  version: 1,
  kind: 'minutes',
  approvedAt: null,
  generatedAt: 1,
  document,
  confirmedDecisions: [],
  metadata: { topic: '合成議題', startedAt: 0, endedAt: 3600000, participantNames: ['Aさん', 'Bさん'] },
  transcriptRefs: utterances.map(utterance => evidence(utterance.id, utterance.revision)),
});

const casesPath = join(ROOT, 'eval/cases-v2.json');
const loadCases = () => JSON.parse(readFileSync(casesPath, 'utf8'));

// --- canonical 変換 -------------------------------------------------------

test('v1文書をcanonicalへ変換し、ideas/comparisonsをカテゴリ付きtopicsへ写す', () => {
  const canonical = canonicalizeDocument(v1Document());
  assert.equal(canonical.schemaVersion, 1);
  assert.equal(canonical.topics.length, 2);
  assert.deepEqual(canonical.topics.map(topic => topic.entries[0].category), ['idea', 'comparison']);
  assert.equal(canonical.actionItems[0].owner, 'Aさん');
  assert.equal(flattenItems(canonical).length, 6);
});

test('v2文書をcanonicalへ変換し、未知カテゴリはbackgroundへ落とす', () => {
  const input = v2Document();
  input.discussionTopics[0].entries.push({ category: 'unknown_category', text: '合成の未知', evidence: [evidence('u1')] });
  const canonical = canonicalizeDocument(input);
  assert.equal(canonical.schemaVersion, 2);
  const categories = flattenItems(canonical).map(item => item.category);
  assert.ok(categories.includes('reason'));
  assert.ok(categories.includes('comparison'));
  assert.equal(canonical.discussionTopics, undefined);
  assert.equal(categories.filter(category => category === 'background').length, 1);
  assert.equal(canonical.keyFacts[0].kind, 'number');
});

test('canonical変換は不正入力を拒否する', () => {
  assert.throws(() => canonicalizeDocument(null));
  assert.throws(() => canonicalizeDocument('not a document'));
});

// --- 正規化・トークン -----------------------------------------------------

test('数値トークンはカンマ・全半角・万/千を基本値へ正規化する', () => {
  const tokens = numbersIn('部品単価は約1,234円、売値は２万円、板厚1.5mm、上限30万円、900円。');
  assert.equal(tokens.get('1234円'), 1);
  assert.equal(tokens.get('20000円'), 1);
  assert.equal(tokens.get('1.5mm'), 1);
  assert.equal(tokens.get('300000円'), 1);
  assert.equal(tokens.get('900円'), 1);
});

test('英数字トークンと既知facts probeのグループAND一致', () => {
  const tokens = latinTokensIn('ABC-100とXYZ2、QRS-9を使う。AIとPCも候補。');
  assert.ok(tokens.has('abc-100'));
  assert.ok(tokens.has('xyz2'));
  assert.ok(tokens.has('qrs-9'));
  const probe = { id: 'cost', all: [['単価', '費用'], ['1,234円', '1234円']] };
  assert.equal(probeMatches(probe, '部品単価は約1,234円です。'), true);
  assert.equal(probeMatches(probe, '単価は未確認です。'), false);
});

test('loadProbesは不正なprobe定義を拒否する', () => {
  const dir = mkdtempSync(join(tmpdir(), 'waigaya-eval-'));
  try {
    const good = join(dir, 'good.json');
    writeFileSync(good, JSON.stringify({ probes: [{ id: 'p', label: 'P', all: [['x']] }] }));
    assert.equal(loadProbes(good).length, 1);
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, JSON.stringify({ probes: [{ id: 'p' }] }));
    assert.throws(() => loadProbes(bad));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- R0 統計 --------------------------------------------------------------

test('R0統計は話者を初出順にS1..へ匿名化し、暫定発言を除外する', () => {
  const metrics = computeTranscriptMetrics([
    ...utterances,
    { id: 'u7', revision: 1, speaker: 'C', text: '暫定発言', final: false, startMs: 6000, endMs: 7000 },
  ], [{ kind: 'stt', startedAt: 0, endedAt: 1000 }]);
  assert.equal(metrics.utterances.total, 7);
  assert.equal(metrics.utterances.final, 6);
  assert.equal(metrics.utterances.provisional, 1);
  assert.deepEqual(metrics.speakers.bySpeaker.map(speaker => speaker.speaker), ['S1', 'S2', 'S3']);
  assert.equal(metrics.speakers.bySpeaker[0].utterances, 3); // A: u1,u3,u6
  assert.equal(metrics.gaps.byKind.stt, 1);
  assert.match(metrics.gaps.note, /換算できない/);
});

test('発言の分割はJSON長24000文字を超えない', () => {
  const long = Array.from({ length: 600 }, (_, index) => ({ id: `u${index + 1}`, revision: 1, speaker: `S${index % 4}`, text: 'あ'.repeat(40), final: true, startMs: index, endMs: index + 1 }));
  const chunks = splitSourceChunks(long);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(JSON.stringify(chunk).length <= 24000 + 200, 'chunk near limit');
  assert.equal(chunks.reduce((total, chunk) => total + chunk.length, 0), 600);
});

// --- 文書メトリクス -------------------------------------------------------

test('文書メトリクスはevidenceの未知・改訂不一致・owner捏造を検出する', () => {
  const document = {
    schemaVersion: 2,
    overview: [{ text: '概要', evidence: [evidence('u1')] }],
    discussionTopics: [{ topicKey: 't', title: 'T', entries: [
      { category: 'reason', text: '同じ文', evidence: [evidence('missing')] },
      { category: 'reason', text: '同じ文', evidence: [evidence('u1', 99)] },
    ] }],
    decisionCandidates: [], openIssues: [], keyFacts: [],
    actionItems: [{ text: '行動', evidence: [evidence('u1')], owner: '存在しない担当', deadline: '来年', assignment: 'explicit' }],
  };
  const metrics = computeDocumentMetrics(canonicalizeDocument(document), { utterances });
  assert.equal(metrics.totalItems, 4);
  assert.equal(metrics.evidence.unknownRefs, 1);
  assert.equal(metrics.evidence.staleRefs, 1);
  assert.equal(metrics.evidence.coverageOfTranscript, 1 / 6);
  assert.equal(metrics.actionItems.owner.present, 1);
  assert.equal(metrics.actionItems.owner.ungrounded, 1);
  assert.equal(metrics.actionItems.deadline.ungrounded, 1);
  assert.equal(metrics.duplicates.extraItems, 1);
  assert.ok(metrics.evidence.charCoverageOfTranscript > 0 && metrics.evidence.charCoverageOfTranscript < 1);
});

// --- R2 / R3 --------------------------------------------------------------

test('Markdownメトリクスは項目の全文一致・欠落・節別文字数を数える', () => {
  const canonical = canonicalizeDocument(v1Document());
  const markdown = '# 議事録\n\n## 概要\n\n- 合成の概要A\n\n## 主な案\n\n- 合成の案B\n\n## 案の比較・議論\n\n- 合成の比較C\n';
  const metrics = computeMarkdownMetrics(markdown, canonical);
  assert.equal(metrics.itemRetention.rendered, 3);
  assert.equal(metrics.itemRetention.dropped, 3);
  assert.ok(metrics.chars > 0);
  const overview = metrics.sectionChars.find(section => section.title === '概要');
  assert.ok(overview && overview.chars > 0);
  assert.equal(metrics.evidenceIdsVisible, 0);
});

test('修正前shortMinutesの再現は2件/節・最大4節で、ideas/comparisonsを落とす', () => {
  const state = syntheticState();
  const version = syntheticVersion(v1Document());
  const short = legacyShortMinutes(state, version);
  assert.ok(short.length <= DISCORD_MESSAGE_LIMIT);
  assert.ok(short.includes('合成の概要A'));
  assert.ok(!short.includes('合成の案B'), 'ideas should be excluded');
  assert.ok(!short.includes('合成の比較C'), 'comparisons should be excluded');
  assert.ok(short.includes('詳細は添付のMarkdownをご覧ください。'));
  const metrics = computeShortMetrics(short, canonicalizeDocument(v1Document()));
  assert.equal(metrics.itemRetention.shown, 4); // overview/決定候補/未決/アクション 各1件
  assert.equal(metrics.itemRetention.byCategory.idea.dropped, 1);
  assert.equal(metrics.itemRetention.byCategory.comparison.dropped, 1);
  assert.ok(metrics.categoriesDropped.includes('idea'));
  assert.ok(metrics.categoriesDropped.includes('comparison'));
});

test('修正前minutesMarkdownはR1の全項目を本文へ描画する', () => {
  const state = syntheticState();
  const version = syntheticVersion(v1Document());
  const markdown = legacyMinutesMarkdown(state, version);
  const metrics = computeMarkdownMetrics(markdown, canonicalizeDocument(v1Document()));
  assert.equal(metrics.itemRetention.dropped, 0);
  assert.match(markdown, /## 記録の注記/);
});

// --- 合成ケース -----------------------------------------------------------

test('eval/cases-v2.json は全ケースが自己整合している（合成・匿名・期待facts在籍）', () => {
  const result = validateCasesFile(casesPath);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.cases.length, 6);
  assert.ok(result.cases.every(entry => entry.synthetic));
});

test('長会議ケースの生成は決定論的で600件になる', () => {
  const data = loadCases();
  const testCase = data.cases.find(entry => entry.id === 'long-meeting-600');
  const first = synthesizeCase(testCase);
  const second = synthesizeCase(testCase);
  assert.equal(first.length, 600);
  assert.deepEqual(first, second);
  assert.equal(new Set(first.map(utterance => utterance.id)).size, 600);
});

test('scoreCaseは期待facts・カテゴリ・evidenceを満たす文書を合格させる', () => {
  const data = loadCases();
  const testCase = data.cases.find(entry => entry.id === 'price-comparison');
  const document = {
    schemaVersion: 2,
    overview: [{ text: '板厚1.5mm案と2.0mm案を比較した。', evidence: [evidence('s1')] }],
    discussionTopics: [{ topicKey: '板厚', title: '板厚', entries: [
      { category: 'comparison', text: '1.5mm案は軽いが強度不足の懸念、2.0mm案は強いが部材原価が900円高い。', evidence: [evidence('s2')] },
      { category: 'comparison', text: '部材原価は約12,000円、想定売価は18,000円案。', evidence: [evidence('s3')] },
      { category: 'reason', text: '1.5mm案は軽いという理由がある。', evidence: [evidence('s2')] },
      { category: 'constraint', text: '7月の展示会に間に合わせるには今月中の判断が必要。', evidence: [evidence('s4')] },
      { category: 'open_issue', text: '落下試験の結果が出るまで板厚を決めない。', evidence: [evidence('s6')] },
    ] }],
    decisionCandidates: [], openIssues: [], keyFacts: [], actionItems: [],
  };
  const score = scoreCase(document, testCase);
  assert.equal(score.pass, true, JSON.stringify(score.checks.filter(check => !check.pass)));
  assert.equal(score.metrics.factRecall, 1);
});

test('scoreCaseはfact欠落・禁止主張・カテゴリ不足を不合格にする', () => {
  const data = loadCases();
  const testCase = data.cases.find(entry => entry.id === 'price-comparison');
  const document = {
    schemaVersion: 2,
    overview: [{ text: '全員一致で板厚を決定した。', evidence: [evidence('s1')] }],
    discussionTopics: [], decisionCandidates: [], openIssues: [], keyFacts: [], actionItems: [],
  };
  const score = scoreCase(document, testCase);
  assert.equal(score.pass, false);
  const failed = score.checks.filter(check => !check.pass).map(check => check.name);
  assert.ok(failed.includes('requiredFacts'));
  assert.ok(failed.includes('forbiddenClaims'));
  assert.ok(failed.includes('requiredCategories'));
  assert.ok(failed.includes('minItems'));
});

test('scoreCaseは明示担当と担当候補を区別する（Dは通知対象にしない）', () => {
  const data = loadCases();
  const testCase = data.cases.find(entry => entry.id === 'explicit-vs-proposed-owner');
  const good = {
    schemaVersion: 2,
    overview: [],
    discussionTopics: [{ topicKey: '担当', title: '担当', entries: [
      { category: 'disagreement', text: 'Dさんは担当候補として名前が挙がっただけ。', evidence: [evidence('s5')] },
    ] }],
    decisionCandidates: [], openIssues: [], keyFacts: [],
    actionItems: [{ text: '金型3社の見積もりを金曜までに集める。', evidence: [evidence('s1'), evidence('s2')], owner: 'B', deadline: '金曜', assignment: 'explicit' }],
  };
  const goodScore = scoreCase(good, testCase);
  assert.equal(goodScore.pass, true, JSON.stringify(goodScore.checks.filter(check => !check.pass)));
  const bad = JSON.parse(JSON.stringify(good));
  bad.actionItems[0].owner = 'D';
  bad.actionItems[0].assignment = 'proposed';
  const badScore = scoreCase(bad, testCase);
  assert.equal(badScore.pass, false);
});

// --- 段階保持・語彙マーカー ----------------------------------------------

test('段階別保持はR0→R1→R2→R3でfacts・数値・技術名の残存を測る', () => {
  const retention = computeStageRetention({
    transcripts: { r0: 'ABC-100と1,234円の話。', r1: '1,234円の話。', r2: '1,234円の話。', r3: '' },
    probes: [{ id: 'abc100', label: 'ABC-100', all: [['abc-100']] }],
  });
  assert.equal(retention.probes[0].r0, true);
  assert.equal(retention.probes[0].r1, false);
  assert.equal(retention.numeric.r0MoneyDistinct, 1);
  assert.equal(retention.numeric.stages.r1.moneyRecall, 1);
  assert.equal(retention.numeric.stages.r3.moneyRecall, 0);
  assert.equal(retention.technical.stages.r1.recall, 0);
});

test('discourseマーカーは理由・条件・懸念の語を段階別に数える', () => {
  const markers = computeDiscourseMarkers({ r0: '反対です。理由は条件が厳しいためです。', r1: '反対です。' });
  assert.ok(markers.r0.counts.reason >= 1);
  assert.ok(markers.r0.counts.concern >= 1);
  assert.ok(markers.r1.counts.reason < markers.r0.counts.reason);
  assert.ok(markers.r0.per1000Chars.reason >= 0);
});

// --- usage ----------------------------------------------------------------

test('usage集計はkind/provider/model別にトークンと既知概算・不明件数を分ける', () => {
  const result = aggregateUsage([
    { kind: 'minutes', provider: 'glm', model: 'glm-5.3-flash', outcome: 'received', inputTokens: 100, outputTokens: 20, estimatedUsd: null, elapsedMs: 1000 },
    { kind: 'minutes', provider: 'glm', model: 'glm-5.3-flash', outcome: 'received', inputTokens: 50, outputTokens: 10, estimatedUsd: 0.002, elapsedMs: 500 },
    { kind: 'stt', provider: 'openai', model: 'gpt-transcribe', outcome: 'closed', uploadedAudioSeconds: 12.5, estimatedUsd: 0.001 },
  ]);
  assert.equal(result.totals.calls, 3);
  assert.equal(result.totals.inputTokens, 150);
  assert.equal(result.totals.outputTokens, 30);
  assert.equal(result.totals.estimatedUsdKnown, 0.003);
  assert.equal(result.totals.estimatedUsdUnknown, 1);
  assert.equal(result.rows.find(row => row.kind === 'stt').uploadedAudioSeconds, 12.5);
});

// --- CLI ------------------------------------------------------------------

test('parseArgsは未知オプション・値欠落を拒否する', () => {
  assert.deepEqual(parseArgs(['--cases', 'a.json', '--quiet']), { cases: 'a.json', quiet: true });
  assert.throws(() => parseArgs(['--unknown']));
  assert.throws(() => parseArgs(['--cases']));
});

test('CLIのcasesモードは合格し、出力に発言本文を含めない', async () => {
  const lines = [];
  const report = await runCli(['--cases', casesPath], { stdout: line => lines.push(line) });
  assert.equal(report.cases.ok, true);
  assert.equal(report.deterministic, true);
  const summary = lines.join('\n');
  assert.ok(!summary.includes('冗談だけど'), 'synthetic utterance text must not leak into stdout');
  assert.ok(!/\b\d{17,22}\b/.test(summary), 'no snowflake-like ids in output');
  const again = await runCli(['--cases', casesPath, '--quiet']);
  assert.deepEqual(again.cases, report.cases);
});

test('runCliのdocumentモードは文書メトリクスとMarkdown/短縮版メトリクスを返す', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'waigaya-eval-'));
  try {
    const documentPath = join(dir, 'doc.json');
    const markdownPath = join(dir, 'doc.md');
    const shortPath = join(dir, 'short.md');
    writeFileSync(documentPath, JSON.stringify(v1Document()));
    writeFileSync(markdownPath, legacyMinutesMarkdown(syntheticState(), syntheticVersion(v1Document())));
    writeFileSync(shortPath, legacyShortMinutes(syntheticState(), syntheticVersion(v1Document())));
    const report = await runCli(['--document', documentPath, '--markdown', markdownPath, '--short', shortPath, '--quiet']);
    assert.equal(report.document.totalItems, 6);
    assert.equal(report.markdown.itemRetention.dropped, 0);
    assert.equal(report.short.itemRetention.shown, 4);
    assert.ok(report.short.categoriesDropped.includes('idea'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('canonicalizerは利用可能ならsrcのcanonicalMinutesを使う（未実装時はローカル実装へ）', async () => {
  const resolved = await resolveCanonicalizer();
  assert.equal(typeof resolved.canonicalize, 'function');
  if (resolved.source.startsWith('src/')) {
    const canonical = resolved.canonicalize(v2Document());
    assert.ok(Array.isArray(canonical.topics));
    assert.ok(Array.isArray(canonical.actionItems));
  } else {
    assert.match(resolved.source, /local fallback/);
  }
});

test('summarizeForStdoutは集計以外の本文フィールドを出さない', () => {
  const summary = summarizeForStdout({ tool: 'evaluate-minutes', toolVersion: 1, deterministic: true, inputs: {}, warnings: [], document: computeDocumentMetrics(canonicalizeDocument(v1Document()), { utterances }) });
  assert.equal(summary.document.totalItems, 6);
  assert.equal(JSON.stringify(summary).includes('合成の案B'), false);
});
