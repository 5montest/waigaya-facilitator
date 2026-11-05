#!/usr/bin/env node
// 議事録の決定論的評価スクリプト（外部APIなし）
//
// 目的:
//   - 11/5 実会議の R0（確定発言）→ R1（structured minutes document）→ R2（全文Markdown）
//     → R3（Discord短縮版）の各段階で、数値・技術名・既知facts・根拠参照・カテゴリが
//     どこまで残ったかを同じ基準で測る（ベースライン計測）。
//   - 候補の議事録文書（v1/v2）や Markdown / 短縮版を、同じ指標で採点する。
//   - eval/cases-v2.json の合成ケース定義を検証し、候補文書があれば expectations と照合する。
//
// 決定論性:
//   - 外部API・乱数・現在時刻を使わない。同じ入力からは同じJSONを返す。
//   - 生成時刻などのフィールドは出力に含めない。
//
// 使い方（例）:
//   npm run eval:minutes                                   # eval/cases-v2.json の自己検証
//   npm run eval:minutes -- --db <sqlite> --session <id> --renderer legacy-v1 --json out.json
//   npm run eval:minutes -- --document minutes.json --markdown minutes.md --short discord.md
//   npm run eval:minutes -- --cases eval/cases-v2.json --case price-comparison --document candidate.json
//
// 秘密情報の扱い:
//   - DBは node:sqlite の readOnly:true で開く（書き込みしない）。
//   - 出力JSONは集計値のみで、発言本文・実ユーザーID・実会議のMarkdownを含めない。
//   - 実会議本文を含む生データは work/ 配下だけに置く（このスクリプトは書き出さない）。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const TOOL_VERSION = 1;

export const CANONICAL_CATEGORIES = Object.freeze([
  'idea', 'reason', 'constraint', 'comparison', 'disagreement',
  'decision_candidate', 'open_issue', 'action', 'fact', 'verification', 'background',
]);

// v1の配列名 → canonical のカテゴリ。
export const V1_CATEGORY = Object.freeze({ ideas: 'idea', comparisons: 'comparison', decisionCandidates: 'decision_candidate', openIssues: 'open_issue', actionItems: 'action' });

export const LEGACY_SHORT_BUDGET = 1450;
export const DISCORD_MESSAGE_LIMIT = 2000;
export const SHORT_ITEM_CHARS = 130;

const V1_SECTIONS = ['overview', 'ideas', 'comparisons', 'decisionCandidates', 'openIssues', 'actionItems'];
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const hasSnowflake = value => /\b\d{17,22}\b/.test(String(value ?? ''));

// ---------------------------------------------------------------------------
// テキスト正規化・トークン抽出
// ---------------------------------------------------------------------------

// 比較用の正規化。表記の言い換え（カンマ・全半角・空白・大文字小文字）だけを吸収する。
export function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[,\uFF0C]/g, '')
    .replace(/\s+/g, '');
}

export function textOf(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textOf).join('\n');
  if (value && typeof value === 'object') return Object.values(value).map(textOf).join('\n');
  return value == null ? '' : String(value);
}

// 数値トークン。単位を基本値へ揃える（30万円 → 300000円, 3千円 → 3000円）。
export function numbersIn(text) {
  const source = String(text ?? '').normalize('NFKC').replace(/[,\uFF0C]/g, '').replace(/\s+/g, '');
  const counts = new Map();
  const re = /(\d+(?:\.\d+)?)(万|千|百)?(円|ドル|%|分|秒|時間|日|か月|ヶ月|月|年|個|人|名|回|台|mm|cm|km|m|g|kg|V|mA|A|W|℃|度|倍|割|件|枚|本|冊|階|時)/g;
  for (const match of source.matchAll(re)) {
    const value = Number(match[1]) * ({ 万: 1e4, 千: 1e3, 百: 1e2 }[match[2]] ?? 1);
    const token = `${Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)))}${match[3]}`;
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

// 技術名・固有名詞の候補（英数字トークン）。意味判定はしない。
export function latinTokensIn(text) {
  const counts = new Map();
  for (const match of String(text ?? '').normalize('NFKC').matchAll(/[A-Za-z][A-Za-z0-9.+#_-]*[A-Za-z0-9+#]/g)) {
    const token = match[0].toLowerCase();
    if (token.length < 2) continue;
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

// 既知factsの判定。probe.all は「グループの配列」で、全グループに1つ以上の別名が
// 含まれれば一致とみなす（例: 金額系 + 数値系）。
export function probeMatches(probe, text) {
  const haystack = normalizeText(text);
  return probe.all.every(group => group.some(alias => haystack.includes(normalizeText(alias))));
}

export function loadProbes(filePath) {
  const data = JSON.parse(readFileSync(filePath, 'utf8'));
  const probes = data.probes ?? data;
  if (!Array.isArray(probes)) throw new Error('probes file is not an array');
  return probes.map(probe => {
    if (!probe.id || !Array.isArray(probe.all) || !probe.all.length) throw new Error(`invalid probe: ${probe.id ?? '(no id)'}`);
    return { id: probe.id, label: probe.label ?? probe.id, all: probe.all, note: probe.note ?? null };
  });
}

// ---------------------------------------------------------------------------
// canonical 形式への変換（v1/v2両対応のローカル実装）
// ---------------------------------------------------------------------------

const asText = entry => String(entry?.text ?? '');
const asEvidence = entry => (Array.isArray(entry?.evidence) ? entry.evidence : [])
  .filter(ref => ref && typeof ref.utteranceId === 'string' && Number.isInteger(ref.revision))
  .map(ref => ({ utteranceId: ref.utteranceId, revision: ref.revision }));

// src/minutes.js の canonicalMinutes() が未実装の間も評価を進められるローカル実装。
// 統合後は canonicalMinutes() が優先される（resolveCanonicalizer を参照）。
export function canonicalizeDocument(document) {
  if (!document || typeof document !== 'object') throw new Error('minutes document is not an object');
  const isV2 = document.schemaVersion === 2 || Array.isArray(document.discussionTopics);
  if (!isV2) {
    return {
      schemaVersion: 1,
      overview: (document.overview ?? []).map(entry => ({ text: asText(entry), evidence: asEvidence(entry) })),
      topics: [
        ...(document.ideas?.length ? [{ topicKey: 'v1:ideas', title: '主な案', entries: document.ideas.map(entry => ({ category: 'idea', text: asText(entry), evidence: asEvidence(entry) })) }] : []),
        ...(document.comparisons?.length ? [{ topicKey: 'v1:comparisons', title: '案の比較・議論', entries: document.comparisons.map(entry => ({ category: 'comparison', text: asText(entry), evidence: asEvidence(entry) })) }] : []),
      ],
      decisionCandidates: (document.decisionCandidates ?? []).map(entry => ({ text: asText(entry), evidence: asEvidence(entry), status: null, reason: null })),
      openIssues: (document.openIssues ?? []).map(entry => ({ text: asText(entry), evidence: asEvidence(entry) })),
      keyFacts: [],
      actionItems: (document.actionItems ?? []).map(entry => ({ text: asText(entry), evidence: asEvidence(entry), owner: entry.owner ?? null, deadline: entry.deadline ?? null, assignment: null })),
    };
  }
  return {
    schemaVersion: 2,
    overview: (document.overview ?? []).map(entry => ({ text: asText(entry), evidence: asEvidence(entry) })),
    topics: (document.discussionTopics ?? []).map(topic => ({
      topicKey: String(topic?.topicKey ?? ''),
      title: String(topic?.title ?? topic?.topicKey ?? ''),
      entries: (topic?.entries ?? []).map(entry => ({ category: CANONICAL_CATEGORIES.includes(entry?.category) ? entry.category : 'background', text: asText(entry), evidence: asEvidence(entry) })),
    })),
    decisionCandidates: (document.decisionCandidates ?? []).map(entry => ({ text: asText(entry), evidence: asEvidence(entry), status: entry?.status ?? null, reason: entry?.reason ?? null })),
    openIssues: (document.openIssues ?? []).map(entry => ({ text: asText(entry), evidence: asEvidence(entry) })),
    keyFacts: (document.keyFacts ?? []).map(entry => ({ kind: entry?.kind ?? null, text: asText(entry), evidence: asEvidence(entry) })),
    actionItems: (document.actionItems ?? []).map(entry => ({ text: asText(entry), evidence: asEvidence(entry), owner: entry?.owner ?? null, deadline: entry?.deadline ?? null, assignment: entry?.assignment ?? null })),
  };
}

export async function resolveCanonicalizer() {
  try {
    const module = await import(pathToFileURL(resolve(ROOT, 'src/minutes.js')).href);
    if (typeof module.canonicalMinutes === 'function') {
      return { source: 'src/minutes.js#canonicalMinutes', canonicalize: document => module.canonicalMinutes(document) };
    }
  } catch { /* src側が未実装・読み込み不可ならローカル実装へ */ }
  return { source: 'scripts/evaluate-minutes.js#canonicalizeDocument (local fallback)', canonicalize: canonicalizeDocument };
}

// canonical の全項目を平坦化する。section は overview/topic/decisionCandidates/...
export function flattenItems(canonical) {
  const items = [];
  for (const entry of canonical.overview ?? []) items.push({ section: 'overview', category: 'overview', text: entry.text, evidence: entry.evidence });
  for (const topic of canonical.topics ?? []) for (const entry of topic.entries ?? []) items.push({ section: `topic:${topic.topicKey || topic.title}`, category: entry.category, text: entry.text, evidence: entry.evidence, topicKey: topic.topicKey, topicTitle: topic.title });
  for (const entry of canonical.decisionCandidates ?? []) items.push({ section: 'decisionCandidates', category: 'decision_candidate', text: entry.text, evidence: entry.evidence, status: entry.status, reason: entry.reason });
  for (const entry of canonical.openIssues ?? []) items.push({ section: 'openIssues', category: 'open_issue', text: entry.text, evidence: entry.evidence });
  for (const entry of canonical.keyFacts ?? []) items.push({ section: 'keyFacts', category: 'fact', text: entry.text, evidence: entry.evidence, kind: entry.kind });
  for (const entry of canonical.actionItems ?? []) items.push({ section: 'actionItems', category: 'action', text: entry.text, evidence: entry.evidence, owner: entry.owner ?? null, deadline: entry.deadline ?? null, assignment: entry.assignment ?? null });
  return items;
}

export function documentText(canonical) {
  return flattenItems(canonical).map(item => item.text).join('\n');
}

// 候補文書の基本メトリクス（集計値のみ。本文は返さない）。
export function computeDocumentMetrics(canonical, { utterances = null } = {}) {
  const items = flattenItems(canonical);
  const sectionCounts = { overview: (canonical.overview ?? []).length, topics: (canonical.topics ?? []).length, topicEntries: (canonical.topics ?? []).reduce((n, topic) => n + (topic.entries?.length ?? 0), 0), decisionCandidates: (canonical.decisionCandidates ?? []).length, openIssues: (canonical.openIssues ?? []).length, keyFacts: (canonical.keyFacts ?? []).length, actionItems: (canonical.actionItems ?? []).length };
  const categoryCounts = {};
  const categoryChars = {};
  for (const category of CANONICAL_CATEGORIES) { categoryCounts[category] = 0; categoryChars[category] = 0; }
  for (const item of items) { categoryCounts[item.category] = (categoryCounts[item.category] ?? 0) + 1; categoryChars[item.category] = (categoryChars[item.category] ?? 0) + item.text.length; }
  const allText = items.map(item => item.text).join('\n');
  const lengths = items.map(item => item.text.length);
  const refs = items.flatMap(item => item.evidence ?? []);
  const uniqueUtteranceIds = new Set(refs.map(ref => ref.utteranceId));

  let evidenceReport = { items: items.length, itemsWithEvidence: items.filter(item => (item.evidence ?? []).length > 0).length, itemsMissingEvidence: items.filter(item => !(item.evidence ?? []).length).length, refs: refs.length, uniqueUtterances: uniqueUtteranceIds.size };
  if (utterances) {
    const byId = new Map(utterances.map(utterance => [utterance.id, utterance]));
    let unknownRefs = 0, staleRefs = 0, nonFinalRefs = 0;
    for (const ref of refs) {
      const found = byId.get(ref.utteranceId);
      if (!found) { unknownRefs++; continue; }
      if (found.revision !== ref.revision) staleRefs++;
      if (found.final === false) nonFinalRefs++;
    }
    const referenced = utterances.filter(utterance => uniqueUtteranceIds.has(utterance.id));
    const totalChars = utterances.reduce((n, utterance) => n + String(utterance.text ?? '').length, 0);
    const referencedChars = referenced.reduce((n, utterance) => n + String(utterance.text ?? '').length, 0);
    evidenceReport = { ...evidenceReport, unknownRefs, staleRefs, nonFinalRefs, coverageOfTranscript: utterances.length ? referenced.length / utterances.length : null, charCoverageOfTranscript: totalChars ? referencedChars / totalChars : null };
  }

  const utteranceTextById = utterances ? new Map(utterances.map(utterance => [utterance.id, String(utterance.text ?? '')])) : null;
  const ownerItems = items.filter(item => item.category === 'action');
  const owners = ownerItems.filter(item => item.owner).map(item => item.owner);
  const deadlines = ownerItems.filter(item => item.deadline).map(item => item.deadline);
  const grounded = (value, evidence) => {
    if (!utteranceTextById) return null;
    const source = (evidence ?? []).map(ref => utteranceTextById.get(ref.utteranceId) ?? '').join('\n');
    return normalizeText(source).includes(normalizeText(value));
  };
  const ownerReport = { present: owners.length, ungrounded: utteranceTextById ? ownerItems.filter(item => item.owner && grounded(item.owner, item.evidence) === false).length : null, missing: ownerItems.filter(item => !item.owner).length, assignments: {} };
  for (const item of ownerItems) { const key = item.assignment ?? '(none)'; ownerReport.assignments[key] = (ownerReport.assignments[key] ?? 0) + 1; }
  const deadlineReport = { present: deadlines.length, ungrounded: utteranceTextById ? ownerItems.filter(item => item.deadline && grounded(item.deadline, item.evidence) === false).length : null, missing: ownerItems.filter(item => !item.deadline).length };
  const statusCounts = {};
  for (const candidate of canonical.decisionCandidates ?? []) { const key = candidate.status ?? '(none)'; statusCounts[key] = (statusCounts[key] ?? 0) + 1; }

  const seen = new Map();
  for (const item of items) { const key = normalizeText(item.text); if (!key) continue; seen.set(key, (seen.get(key) ?? 0) + 1); }
  const duplicateGroups = [...seen.values()].filter(count => count > 1).length;
  const duplicateItems = [...seen.values()].filter(count => count > 1).reduce((n, count) => n + count - 1, 0);

  return {
    schemaVersion: canonical.schemaVersion ?? null,
    sectionCounts,
    totalItems: items.length,
    totalChars: allText.length,
    categoryCounts,
    categoryChars,
    lengthStats: { min: lengths.length ? Math.min(...lengths) : 0, max: lengths.length ? Math.max(...lengths) : 0, average: lengths.length ? Math.round(allText.length / lengths.length) : 0, over400: lengths.filter(n => n > 400).length, empty: lengths.filter(n => !n).length },
    evidence: evidenceReport,
    actionItems: { items: ownerItems.length, owner: ownerReport, deadline: deadlineReport },
    decisionCandidates: { items: (canonical.decisionCandidates ?? []).length, statusCounts },
    duplicates: { groups: duplicateGroups, extraItems: duplicateItems, rate: items.length ? duplicateItems / items.length : 0 },
  };
}

// ---------------------------------------------------------------------------
// R2/R3 の描画ロス計測（renderer非依存の部分一致判定）
// ---------------------------------------------------------------------------

const KNOWN_SECTION_TITLES = new Set(['概要', '主な案', '案の比較・議論', '決定事項（人が確認済み）', '決定候補（確認待ち）', '未決事項', '次のアクション（候補）', '記録の注記', '会議の本筋']);

export function splitMarkdownSections(markdown) {
  const lines = String(markdown ?? '').split('\n');
  const sections = [];
  let current = { title: '(preamble)', body: [] };
  for (const line of lines) {
    const match = line.match(/^## (.+)$/);
    if (match) { sections.push(current); current = { title: match[1].trim(), body: [] }; continue; }
    current.body.push(line);
  }
  sections.push(current);
  return sections.map((section, index) => ({ index, title: section.title === '(preamble)' ? '(preamble:metadata)' : KNOWN_SECTION_TITLES.has(section.title) ? section.title : `section${index + 1}`, chars: section.body.join('\n').replace(/\n/g, '').length }));
}

const renderClassify = (text, renderedNormalized, { itemChars = SHORT_ITEM_CHARS } = {}) => {
  const normalized = normalizeText(text);
  if (!normalized) return 'empty';
  if (renderedNormalized.includes(normalized)) return 'full';
  const preview = normalizeText(Array.from(String(text)).slice(0, Math.min(itemChars, 20)).join(''));
  if (preview && renderedNormalized.includes(preview)) return 'partial';
  return 'dropped';
};

export function computeMarkdownMetrics(markdown, canonical) {
  const text = String(markdown ?? '');
  const normalized = normalizeText(text);
  const items = flattenItems(canonical);
  const byCategory = {};
  let rendered = 0, partial = 0, dropped = 0;
  for (const item of items) {
    byCategory[item.category] ??= { total: 0, full: 0, partial: 0, dropped: 0 };
    byCategory[item.category].total++;
    const state = renderClassify(item.text, normalized);
    if (state === 'full') { rendered++; byCategory[item.category].full++; }
    else if (state === 'partial') { partial++; byCategory[item.category].partial++; }
    else { dropped++; byCategory[item.category].dropped++; }
  }
  const uuids = text.match(UUID_RE) ?? [];
  return {
    chars: text.length,
    lines: text.split('\n').length,
    headings: (text.match(/^#{1,3} .+$/gm) ?? []).length,
    sectionChars: splitMarkdownSections(text),
    itemRetention: { total: items.length, rendered, partial, dropped, rate: items.length ? rendered / items.length : null, byCategory },
    staleMarkers: (text.match(/（要再確認）/g) ?? []).length,
    evidenceIdsVisible: uuids.length + (text.match(/[0-9a-f]{8}@\d+/gi) ?? []).length,
  };
}

export function computeShortMetrics(shortText, canonical, { budget = LEGACY_SHORT_BUDGET, discordLimit = DISCORD_MESSAGE_LIMIT, itemChars = SHORT_ITEM_CHARS } = {}) {
  const text = String(shortText ?? '');
  const normalized = normalizeText(text);
  const items = flattenItems(canonical);
  const byCategory = {};
  let shown = 0, partial = 0, dropped = 0;
  for (const item of items) {
    byCategory[item.category] ??= { total: 0, shown: 0, partial: 0, dropped: 0 };
    byCategory[item.category].total++;
    const state = renderClassify(item.text, normalized, { itemChars });
    if (state === 'full') { shown++; byCategory[item.category].shown++; }
    else if (state === 'partial') { partial++; byCategory[item.category].partial++; }
    else { dropped++; byCategory[item.category].dropped++; }
  }
  const categoriesDropped = Object.entries(byCategory).filter(([, value]) => value.shown === 0 && value.partial === 0).map(([category]) => category);
  return {
    chars: text.length,
    lines: text.split('\n').length,
    budgetChars: budget,
    discordLimit,
    withinBudget: budget == null ? null : text.length <= budget,
    withinDiscordLimit: text.length <= discordLimit,
    itemRetention: { total: items.length, shown, partial, dropped, rate: items.length ? shown / items.length : null, byCategory },
    categoriesDropped,
    budgetUsage: budget == null ? null : text.length / budget,
  };
}

// ---------------------------------------------------------------------------
// R0（確定発言）の基本統計
// ---------------------------------------------------------------------------

export function computeTranscriptMetrics(utterances, gaps = []) {
  const final = utterances.filter(utterance => utterance.final !== false);
  const speakers = new Map();
  for (const utterance of final) {
    const key = utterance.speaker ?? '(unknown)';
    const entry = speakers.get(key) ?? { utterances: 0, chars: 0, speechMs: 0, firstAt: Number.isFinite(utterance.startMs) ? utterance.startMs : null };
    entry.utterances++;
    entry.chars += String(utterance.text ?? '').length;
    if (Number.isFinite(utterance.startMs) && Number.isFinite(utterance.endMs)) entry.speechMs += Math.max(0, utterance.endMs - utterance.startMs);
    speakers.set(key, entry);
  }
  const order = [...speakers.entries()].sort((a, b) => (a[1].firstAt ?? 0) - (b[1].firstAt ?? 0));
  const speakerStats = order.map(([speaker, entry], index) => ({
    speaker: `S${index + 1}`,
    utterances: entry.utterances,
    chars: entry.chars,
    averageChars: entry.utterances ? Math.round((entry.chars / entry.utterances) * 10) / 10 : 0,
    speechSeconds: Math.round((entry.speechMs / 1000) * 10) / 10,
    shareOfUtterances: final.length ? Math.round((entry.utterances / final.length) * 1000) / 1000 : null,
  }));
  const texts = final.map(utterance => String(utterance.text ?? ''));
  const lengths = texts.map(text => text.length);
  const gapKinds = {};
  let gapSpanMs = 0;
  for (const gap of gaps) { gapKinds[gap.kind ?? '(none)'] = (gapKinds[gap.kind ?? '(none)'] ?? 0) + 1; if (Number.isFinite(gap.startedAt) && Number.isFinite(gap.endedAt)) gapSpanMs += Math.max(0, gap.endedAt - gap.startedAt); }
  return {
    utterances: { total: utterances.length, final: final.length, provisional: utterances.filter(utterance => utterance.final === false).length, aiSource: utterances.filter(utterance => utterance.source === 'ai').length, revisionsOver1: utterances.filter(utterance => (utterance.revision ?? 1) > 1).length },
    chars: { total: lengths.reduce((n, value) => n + value, 0), min: lengths.length ? Math.min(...lengths) : 0, max: lengths.length ? Math.max(...lengths) : 0, average: lengths.length ? Math.round((lengths.reduce((n, value) => n + value, 0) / lengths.length) * 10) / 10 : 0 },
    fragments: { atMost3Chars: lengths.filter(n => n <= 3).length, atMost5Chars: lengths.filter(n => n <= 5).length, rateAtMost5Chars: final.length ? lengths.filter(n => n <= 5).length / final.length : null },
    speakers: { count: speakerStats.length, bySpeaker: speakerStats },
    gaps: { total: gaps.length, byKind: gapKinds, sumSpanMs: gapSpanMs, note: 'gapsは発生区間の記録であり、重複を含むため合計時間や失われた発言数には換算できない' },
  };
}

// ---------------------------------------------------------------------------
// 合成ケース（eval/cases-v2.json）
// ---------------------------------------------------------------------------

export function synthesizeCase(testCase) {
  if (Array.isArray(testCase.utterances)) {
    return testCase.utterances.map((utterance, index) => ({ id: utterance.id ?? `s${index + 1}`, revision: utterance.revision ?? 1, speaker: utterance.speaker ?? null, text: String(utterance.text ?? ''), final: true }));
  }
  const generate = testCase.generate;
  if (!generate || generate.kind !== 'cycle') throw new Error(`case ${testCase.id}: utterances も generate(kind=cycle) もありません`);
  if (!Array.isArray(generate.lines) || !generate.lines.length) throw new Error(`case ${testCase.id}: generate.lines が空です`);
  const speakers = generate.speakers?.length ? generate.speakers : ['A'];
  const utterances = [];
  for (let index = 0; index < generate.count; index++) {
    utterances.push({ id: `g${index + 1}`, revision: 1, speaker: speakers[index % speakers.length], text: String(generate.lines[index % generate.lines.length]), final: true });
  }
  return utterances;
}

export function validateCasesFile(casesPath) {
  const data = JSON.parse(readFileSync(casesPath, 'utf8'));
  const errors = [];
  const warnings = [];
  if (data.synthetic !== true) errors.push('cases file must be marked synthetic:true');
  if (data.schemaVersion !== 2) errors.push('cases file schemaVersion must be 2');
  if (!Array.isArray(data.cases) || !data.cases.length) errors.push('cases must be a non-empty array');
  const cases = [];
  const seenIds = new Set();
  for (const [index, testCase] of (data.cases ?? []).entries()) {
    const caseErrors = [];
    if (!testCase.id) caseErrors.push('missing id');
    else if (seenIds.has(testCase.id)) caseErrors.push('duplicate id');
    seenIds.add(testCase.id);
    if (testCase.synthetic !== true) caseErrors.push('case must be synthetic:true');
    let utterances = [];
    try { utterances = synthesizeCase(testCase); } catch (error) { caseErrors.push(error.message); }
    if (utterances.length) {
      const ids = new Set();
      for (const utterance of utterances) { if (ids.has(utterance.id)) caseErrors.push(`duplicate utterance id: ${utterance.id}`); ids.add(utterance.id); }
      if (utterances.some(utterance => hasSnowflake(utterance.text))) caseErrors.push('utterance text contains a snowflake-like id');
    }
    const transcript = normalizeText(utterances.map(utterance => utterance.text).join('\n'));
    const expectations = testCase.expectations ?? {};
    for (const fact of expectations.requiredFacts ?? []) if (!transcript.includes(normalizeText(fact))) caseErrors.push(`requiredFact not present in synthetic transcript: ${fact}`);
    for (const claim of expectations.forbiddenClaims ?? []) {
      const present = transcript.includes(normalizeText(claim));
      if (expectations.transcriptContainsForbiddenClaims ? !present : present) caseErrors.push(`forbiddenClaim ${expectations.transcriptContainsForbiddenClaims ? 'missing from' : 'present in'} synthetic transcript: ${claim}`);
    }
    for (const [category, minimum] of Object.entries(expectations.requiredCategories ?? {})) {
      if (!CANONICAL_CATEGORIES.includes(category)) caseErrors.push(`unknown category: ${category}`);
      if (!Number.isInteger(minimum) || minimum < 0) caseErrors.push(`requiredCategories.${category} must be a non-negative integer`);
    }
    if (expectations.minItems != null && (!Number.isInteger(expectations.minItems) || expectations.minItems < 0)) caseErrors.push('minItems must be a non-negative integer');
    for (const assignment of expectations.ownerAssignments ?? []) if (!assignment.contains || !assignment.owner) caseErrors.push('ownerAssignments entries need contains/owner');
    const serialized = JSON.stringify(testCase);
    if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(serialized)) caseErrors.push('case contains a UUID-like id');
    if (hasSnowflake(serialized)) caseErrors.push('case contains a snowflake-like id');
    cases.push({ id: testCase.id ?? `(index ${index})`, synthetic: testCase.synthetic === true, utterances: utterances.length, expectations: { requiredFacts: (expectations.requiredFacts ?? []).length, forbiddenClaims: (expectations.forbiddenClaims ?? []).length, requiredCategories: Object.keys(expectations.requiredCategories ?? {}).length, ownerAssignments: (expectations.ownerAssignments ?? []).length }, errors: caseErrors });
    errors.push(...caseErrors.map(error => `${testCase.id ?? index}: ${error}`));
  }
  if (!cases.length) warnings.push('no cases');
  return { path: casesPath, ok: errors.length === 0, cases, errors, warnings };
}

export function scoreCase(document, testCase, { canonicalizer = canonicalizeDocument } = {}) {
  const utterances = synthesizeCase(testCase);
  const canonical = canonicalizer(document);
  const items = flattenItems(canonical);
  const text = normalizeText(documentText(canonical));
  const utterancesById = new Map(utterances.map(utterance => [utterance.id, utterance]));
  const expectations = testCase.expectations ?? {};
  const checks = [];

  const factResults = (expectations.requiredFacts ?? []).map(fact => ({ fact, present: text.includes(normalizeText(fact)) }));
  const matchedFacts = factResults.filter(result => result.present).length;
  const factRecall = factResults.length ? matchedFacts / factResults.length : 1;
  checks.push({ name: 'requiredFacts', pass: factRecall >= (expectations.minFactRecall ?? 1), detail: { matched: matchedFacts, total: factResults.length, missing: factResults.filter(result => !result.present).map(result => result.fact) } });

  const forbiddenHits = (expectations.forbiddenClaims ?? []).filter(claim => text.includes(normalizeText(claim)));
  checks.push({ name: 'forbiddenClaims', pass: forbiddenHits.length === 0, detail: { hits: forbiddenHits } });

  const categoryCounts = {};
  for (const item of items) categoryCounts[item.category] = (categoryCounts[item.category] ?? 0) + 1;
  const categoryShortfalls = Object.entries(expectations.requiredCategories ?? {}).filter(([category, minimum]) => (categoryCounts[category] ?? 0) < minimum).map(([category, minimum]) => ({ category, minimum, actual: categoryCounts[category] ?? 0 }));
  checks.push({ name: 'requiredCategories', pass: categoryShortfalls.length === 0, detail: { categoryCounts, shortfalls: categoryShortfalls } });

  let unknownRefs = 0, staleRefs = 0;
  for (const item of items) for (const ref of item.evidence ?? []) {
    const found = utterancesById.get(ref.utteranceId);
    if (!found) unknownRefs++;
    else if (found.revision !== ref.revision) staleRefs++;
  }
  const itemsMissingEvidence = items.filter(item => !(item.evidence ?? []).length).length;
  checks.push({ name: 'evidence', pass: unknownRefs === 0 && staleRefs === 0 && itemsMissingEvidence === 0, detail: { items: items.length, itemsMissingEvidence, unknownRefs, staleRefs } });

  const ownerChecks = [];
  for (const expectation of expectations.ownerAssignments ?? []) {
    const target = items.find(item => item.category === 'action' && normalizeText(item.text).includes(normalizeText(expectation.contains)));
    if (!target) { ownerChecks.push({ ...expectation, pass: false, reason: 'action item not found' }); continue; }
    const ownerOk = target.owner && normalizeText(target.owner).includes(normalizeText(expectation.owner));
    const assignmentOk = !expectation.assignment || target.assignment === expectation.assignment;
    ownerChecks.push({ ...expectation, pass: Boolean(ownerOk && assignmentOk), actual: { owner: target.owner, assignment: target.assignment } });
  }
  const forbiddenOwnerHits = [];
  for (const forbiddenOwner of expectations.forbiddenOwners ?? []) {
    for (const item of items.filter(item => item.category === 'action' && item.owner)) {
      if (normalizeText(item.owner).includes(normalizeText(forbiddenOwner)) && item.assignment !== 'explicit') forbiddenOwnerHits.push({ owner: item.owner, textIncludes: forbiddenOwner });
    }
  }
  checks.push({ name: 'ownerAssignments', pass: ownerChecks.every(check => check.pass), detail: { ownerChecks, forbiddenOwnerHits } });
  checks.push({ name: 'forbiddenOwners', pass: forbiddenOwnerHits.length === 0, detail: { hits: forbiddenOwnerHits } });

  const totalItems = items.length;
  checks.push({ name: 'minItems', pass: totalItems >= (expectations.minItems ?? 0), detail: { totalItems, minimum: expectations.minItems ?? 0 } });

  const numbers = numbersIn(documentText(canonical));
  const transcriptNumbers = new Set(numbersIn(utterances.map(utterance => utterance.text).join('\n')).keys());
  const numericRecall = transcriptNumbers.size ? [...transcriptNumbers].filter(token => numbers.has(token)).length / transcriptNumbers.size : null;
  return {
    caseId: testCase.id,
    pass: checks.every(check => check.pass),
    checks,
    metrics: { totalItems, totalChars: documentText(canonical).length, factRecall, categoryCounts, evidence: { itemsMissingEvidence, unknownRefs, staleRefs }, numericRecall, numbersInDocument: numbers.size },
  };
}

// ---------------------------------------------------------------------------
// 読み取り専用DBからのR0〜R3計測
// ---------------------------------------------------------------------------

export function loadSessionState(dbPath, sessionId) {
  // NOTE: node:sqlite の readOnly:true 固定。本番DBを変更しない。
  const { DatabaseSync } = nodeSqlite();
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare('SELECT state FROM sessions WHERE id=?').get(sessionId);
    if (!row) throw new Error(`session not found: ${sessionId}`);
    const core = JSON.parse(row.state);
    const state = { ...core };
    const partFields = ['utterances', 'minutesHistory', 'usage', 'contextMemory', 'aiTurns', 'publications', 'voiceRequests', 'briefHistory'];
    for (const field of partFields) state[field] = [];
    for (const part of db.prepare('SELECT field,ordinal,state FROM session_parts WHERE session_id=? ORDER BY field,ordinal').all(sessionId)) (state[part.field] ??= [])[part.ordinal] = JSON.parse(part.state);
    delete state._partsFormat;
    const events = db.prepare('SELECT seq,at,kind,payload FROM events WHERE session_id=? ORDER BY seq').all(sessionId).map(event => ({ seq: event.seq, at: event.at, kind: event.kind, payload: JSON.parse(event.payload) }));
    const checkpoints = db.prepare('SELECT cache_key, created_at, document FROM minutes_checkpoints WHERE session_id=? ORDER BY created_at').all(sessionId).map(row => ({ cacheKey: row.cache_key, createdAt: row.created_at, document: JSON.parse(row.document) }));
    return { state, events, checkpoints };
  } finally {
    db.close();
  }
}

let sqliteCache = null;
function nodeSqlite() {
  if (!sqliteCache) throw new Error('node:sqlite is unavailable in this Node.js runtime');
  return sqliteCache;
}
const sqliteModule = await import('node:sqlite').catch(() => null);
if (sqliteModule?.DatabaseSync) sqliteCache = sqliteModule;

export function finalUtterances(state) {
  return state.utterances.filter(utterance => utterance.final && utterance.source !== 'ai');
}

// src/minutes.js の splitChunks() と同じ入力形状・上限で分割する（再実装）。
export function splitSourceChunks(utterances, limit = 24000) {
  const list = utterances.map((utterance, index) => ({ id: `u${index + 1}`, revision: utterance.revision, text: utterance.text, speaker: utterance.speaker, at: utterance.startMs }));
  const chunks = [];
  let current = [], size = 0;
  for (const item of list) {
    const length = JSON.stringify(item).length;
    if (size + length > limit && current.length) { chunks.push(current); current = []; size = 0; }
    current.push(item); size += length + 1;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

export function aggregateUsage(usage) {
  const byKind = new Map();
  for (const entry of usage) {
    const group = [entry.kind ?? '(none)', entry.provider ?? '(none)', entry.model ?? '(none)'].join('|');
    const bucket = byKind.get(group) ?? { kind: entry.kind ?? null, provider: entry.provider ?? null, model: entry.model ?? null, calls: 0, outcomes: {}, inputTokens: 0, outputTokens: 0, estimatedUsdKnown: 0, estimatedUsdUnknown: 0, elapsedMs: 0, uploadedAudioSeconds: 0, generatedPcmBytes: 0 };
    bucket.calls++;
    bucket.outcomes[entry.outcome ?? '(none)'] = (bucket.outcomes[entry.outcome ?? '(none)'] ?? 0) + 1;
    bucket.inputTokens += entry.inputTokens ?? 0;
    bucket.outputTokens += entry.outputTokens ?? 0;
    if (Number.isFinite(entry.estimatedUsd)) bucket.estimatedUsdKnown += entry.estimatedUsd; else bucket.estimatedUsdUnknown++;
    bucket.elapsedMs += entry.elapsedMs ?? 0;
    bucket.uploadedAudioSeconds += entry.uploadedAudioSeconds ?? 0;
    bucket.generatedPcmBytes += entry.generatedPcmBytes ?? 0;
    byKind.set(group, bucket);
  }
  const rows = [...byKind.values()].map(bucket => ({ ...bucket, estimatedUsdKnown: Math.round(bucket.estimatedUsdKnown * 1e6) / 1e6, elapsedMs: Math.round(bucket.elapsedMs) }));
  return {
    rows,
    totals: {
      calls: rows.reduce((n, row) => n + row.calls, 0),
      inputTokens: rows.reduce((n, row) => n + row.inputTokens, 0),
      outputTokens: rows.reduce((n, row) => n + row.outputTokens, 0),
      estimatedUsdKnown: Math.round(rows.reduce((n, row) => n + row.estimatedUsdKnown, 0) * 1e6) / 1e6,
      estimatedUsdUnknown: rows.reduce((n, row) => n + row.estimatedUsdUnknown, 0),
      elapsedMs: rows.reduce((n, row) => n + row.elapsedMs, 0),
      uploadedAudioSeconds: Math.round(rows.reduce((n, row) => n + row.uploadedAudioSeconds, 0) * 100) / 100,
    },
    note: 'estimatedUsdKnown は記録に概算が入っている分だけの合計。請求額ではなく、未記録の呼び出しは estimatedUsdUnknown に数える。',
  };
}

async function loadRenderers(kind) {
  if (kind === 'legacy-v1') {
    const module = await import(pathToFileURL(resolve(ROOT, 'eval/legacy-v1.mjs')).href);
    return { name: 'legacy-v1 (b5eaf47時点のsnapshot)', minutesMarkdown: module.legacyMinutesMarkdown, shortMinutes: module.legacyShortMinutes, shortBudget: module.LEGACY_SHORT_BUDGET, shortItemChars: module.LEGACY_SHORT_ITEM_CHARS };
  }
  const minutes = await import(pathToFileURL(resolve(ROOT, 'src/minutes.js')).href);
  const publication = await import(pathToFileURL(resolve(ROOT, 'src/discord/minutes-publication.js')).href);
  return { name: 'live (src/ 現行実装)', minutesMarkdown: minutes.minutesMarkdown, shortMinutes: publication.shortMinutes, shortBudget: DISCORD_MESSAGE_LIMIT, shortItemChars: null };
}

// 既知facts・数値・技術名が R0/R1/R2/R3 のどこに残ったか。
export function computeStageRetention({ transcripts, probes = [] }) {
  const r0Text = transcripts.r0 ?? '';
  const stages = [['r1', transcripts.r1 ?? ''], ['r2', transcripts.r2 ?? ''], ['r3', transcripts.r3 ?? '']];
  const probesReport = probes.map(probe => {
    const r0 = probeMatches(probe, r0Text);
    const present = Object.fromEntries(stages.map(([name, text]) => [name, probeMatches(probe, text)]));
    return { id: probe.id, label: probe.label, r0, ...present, note: probe.note ?? null, retention: r0 ? { r1: present.r1, r2: present.r2, r3: present.r3 } : null };
  });
  const numeric = (() => {
    const r0 = numbersIn(r0Text);
    const moneyR0 = [...r0.keys()].filter(token => token.endsWith('円'));
    const report = { r0Distinct: r0.size, r0MoneyDistinct: moneyR0.length, stages: {} };
    for (const [name, text] of stages) {
      const stage = numbersIn(text);
      const kept = [...r0.keys()].filter(token => stage.has(token)).length;
      const moneyKept = moneyR0.filter(token => stage.has(token)).length;
      report.stages[name] = { distinct: stage.size, keptFromR0: kept, recall: r0.size ? kept / r0.size : null, moneyKeptFromR0: moneyKept, moneyRecall: moneyR0.length ? moneyKept / moneyR0.length : null };
    }
    return report;
  })();
  const technical = (() => {
    const r0 = latinTokensIn(r0Text);
    const report = { r0Distinct: r0.size, stages: {} };
    for (const [name, text] of stages) {
      const stage = latinTokensIn(text);
      const kept = [...r0.keys()].filter(token => stage.has(token)).length;
      report.stages[name] = { distinct: stage.size, keptFromR0: kept, recall: r0.size ? kept / r0.size : null };
    }
    return report;
  })();
  const discourse = computeDiscourseMarkers({ r0: r0Text, r1: transcripts.r1 ?? '', r2: transcripts.r2 ?? '', r3: transcripts.r3 ?? '' });
  return { probes: probesReport, numeric, technical, discourse };
}

// 議事の過程（理由・条件・懸念・比較・検証・決定）を示す語の出現数。
// 意味の正しさではなく「その種の表現が残っているか」の代理指標。人手Gold setの代替ではない。
export const DISCOURSE_MARKERS = Object.freeze({
  reason: ['ため', 'から', '理由', 'ので', 'づけ'],
  condition: ['条件', '場合', 'ただし', '以内', 'までに', '前提'],
  concern: ['懸念', 'リスク', '反対', '難しい', '不安', '注意'],
  comparison: ['比較', '一方', 'に対して', 'より', '候補'],
  verification: ['確認', '検証', '試験', '見積', '試作'],
  decision: ['決定', '決め', '確定', '合意', '承認'],
});
export function computeDiscourseMarkers(texts) {
  const report = {};
  for (const [stage, text] of Object.entries(texts)) {
    const normalized = normalizeText(text);
    const counts = {};
    for (const [group, markers] of Object.entries(DISCOURSE_MARKERS)) {
      counts[group] = markers.reduce((total, marker) => total + (normalized.split(normalizeText(marker)).length - 1), 0);
    }
    report[stage] = { chars: normalized.length, counts, per1000Chars: Object.fromEntries(Object.entries(counts).map(([group, count]) => [group, normalized.length ? Math.round((count / normalized.length) * 1000 * 100) / 100 : null])) };
  }
  return report;
}

// 生成途中のチェックポイント（部分要約）と最終文書の比較。
// 統合では言い換えが起こり得るため、文字列一致で追える範囲の下限推定として扱う。
export function analyzeCheckpointDocuments(checkpoints, finalCanonical, finalDocument) {
  const finalItems = flattenItems(finalCanonical);
  const finalTexts = new Set(finalItems.map(item => normalizeText(item.text)).filter(Boolean));
  const finalSerialized = JSON.stringify(finalDocument ?? null);
  const documents = [];
  const chunkItems = [];
  const chunkTexts = new Map();
  let totalItems = 0, totalRefs = 0;
  for (const [originalIndex, checkpoint] of checkpoints.entries()) {
    let canonical;
    try { canonical = canonicalizeDocument(checkpoint.document); } catch { continue; }
    const items = flattenItems(canonical);
    const categoryCounts = {};
    for (const item of items) categoryCounts[item.category] = (categoryCounts[item.category] ?? 0) + 1;
    const refs = items.flatMap(item => item.evidence);
    const identical = finalDocument != null && JSON.stringify(checkpoint.document) === finalSerialized;
    const matched = items.filter(item => finalTexts.has(normalizeText(item.text))).length;
    documents.push({
      originalIndex,
      identicalToFinalDocument: identical,
      items: items.length,
      chars: items.reduce((total, item) => total + item.text.length, 0),
      categoryCounts,
      evidenceRefs: refs.length,
      uniqueUtterances: new Set(refs.map(ref => ref.utteranceId)).size,
      exactTextMatchToFinal: matched,
      exactTextMatchRate: items.length ? matched / items.length : null,
    });
    totalItems += items.length;
    totalRefs += refs.length;
    if (identical) continue;
    for (const item of items) {
      const normalized = normalizeText(item.text);
      if (!normalized) continue;
      chunkItems.push({ normalized, inFinal: finalTexts.has(normalized) });
      chunkTexts.set(normalized, (chunkTexts.get(normalized) ?? 0) + 1);
    }
  }
  const chunkItemsInFinal = chunkItems.filter(item => item.inFinal).length;
  const finalItemsInChunkExact = finalItems.filter(item => chunkTexts.has(normalizeText(item.text))).length;
  return {
    documents,
    documentCount: documents.length,
    totalItemsAcrossDocuments: totalItems,
    chunkDocuments: documents.filter(document => !document.identicalToFinalDocument).length,
    chunkItems: chunkItems.length,
    chunkUniqueItemTexts: chunkTexts.size,
    chunkItemsMatchingFinalExactly: chunkItemsInFinal,
    chunkExactMatchRate: chunkItems.length ? chunkItemsInFinal / chunkItems.length : null,
    finalItems: finalItems.length,
    finalItemsMatchingChunkExactly: finalItemsInChunkExact,
    finalExactTraceRate: finalItems.length ? finalItemsInChunkExact / finalItems.length : null,
    totalEvidenceRefs: totalRefs,
    note: '統合前の部分要約（チャンク下書き）と最終文書の文字列一致。統合は言い換え・再生成を伴うため、文字列一致しないことを情報の脱落と断定できない。意味的な保持は人手Gold setが必要（未作成）。',
  };
}

export async function analyzeSession({ dbPath, sessionId, probes = [], renderer = 'legacy-v1', canonicalizer } = {}) {
  const { state, events, checkpoints } = loadSessionState(dbPath, sessionId);
  const canonical = canonicalizer ?? (await resolveCanonicalizer());
  const renderers = await loadRenderers(renderer);
  const warnings = [];
  const version = state.minutesHistory?.at(-1);
  if (!version) throw new Error('session has no minutesHistory');
  const final = finalUtterances(state);
  const gaps = state.gaps ?? [];
  const transcriptMetrics = computeTranscriptMetrics(state.utterances, gaps);
  const canonicalDocument = canonical.canonicalize(version.document);
  const documentMetrics = computeDocumentMetrics(canonicalDocument, { utterances: final });

  // R2: 実際に公開された添付Markdown（publication.publicationMarkdown）を最優先。
  const publication = (state.publications ?? []).find(entry => entry.version === version.version) ?? null;
  let r2Source = publication?.publicationMarkdown ?? null;
  let r2SourceKind = r2Source ? 'publication.publicationMarkdown (実際に公開された添付Markdown)' : null;
  if (!r2Source) { r2Source = renderers.minutesMarkdown(state, version); r2SourceKind = `recomputed by ${renderers.name}`; warnings.push('published markdown not found; R2 recomputed from renderer'); }
  const storedHash = publication?.markdownHash ?? null;
  const md5 = createHash('sha256').update(r2Source).digest('hex');
  const publicationHashMatches = storedHash ? storedHash === md5 : null;
  const markdownMetrics = computeMarkdownMetrics(r2Source, canonicalDocument);

  // R3: Discord短縮版。DBに本文は保存されないため、同じstate+versionから再現する。
  const r3 = renderers.shortMinutes(state, version);
  const shortMetrics = computeShortMetrics(r3, canonicalDocument, { budget: renderers.shortBudget, itemChars: renderers.shortItemChars ?? SHORT_ITEM_CHARS });

  // 生成の内訳（calls / chunks / integration / 時間）。
  const minutesUsage = state.usage.filter(entry => entry.kind === 'minutes');
  const chunks = splitSourceChunks(final);
  const usage = aggregateUsage(state.usage);
  const generation = {
    model: [...new Set(minutesUsage.map(entry => entry.model))],
    provider: [...new Set(minutesUsage.map(entry => entry.provider))],
    calls: minutesUsage.length,
    inputTokens: minutesUsage.reduce((n, entry) => n + (entry.inputTokens ?? 0), 0),
    outputTokens: minutesUsage.reduce((n, entry) => n + (entry.outputTokens ?? 0), 0),
    elapsedMsSum: minutesUsage.reduce((n, entry) => n + (entry.elapsedMs ?? 0), 0),
    firstCallAt: minutesUsage.length ? Math.min(...minutesUsage.map(entry => entry.at)) : null,
    lastCallAt: minutesUsage.length ? Math.max(...minutesUsage.map(entry => entry.at)) : null,
    wallClockMs: minutesUsage.length ? Math.max(...minutesUsage.map(entry => entry.at)) - Math.min(...minutesUsage.map(entry => entry.at)) : null,
    sourceChunks: { count: chunks.length, itemsPerChunk: chunks.map(chunk => chunk.length), jsonCharsPerChunk: chunks.map(chunk => JSON.stringify(chunk).length) },
    integration: { phase: state.minutesProgress?.phase ?? null, depth: state.minutesProgress?.depth ?? null, completed: state.minutesProgress?.completed ?? null, total: state.minutesProgress?.total ?? null, reused: state.minutesProgress?.reused ?? null },
    checkpoints: checkpoints.length,
    generationAttempts: state.completionJob?.generationAttempts ?? null,
    events: { minutesRequested: events.filter(event => event.kind === 'minutes_requested').length, minutesFailed: events.filter(event => event.kind === 'minutes_failed').length, minutesReady: events.filter(event => event.kind === 'minutes_ready').length, minutesUsage: events.filter(event => event.kind === 'minutes_usage').length },
    timing: (() => {
      const times = kind => events.filter(event => event.kind === kind).map(event => event.at).sort((a, b) => a - b);
      const requested = times('minutes_requested'), failed = times('minutes_failed'), ready = times('minutes_ready');
      const ended = state.endedAt;
      return {
        endedAt: ended ?? null,
        firstRequestedAt: requested[0] ?? null,
        lastFailedAt: failed.at(-1) ?? null,
        readyAt: ready[0] ?? null,
        endToFirstRequestMs: Number.isFinite(ended) && requested[0] ? requested[0] - ended : null,
        endToReadyMs: Number.isFinite(ended) && ready[0] ? ready[0] - ended : null,
        requestToReadyMs: requested[0] && ready[0] ? ready[0] - requested[0] : null,
      };
    })(),
    note: 'calls は usage に記録された議事録LLM呼び出し回数。検証失敗による再試行を含む。',
    checkpointDocuments: analyzeCheckpointDocuments(checkpoints, canonicalDocument, version.document),
  };

  // STT・health系。
  const healthEvents = events.filter(event => event.kind === 'health');
  const healthByKey = {};
  for (const event of healthEvents) { const key = [event.payload.type ?? '(none)', event.payload.kind ?? '(none)', event.payload.healthy].join('|'); healthByKey[key] = (healthByKey[key] ?? 0) + 1; }
  const sttUsage = state.usage.filter(entry => entry.kind === 'stt');
  const stt = {
    calls: sttUsage.length,
    closed: sttUsage.filter(entry => entry.outcome === 'closed').length,
    failed: sttUsage.filter(entry => entry.outcome === 'failed_billing_unknown').length,
    failureCategoryCounts: sttUsage.filter(entry => entry.outcome !== 'closed').reduce((counts, entry) => { const key = entry.failureCategory ?? '(not recorded)'; counts[key] = (counts[key] ?? 0) + 1; return counts; }, {}),
    uploadedAudioSeconds: Math.round(sttUsage.reduce((n, entry) => n + (entry.uploadedAudioSeconds ?? 0), 0) * 100) / 100,
    estimatedUsdKnown: Math.round(sttUsage.reduce((n, entry) => n + (Number.isFinite(entry.estimatedUsd) ? entry.estimatedUsd : 0), 0) * 1e6) / 1e6,
    estimatedUsdUnknownCalls: sttUsage.filter(entry => !Number.isFinite(entry.estimatedUsd)).length,
    healthEvents: healthByKey,
    stateHealth: state.health ?? null,
    note: 'STT呼び出し回数・音声秒数は usage/health の記録。文字起こしの正解テキストが無いため、STTのWER/CERは測定できない。',
  };

  // 参加者と発言userId集合の照合（件数のみ。実IDは出力しない）。
  const participantIds = new Set(state.participantIds ?? []);
  const utteranceUserIds = new Set(final.map(utterance => utterance.userId).filter(Boolean));
  const participants = {
    participantIds: participantIds.size,
    finalUtteranceUserIds: utteranceUserIds.size,
    matched: [...participantIds].filter(id => utteranceUserIds.has(id)).length,
    participantOnly: [...participantIds].filter(id => !utteranceUserIds.has(id)).length,
    utteranceOnly: [...utteranceUserIds].filter(id => !participantIds.has(id)).length,
    participantNamesRecorded: (version.metadata?.participantNames ?? []).length,
    speakersRecorded: transcriptMetrics.speakers.count,
    note: 'metadata.participantNames と speaker は記録名。実ユーザーIDは件数のみで、値は出力しない。',
  };

  // 既知facts・数値・技術名の段階別保持。
  const retention = computeStageRetention({
    transcripts: { r0: final.map(utterance => utterance.text).join('\n'), r1: documentText(canonicalDocument), r2: r2Source, r3 },
    probes,
  });
  retention.itemCounts = { r0Utterances: final.length, r1Items: documentMetrics.totalItems, r2ItemsRendered: markdownMetrics.itemRetention.rendered, r3ItemsShown: shortMetrics.itemRetention.shown };
  retention.notes = [
    '命題単位の人手Gold setは未作成。ここでは (a) 既知facts probe、(b) 原文の数値・英数字トークンの保持率、(c) evidenceが指す発言の被覆率で代用する。',
    '数値は単位を基本値へ正規化し、カンマ・全半角・空白の差を吸収する。意味の正しさは判定しない。',
    '英数字トークンは技術名・型番の候補であり、STT誤認識の有無は判定できない。',
  ];
  if (!publication) warnings.push('publication record not found');
  if (publicationHashMatches === false) warnings.push('R2 recomputation differs from stored markdownHash');
  warnings.push('R3はDBに保存されていないため、同じstate/versionから決定論的に再現した値（修正前renderer固定）');
  warnings.push('estimatedUsd は記録済みの概算のみ。請求額ではない。');

  const report = {
    tool: 'evaluate-minutes',
    toolVersion: TOOL_VERSION,
    deterministic: true,
    inputs: { mode: 'db', sessionId, renderer: renderers.name, canonicalizer: canonical.source, probes: probes.length },
    warnings,
    session: { status: state.status, endReason: state.endReason ?? null, startedAt: state.startedAt ?? null, endedAt: state.endedAt ?? null, durationMs: Number.isFinite(state.startedAt) && Number.isFinite(state.endedAt) ? state.endedAt - state.startedAt : null, topicPresent: Boolean(state.topic), minutesStatus: state.minutesStatus ?? null, minutesVersion: state.minutesVersion ?? null },
    transcript: transcriptMetrics,
    participants,
    minutes: { version: version.version, kind: version.kind ?? null, approvedAt: version.approvedAt ?? null, reviewedByHuman: Boolean(version.approvedAt), generatedAt: version.generatedAt ?? null, transcriptRefs: version.transcriptRefs?.length ?? null, confirmedDecisions: (version.confirmedDecisions ?? []).length, document: documentMetrics },
    stages: {
      r0: { kind: 'final human utterances', utterances: final.length, chars: transcriptMetrics.chars.total },
      r1: { kind: 'structured minutes v1 document', items: documentMetrics.totalItems, chars: documentMetrics.totalChars, categoryCounts: documentMetrics.categoryCounts },
      r2: { kind: r2SourceKind, source: publication ? 'db.publication.publicationMarkdown' : 'renderer', reviewStatus: publication?.reviewStatus ?? null, status: publication?.status ?? null, chars: markdownMetrics.chars, lines: markdownMetrics.lines, hashMatchesStored: publicationHashMatches, sha256: md5, itemRetention: markdownMetrics.itemRetention, sectionChars: markdownMetrics.sectionChars, staleMarkers: markdownMetrics.staleMarkers, evidenceIdsVisible: markdownMetrics.evidenceIdsVisible },
      r3: { kind: `reproduced by ${renderers.name}`, chars: shortMetrics.chars, lines: shortMetrics.lines, budgetChars: shortMetrics.budgetChars, withinBudget: shortMetrics.withinBudget, withinDiscordLimit: shortMetrics.withinDiscordLimit, itemRetention: shortMetrics.itemRetention, categoriesDropped: shortMetrics.categoriesDropped, budgetUsage: shortMetrics.budgetUsage, sha256: createHash('sha256').update(r3).digest('hex') },
    },
    retention,
    usage,
    stt,
    generation,
  };
  return { report, state, events, checkpoints };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const FLAGS = new Set(['db', 'session', 'document', 'markdown', 'short', 'utterances', 'probes', 'cases', 'case', 'json', 'renderer', 'quiet', 'strict']);

export function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`);
    let name = token.slice(2);
    let value;
    const eq = name.indexOf('=');
    if (eq >= 0) { value = name.slice(eq + 1); name = name.slice(0, eq); }
    if (!FLAGS.has(name)) throw new Error(`unknown option: --${name}`);
    if (['quiet', 'strict'].includes(name)) { args[name] = true; continue; }
    if (value === undefined) {
      value = argv[++index];
      if (value === undefined) throw new Error(`--${name} requires a value`);
    }
    args[name] = value;
  }
  return args;
}

function readJson(filePath) { return JSON.parse(readFileSync(filePath, 'utf8')); }

function loadUtterancesFromFile(filePath) {
  const data = readJson(filePath);
  const list = Array.isArray(data) ? data : data.utterances;
  if (!Array.isArray(list)) throw new Error('utterances file must be an array or {utterances:[...]}');
  return list.map((utterance, index) => ({ id: utterance.id ?? `u${index + 1}`, revision: Number.isInteger(utterance.revision) ? utterance.revision : 1, text: String(utterance.text ?? ''), speaker: utterance.speaker ?? null, final: utterance.final !== false, startMs: utterance.startMs ?? null, endMs: utterance.endMs ?? null, userId: utterance.userId ?? null }));
}

export function stripReportInternal(report) {
  // 出力に本文が混ざらないよう、内部用フィールドがあれば落とす（現状は集計のみ）。
  return report;
}

export async function runCli(argv, { stdout = line => console.log(line), stderr = line => console.error(line) } = {}) {
  const args = parseArgs(argv);
  const canonicalizer = await resolveCanonicalizer();
  const report = { tool: 'evaluate-minutes', toolVersion: TOOL_VERSION, deterministic: true, inputs: {}, warnings: [], canonicalizer: canonicalizer.source };

  if (args.probes) report.probes = loadProbes(args.probes);

  // 1) cases 定義の検証（既定動作）。
  if (args.cases || (!args.db && !args.document && !args.markdown && !args.short)) {
    const casesPath = args.cases ?? resolve(ROOT, 'eval/cases-v2.json');
    report.inputs.cases = casesPath;
    report.cases = validateCasesFile(casesPath);
    if (args.case) {
      const data = readJson(casesPath);
      report.inputs.case = args.case;
      if (!args.document) report.warnings.push('--case を指定しましたが --document が無いため採点は行いません');
      else {
        const testCase = (data.cases ?? []).find(entry => entry.id === args.case);
        if (!testCase) throw new Error(`case not found: ${args.case}`);
        report.caseScore = scoreCase(readJson(args.document), testCase, { canonicalizer: canonicalizer.canonicalize });
        report.inputs.document = args.document;
      }
    }
    if (!args.cases && !args.document) report.warnings.push('既定動作: eval/cases-v2.json の自己検証のみ。実会議の計測は --db/--session を指定する。');
  }

  // 2) DBからのR0〜R3計測。
  if (args.db || args.session) {
    if (!args.db || !args.session) throw new Error('--db と --session は両方指定してください');
    report.inputs.db = args.db;
    report.inputs.session = args.session;
    const { report: sessionReport } = await analyzeSession({ dbPath: args.db, sessionId: args.session, probes: report.probes ?? [], renderer: args.renderer ?? 'legacy-v1', canonicalizer });
    Object.assign(report, { session: sessionReport.session, warnings: [...new Set([...report.warnings, ...sessionReport.warnings])], transcript: sessionReport.transcript, participants: sessionReport.participants, minutes: sessionReport.minutes, stages: sessionReport.stages, retention: sessionReport.retention, usage: sessionReport.usage, stt: sessionReport.stt, generation: sessionReport.generation });
  }

  // 3) 候補文書の採点（--document）。
  if (args.document && !args.case) {
    const document = readJson(args.document);
    const utterances = args.utterances ? loadUtterancesFromFile(args.utterances) : null;
    report.inputs.document = args.document;
    if (args.utterances) report.inputs.utterances = args.utterances;
    const canonical = canonicalizer.canonicalize(document);
    report.document = computeDocumentMetrics(canonical, { utterances });
    const markdownText = args.markdown ? readFileSync(args.markdown, 'utf8') : null;
    const shortText = args.short ? readFileSync(args.short, 'utf8') : null;
    if (markdownText != null) { report.inputs.markdown = args.markdown; report.markdown = computeMarkdownMetrics(markdownText, canonical); }
    if (shortText != null) { report.inputs.short = args.short; report.short = computeShortMetrics(shortText, canonical); }
    // R0（--utterances）が与えられたら、DBモードと同じ段階別保持を計算する。
    if (utterances) {
      report.retention = computeStageRetention({
        transcripts: { r0: utterances.filter(utterance => utterance.final !== false).map(utterance => utterance.text).join('\n'), r1: documentText(canonical), r2: markdownText ?? '', r3: shortText ?? '' },
        probes: report.probes ?? [],
      });
      report.retention.itemCounts = { r0Utterances: utterances.filter(utterance => utterance.final !== false).length, r1Items: report.document.totalItems, r2ItemsRendered: report.markdown?.itemRetention.rendered ?? null, r3ItemsShown: report.short?.itemRetention.shown ?? null };
      report.retention.notes = ['documentモードの段階保持。R1は入力document、R2/R3は--markdown/--shortの実測。'];
    }
  }

  if (args.json) {
    mkdirSync(dirname(resolve(args.json)), { recursive: true });
    writeFileSync(resolve(args.json), JSON.stringify(stripReportInternal(report), null, 2));
  }

  const failed = (report.cases && !report.cases.ok) || (report.caseScore && !report.caseScore.pass);
  if (args.strict && failed) process.exitCode = 1;

  if (!args.quiet) {
    stdout(JSON.stringify(summarizeForStdout(report), null, 2));
    if (args.strict && failed) stderr('evaluation failed (--strict)');
  }
  return report;
}

// 標準出力用の要約。本文・実ID・発言テキストは含めない。
export function summarizeForStdout(report) {
  const summary = { tool: report.tool, toolVersion: report.toolVersion, deterministic: report.deterministic, inputs: report.inputs, warnings: report.warnings };
  if (report.cases) summary.cases = { ok: report.cases.ok, count: report.cases.cases.length, errors: report.cases.errors };
  if (report.caseScore) summary.caseScore = { caseId: report.caseScore.caseId, pass: report.caseScore.pass, checks: report.caseScore.checks.map(check => ({ name: check.name, pass: check.pass })), metrics: report.caseScore.metrics };
  if (report.document) summary.document = report.document;
  if (report.retention) summary.retention = report.retention;
  if (report.markdown) summary.markdown = report.markdown;
  if (report.short) summary.short = report.short;
  if (report.session) {
    summary.session = report.session;
    summary.transcript = report.transcript;
    summary.participants = report.participants;
    summary.minutes = report.minutes;
    summary.stages = report.stages;
    summary.retention = report.retention;
    summary.usage = report.usage;
    summary.stt = report.stt;
    summary.generation = report.generation;
  }
  return summary;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  runCli(process.argv.slice(2)).catch(error => {
    console.error(`evaluate-minutes: ${error.message}`);
    process.exitCode = 1;
  });
}
