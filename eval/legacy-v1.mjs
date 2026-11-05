// 修正前（b5eaf47、2026-11-06改修開始時点）の描画ロジックのスナップショット。
//
// 目的: 11/5実会議のベースライン（R2 = 全文Markdown / R3 = Discord短縮版）を、
// 後から src/ がv2対応に変わっても同じ結果で再現できるように固定する。
// 評価・ベースライン計測専用。ここへ新機能を追加しない（仕様変更は src/ 側で行う）。
//
// 出典:
//   - legacyMinutesMarkdown: src/minutes.js（b5eaf47）の minutesMarkdown() と依存関数
//   - legacyShortMinutes: src/discord/minutes-publication.js（b5eaf47）の
//     safeText()/meetingTime()/previewText()/shortMinutes()
//
// 注意: これは「修正前の表示がどう情報を落としていたか」を測るための固定値であり、
// 修正後の望ましい描画ではない。修正後の評価は src/ の現行実装で行う。

import { escapeMarkdown } from 'discord.js';

// ---- src/minutes.js (b5eaf47) の写し -------------------------------------

export const legacyMinutesItems = document =>
  ['overview', 'ideas', 'comparisons', 'decisionCandidates', 'openIssues', 'actionItems']
    .flatMap(key => document[key] || []);

export const legacyEvidenceCurrent = (state, refs) =>
  refs.length > 0 && refs.every(r => state.utterances.some(u =>
    u.final && u.source !== 'ai' && u.id === r.utteranceId && u.revision === r.revision));

export function legacyMinutesStale(state, version) {
  if (version.briefRevision !== undefined && version.briefRevision !== (state.briefRevision || 0)) return true;
  if (version.transcriptRefs && (version.transcriptRefs.length !== state.utterances.filter(u => u.final && u.source !== 'ai').length || version.confirmedDecisions && JSON.stringify(version.confirmedDecisions) !== JSON.stringify(state.decisions))) return true;
  return legacyMinutesItems(version.document).some(item => !legacyEvidenceCurrent(state, item.evidence)) ||
    (version.transcriptRefs || []).some(r => !legacyEvidenceCurrent(state, [r]));
}

export function legacyMinutesMarkdown(state, version = state.minutesHistory?.at(-1)) {
  if (!version) throw new Error('議事録はまだありません。再生成してください。');
  if (version.approvedMarkdown) return (legacyMinutesStale(state, version) ? '記録が更新されています。この確認済み版は要再確認で、再公開できません。\n\n' : '') + version.approvedMarkdown;
  const metadata = version.metadata || state;
  const clean = s => String(s).replace(/[\r\n]/g, ' ');
  const stale = legacyMinutesStale(state, version);
  const lines = [`# ${version.kind === 'summary' ? '途中要約（正式議事録ではありません）' : '議事録'}：${clean(metadata.topic)}`, '', `- 会議ID：${state.id}`, `- 日時：${metadata.startedAt ? new Date(metadata.startedAt).toISOString() : '不明'}〜${metadata.endedAt ? new Date(metadata.endedAt).toISOString() : '進行中'}`,
    `- 状態：${state.status}`, `- 議事録：版${version.version} ${stale ? '要再確認' : version.approvedAt ? '操作担当者が確認済み' : (state.fixedOperation ? 'AI生成・未確認' : 'AI下書き（未承認）')}`,
    `- 参加者（記録で確認）：${(metadata.participantNames || [...new Set(state.utterances.map(u => u.speaker).filter(Boolean))]).map(clean).join('、') || '不明'}`, ''];
  if (version.recovery?.method === 'assistant_without_api') lines.push('作成方法：保存済み文字起こしを支援AIが直接読んで復旧しました。この復旧ではOpenAI APIの追加呼び出しを行っていません。人による確認は未実施です。', '');
  const section = (title, entries, format = entry => clean(entry.text)) => {
    lines.push(`## ${title}`, '');
    lines.push(...(entries.length ? entries.map(e => `- ${format(e)}${legacyEvidenceCurrent(state, e.evidence) ? '' : '（要再確認）'}`) : ['該当なし']), '');
  };
  if (metadata.meetingBrief) lines.push('## 会議の本筋', '', clean(metadata.meetingBrief.text), '', `（開始者・担当者が指定した進め方。参加者全員の合意ではない）${metadata.meetingBrief.needsReview ? ' 要再確認。' : ''}`, '');
  if (metadata.briefNeedsReview) lines.push('本筋を指定した原発言が訂正されています。設定は要再確認のため、議事録の判断軸には使用していません。', '');
  section('概要', version.document.overview); section('主な案', version.document.ideas);
  section('案の比較・議論', version.document.comparisons);
  section('決定事項（人が確認済み）', version.confirmedDecisions || state.decisions || []);
  section('決定候補（確認待ち）', version.document.decisionCandidates);
  section('未決事項', version.document.openIssues);
  section('次のアクション（候補）', version.document.actionItems, e => `${clean(e.text)}／担当：${clean(e.owner || '不明')}／期限：${clean(e.deadline || '不明')}`);
  lines.push('## 記録の注記', '', '決定候補は参加者の確認が別途必要です。根拠の発言ID（utteranceId@revision）はローカルの記録データに保持されており、議事録本文からは省いています。');
  if (!state.utterances.some(u => u.final)) lines.push('会議内容なし。');
  if (state.endReason && !['manual', 'empty_timeout', 'leave'].includes(state.endReason)) lines.push(`終了理由：${clean(state.endReason)}。正常終了と区別してください。`);
  const gaps = state.gaps || [];
  if (gaps.length > 20) {
    const counts = new Map(); for (const gap of gaps) counts.set(gap.kind, (counts.get(gap.kind) || 0) + 1);
    for (const [kind, count] of counts) lines.push(`- 記録欠損の可能性：${kind === 'stt' ? '音声認識の失敗' : clean(kind)} ${count}件。発生区間には重複があり、欠損時間や発言数の合計を示す数値ではありません。`);
    lines.push('- 発言が断片的な箇所や、記録のない内容は補完していません。障害区間の詳細はローカルの原本記録に保持しています。');
  } else for (const gap of gaps) lines.push(`- 記録欠損の可能性：${clean(gap.kind)} ${gap.startedAt ? new Date(gap.startedAt).toISOString() : '開始不明'}〜${gap.endedAt ? new Date(gap.endedAt).toISOString() : '終了不明'}`);
  return lines.join('\n') + '\n';
}

// ---- src/discord/minutes-publication.js (b5eaf47) の写し ------------------

// Discord本文の文字数予算。shortMinutes() はこの予算を超える節を丸ごと省く。
export const LEGACY_SHORT_BUDGET = 1450;
export const LEGACY_SHORT_ITEM_LIMIT = 2;
export const LEGACY_SHORT_ITEM_CHARS = 130;

export const legacySafeText = text => escapeMarkdown(String(text ?? '').replace(/[\r\n\t]/g, ' ').replace(/@/g, '＠').replace(/</g, '＜').replace(/>/g, '＞'));

const meetingTime = at => at == null || !Number.isFinite(new Date(at).getTime()) ? '不明'
  : new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(at)).replaceAll('-', '/');

const previewText = (text, limit) => legacySafeText(Array.from(String(text ?? '')).length > limit ? Array.from(String(text)).slice(0, limit).join('') + '…' : text);

export function legacyShortMinutes(state, version) {
  const m = version.metadata || state, d = version.document;
  const start = meetingTime(m.startedAt), end = meetingTime(m.endedAt), sameDay = start !== '不明' && end !== '不明' && start.slice(0, 10) === end.slice(0, 10);
  const participants = (m.participantNames || []).map(name => String(name).replace(/\s+\(\d{17,22}\)$/, ''));
  const lines = [`**議事録（${version.approvedAt ? '確認済み' : 'AI生成・未確認'}）｜版${version.version}**`, `${start}〜${sameDay ? end.slice(11) : end}（日本時間）`, `議題：${previewText(m.topic || state.topic, 120)}`, `参加者：${previewText(participants.join('、') || '不明', 160)}`];
  if (m.meetingBrief) lines.push(`本筋：${previewText(m.meetingBrief.text, 180)}${m.meetingBrief.needsReview ? '（要再確認）' : ''}`);
  if (m.briefNeedsReview) lines.push('本筋：要再確認（指定した発言が訂正されています）');
  for (const [label, items] of [['概要', d.overview], ['確認済み決定', version.confirmedDecisions || []], ['決定候補（未確認）', d.decisionCandidates], ['未決事項', d.openIssues], ['アクション（候補）', d.actionItems]]) {
    if (!items.length) continue;
    const block = `\n**${label}**\n` + items.slice(0, LEGACY_SHORT_ITEM_LIMIT).map(i => '- ' + previewText(i.text, LEGACY_SHORT_ITEM_CHARS) + (label.startsWith('アクション') ? `\n  担当：${previewText(i.owner || '不明', 40)}／期限：${previewText(i.deadline || '不明', 40)}` : '')).join('\n');
    if (lines.join('\n').length + block.length <= LEGACY_SHORT_BUDGET) lines.push(block);
  }
  if (!version.confirmedDecisions?.length) lines.push('\n確認済みの決定はありません。');
  lines.push('\n' + (version.approvedAt ? '操作担当者が確認済みの版です。' : 'AIによる下書きです。内容・参加者の合意は未確認です。'), '詳細は添付のMarkdownをご覧ください。');
  return lines.join('\n');
}
