// 担当者メンションの解決（別名辞書・限定正規化・完全一致・Guild/ID検証）と
// 通知計画（describeMentionPlan）を提供する。Discord送信は行わない。
//
// 安全原則:
// - 名前が出現しただけでは通知しない。assignment==='explicit' かつ根拠先頭発言を
//   独立分類して explicit かつ辞書で一意にsnowflake解決できた場合だけ通知候補にする。
// - 実ユーザーIDはコード・サンプルへ埋め込まない。辞書はファイル（git管理外）から読む。
// - 辞書が無い/無効/未検証/Guild不一致/メンバー取得不可は「未解決」として通知しない。
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as minutesCore from '../minutes.js';
import { applyMentionSuppression, mentionTextDigest } from '../publication.js';

export const ALIAS_FILE_ENV = 'WAIGAYA_MEMBER_ALIASES_FILE';
export const DEFAULT_ALIAS_FILE = 'config/waigaya-member-aliases.json';
export const SAMPLE_ALIAS_FILE = 'config/waigaya-member-aliases.sample.json';
const REPOSITORY_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SNOWFLAKE = /^\d{17,22}$/;
export const isSnowflake = value => typeof value === 'string' && SNOWFLAKE.test(value);

// --- 限定正規化 -----------------------------------------------------------
// NFKC・小文字化（英字）・空白/句読点/括弧の除去・末尾の敬称除去だけを行う。
// 部分一致・読み・ローマ字化などの推測はしない。
const PUNCTUATION = /[\s\u3000!-/:-@[-`{-~、。，．・：；？！「」『』（）()【】〔〕〈〉《》…‥〜～]/g;
const HONORIFICS = ['先生', 'ちゃん', 'さん', 'さま', '様', 'くん', '君', '氏'];
const normalizedHonorifics = HONORIFICS.map(value => value.normalize('NFKC').toLowerCase());
export function normalizeAliasName(value) {
  if (typeof value !== 'string') return '';
  let text = value.normalize('NFKC').toLowerCase().replace(PUNCTUATION, '');
  let changed = true;
  for (let guard = 0; changed && guard < 4; guard++) {
    changed = false;
    for (const honorific of normalizedHonorifics) {
      if (text.length > honorific.length && text.endsWith(honorific)) { text = text.slice(0, -honorific.length); changed = true; break; }
    }
  }
  return text;
}
const escapeRegExp = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// --- 別名辞書 -------------------------------------------------------------
export function aliasDictionaryVersion(dictionary) {
  if (!dictionary) return null;
  const material = { schemaVersion: dictionary.schemaVersion, guildId: dictionary.guildId, notificationDefaults: dictionary.notificationDefaults,
    members: (dictionary.members || []).map(member => ({ userId: member.userId, usernameHint: member.usernameHint, displayNameHint: member.displayNameHint, aliases: member.aliases, verified: member.verified, enabled: member.enabled })) };
  return createHash('sha256').update(JSON.stringify(material)).digest('hex').slice(0, 16);
}
const emptyMember = index => ({ index, userId: null, usernameHint: null, displayNameHint: null, aliases: [], normalizedAliases: [], verified: false, enabled: false, invalid: true, invalidReason: 'invalid_entry' });
export function parseAliasDictionary(raw, { source = 'memory' } = {}) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { dictionary: null, errors: ['別名辞書のJSON形式が不正です。'] };
  if (raw.schemaVersion !== 1) return { dictionary: null, errors: ['別名辞書のschemaVersionは1を指定してください。'] };
  const guildId = raw.guildId ?? null;
  if (guildId !== null && !isSnowflake(guildId)) errors.push('guildIdは17〜22桁の数値文字列かnullにしてください。');
  const defaults = raw.notificationDefaults && typeof raw.notificationDefaults === 'object' ? raw.notificationDefaults : {};
  const notificationDefaults = {
    // 未設定は常に安全側（通知しない）。
    enabled: defaults.enabled === true,
    mentionOnlyExplicitAssignees: defaults.mentionOnlyExplicitAssignees !== false,
    mentionProposedAssignees: defaults.mentionProposedAssignees === true,
    suppressRepeatMentions: defaults.suppressRepeatMentions !== false,
  };
  if (!Array.isArray(raw.members)) return { dictionary: null, errors: [...errors, 'membersは配列で指定してください。'] };
  if (raw.members.length > 200) errors.push('membersは200件以下にしてください。');
  const members = [];
  const seenUserIds = new Map();
  for (const [index, entry] of raw.members.slice(0, 200).entries()) {
    if (!entry || typeof entry !== 'object') { members.push(emptyMember(index)); continue; }
    const userId = entry.userId ?? null;
    const member = { index, userId,
      usernameHint: typeof entry.usernameHint === 'string' ? entry.usernameHint.trim().slice(0, 100) : null,
      displayNameHint: typeof entry.displayNameHint === 'string' ? entry.displayNameHint.trim().slice(0, 100) : null,
      aliases: Array.isArray(entry.aliases) ? [...new Set(entry.aliases.filter(alias => typeof alias === 'string').map(alias => alias.trim().slice(0, 100)).filter(Boolean))].slice(0, 20) : [],
      normalizedAliases: [], verified: entry.verified === true, enabled: entry.enabled === true, invalid: false, invalidReason: null };
    if (userId !== null && !isSnowflake(userId)) { member.invalid = true; member.invalidReason = 'invalid_user_id'; }
    if (member.userId !== null && seenUserIds.has(member.userId)) {
      member.invalid = true; member.invalidReason = 'duplicate_user_id';
      const other = members[seenUserIds.get(member.userId)];
      if (other) { other.invalid = true; other.invalidReason ??= 'duplicate_user_id'; }
    } else if (member.userId !== null) seenUserIds.set(member.userId, members.length);
    members.push(member);
  }
  const aliasIndex = new Map();
  for (const member of members) {
    if (member.invalid) continue;
    const names = [member.usernameHint, member.displayNameHint, ...member.aliases].filter(Boolean);
    // 1文字の別名は誤一致しやすいため解決に使わない。
    member.normalizedAliases = [...new Set(names.map(normalizeAliasName).filter(name => name.length >= 2))];
    for (const alias of member.normalizedAliases) {
      const list = aliasIndex.get(alias) || []; list.push(member.index); aliasIndex.set(alias, list);
    }
  }
  const dictionary = { schemaVersion: 1, templateOnly: raw.templateOnly === true, warning: typeof raw.warning === 'string' ? raw.warning.slice(0, 500) : null,
    guildId, notificationDefaults, members, aliasIndex, source, version: null, loadedAt: null };
  dictionary.version = aliasDictionaryVersion(dictionary);
  return { dictionary, errors };
}
export function loadAliasDictionary({ env = process.env, file, readFile = readFileSync, root = REPOSITORY_ROOT, now = Date.now() } = {}) {
  const configured = typeof file === 'string' && file ? file : env?.[ALIAS_FILE_ENV];
  const path = configured ? (isAbsolute(configured) ? configured : resolve(configured)) : join(root, DEFAULT_ALIAS_FILE);
  let text;
  try { text = readFile(path, 'utf8'); } catch { return { dictionary: null, error: 'alias_dictionary_missing', path }; }
  let raw;
  try { raw = JSON.parse(text); } catch { return { dictionary: null, error: 'alias_dictionary_invalid_json', path }; }
  const { dictionary, errors } = parseAliasDictionary(raw, { source: path });
  if (!dictionary) return { dictionary: null, error: errors[0] || 'alias_dictionary_invalid', path };
  dictionary.loadedAt = now;
  return { dictionary, error: null, warnings: errors, path };
}

// --- 解決 -----------------------------------------------------------------
const memberDisplayName = member => member.displayNameHint || member.usernameHint || null;
function checkMembership(member, { guildMembers, checkMembership: verify = true } = {}) {
  if (!verify) return { status: 'resolved' };
  if (!guildMembers || guildMembers.available === false) return { status: 'membership_unavailable' };
  const entry = guildMembers.members instanceof Map ? guildMembers.members.get(member.userId) : guildMembers.members?.[member.userId];
  if (!entry) return { status: 'not_member' };
  if (entry.found === false) return { status: entry.reason === 'lookup_failed' ? 'membership_unavailable' : 'not_member' };
  if (member.usernameHint && entry.username && normalizeAliasName(member.usernameHint) !== normalizeAliasName(entry.username)) return { status: 'identity_mismatch' };
  return { status: 'resolved' };
}
function verifyMember(member, options) {
  if (!member.verified) return { status: 'unverified', userId: member.userId, displayName: memberDisplayName(member) };
  if (!member.enabled) return { status: 'disabled', userId: member.userId, displayName: memberDisplayName(member) };
  const membership = checkMembership(member, options);
  if (membership.status !== 'resolved') return { status: membership.status, userId: member.userId, displayName: memberDisplayName(member) };
  return { status: 'resolved', userId: member.userId, displayName: memberDisplayName(member), member };
}
// 別名（完全一致のみ）→ 一意なsnowflake。曖昧・未検証・無効・Guild不一致は未解決。
export function resolveAlias(dictionary, name, { guildId, guildMembers = null, checkMembership: verify = true } = {}) {
  if (!dictionary) return { status: 'no_dictionary', userId: null, displayName: null };
  if (!guildId || !dictionary.guildId || dictionary.guildId !== guildId) return { status: 'guild_mismatch', userId: null, displayName: null };
  const normalized = normalizeAliasName(name);
  if (!normalized) return { status: 'empty_name', userId: null, displayName: null };
  const candidates = (dictionary.aliasIndex.get(normalized) || []).map(index => dictionary.members[index]).filter(member => member && !member.invalid);
  if (!candidates.length) return { status: 'unregistered', userId: null, displayName: null, normalizedName: normalized };
  const userIds = [...new Set(candidates.map(member => member.userId))];
  if (userIds.length > 1) return { status: 'ambiguous', userId: null, displayName: null, normalizedName: normalized };
  return { ...verifyMember(candidates[0], { guildMembers, checkMembership: verify }), normalizedName: normalized };
}
// 自己申告（「私がやります」）など、発話者のuserIdを辞書とGuild在籍で検証する。
export function resolveUserId(dictionary, userId, { guildId, guildMembers = null, checkMembership: verify = true } = {}) {
  if (!dictionary) return { status: 'no_dictionary', userId: null, displayName: null };
  if (!isSnowflake(userId)) return { status: 'invalid_user_id', userId: null, displayName: null };
  if (!guildId || !dictionary.guildId || dictionary.guildId !== guildId) return { status: 'guild_mismatch', userId, displayName: null };
  const member = dictionary.members.find(entry => !entry.invalid && entry.userId === userId);
  if (!member) return { status: 'unregistered', userId, displayName: null };
  return verifyMember(member, { guildMembers, checkMembership: verify });
}
function aliasesForOwner(dictionary, owner) {
  const key = normalizeAliasName(owner);
  if (!key) return [];
  return [...new Set((dictionary.aliasIndex.get(key) || []).flatMap(index => dictionary.members[index]?.normalizedAliases || []))];
}
// 辞書設定済みのユーザーについて、対象Guildのメンバー情報をAPIで個別照合する。
// 全メンバー収集はしない。取得できない場合は未解決（通知しない）。
export async function collectGuildMembership(guild, userIds, { fetchMember } = {}) {
  const ids = [...new Set((Array.isArray(userIds) ? userIds : []).filter(isSnowflake))].slice(0, 50);
  const members = new Map();
  const fetchOne = fetchMember || (guild?.members?.fetch ? id => guild.members.fetch(id) : null);
  if (!fetchOne) return { available: false, reason: 'guild_members_unavailable', members };
  let failed = 0;
  for (const id of ids) {
    try {
      const found = await fetchOne(id);
      if (!found) members.set(id, { found: false, reason: 'not_member' });
      else members.set(id, { found: true, id, username: found.user?.username ?? found.username ?? null, displayName: found.displayName ?? found.user?.globalName ?? null });
    } catch (error) {
      const code = Number(error?.code); const message = String(error?.message || '');
      if (code === 10007 || /unknown member/i.test(message)) members.set(id, { found: false, reason: 'not_member' });
      else { failed++; members.set(id, { found: false, reason: 'lookup_failed' }); }
    }
  }
  return { available: true, reason: failed && failed === ids.length ? 'guild_lookup_failed' : null, members };
}

// --- 議事録の正規形（v1/v2両対応） ---------------------------------------
// 正規形は minutes-core の canonicalMinutes()（CONTEXT §8の契約）に委譲する。
export function canonicalMinutesDocument(document) {
  return minutesCore.canonicalMinutes(document);
}

// --- 担当判定の独立分類（D3/D5） ------------------------------------------
// 議事録の assignment/owner を鵜呑みにせず、根拠先頭発言から担当の明示性を判定する。
const HONORIFIC_PATTERN = '(?:さん|氏|くん|君|先生|様|さま|ちゃん)';
const SELF_PATTERN = /(?:^|[、,。\s])(?:私|わたし|僕|ぼく|俺|おれ|自分)(?:が|は|からは|のほうが)?[^。]{0,15}?(?:やります|やる|やらせてください|担当します|担当する|対応します|対応する|確認します|進めます|引き受けます|まとめます)/;
const PAST_PATTERN = /(?:と言っていた|と言ってた|と言っていました|と言った|言ってた|話していた|話してた|らしい|そうだ|とのこと|と聞いた|と聞いている)/;
const REQUEST_PATTERN = /(?:してください|して下さい|お願いします|お願いすることになりました|お願い|頼みます|ください)/;
const EXPLICIT_VERB_PATTERN = /(?:やります|やる|担当します|担当する|対応します|対応する|確認します|確認する|進めます|進める|調べます|調べる|用意します|用意する|作成します|作成する|作ります|作る|直します|直す|レビューします|レビューする|実施します|実施する|検討します|検討する|まとめます|まとめる)/;
const PROPOSAL_PATTERN = /(?:しようか|してみよう|してみる|どう(?:かな|でしょう|ですか|思う)|かな(?:[。？?]|$)|では？|でいい(?:の)?[？?]?|候補|お願いしてみる|聞いてみ(?:よう|る)|頼んでみ(?:よう|る)|どうだろう)/;
const CORRECTION_PATTERN = /(?:いや|違う|ではなく|じゃなくて|ではなくて)/;
const DENIAL_PATTERN = /(?:やらなくていい|やらなくてよい|やらない|不要|担当しない|担当しなくていい|やめておく|やめておいた|する必要はない)/;
const SAME_PERSON_PATTERN = /(?:同じ人|同一人物|別の人|別人)/;
const NAME_TOKEN_PATTERN = new RegExp(`([\\u3040-\\u30ff\\u3400-\\u9fffA-Za-z0-9_]{2,20})${HONORIFIC_PATTERN}`, 'g');
function nameTokens(text) {
  const found = [];
  for (const match of text.normalize('NFKC').matchAll(NAME_TOKEN_PATTERN)) { const name = normalizeAliasName(match[1]); if (name.length >= 2) found.push(name); }
  return [...new Set(found)];
}
function ownerNearExplicit(raw, ownerVariants) {
  const suffix = HONORIFIC_PATTERN + '?';
  const gap = '[^。]{0,60}?';
  const action = `(?:${REQUEST_PATTERN.source}|${EXPLICIT_VERB_PATTERN.source})`;
  return ownerVariants.some(variant => new RegExp(`${escapeRegExp(variant)}${suffix}${gap}${action}`, 'i').test(raw));
}
function denialNearOwner(raw, ownerVariants) {
  if (!ownerVariants.length) return false;
  const names = ownerVariants.map(variant => escapeRegExp(variant)).join('|');
  const suffix = HONORIFIC_PATTERN + '?';
  return new RegExp(`(?:${names})${suffix}[^。]{0,12}?(?:${DENIAL_PATTERN.source})`, 'i').test(raw);
}
export function classifyAssignment(text, { ownerName = null, aliases = [] } = {}) {
  const raw = String(text ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const base = { assignment: 'none', self: false, ownerPresent: false, denied: false, conflict: false, reason: 'no_assignee' };
  if (!raw) return { ...base, reason: 'empty_text' };
  const normalizedText = normalizeAliasName(raw);
  const ownerKey = normalizeAliasName(ownerName || '');
  const ownerVariants = [...new Set([ownerKey, ...(Array.isArray(aliases) ? aliases : []).map(normalizeAliasName)].filter(variant => variant.length >= 2))];
  const ownerPresent = Boolean(ownerKey && ownerVariants.some(variant => normalizedText.includes(variant)));
  const tokens = nameTokens(raw);
  if (CORRECTION_PATTERN.test(raw) && tokens.length >= 2) return { ...base, assignment: 'conflict', ownerPresent, conflict: true, reason: 'conflicting_assignees' };
  if (SAME_PERSON_PATTERN.test(raw)) return { ...base, ownerPresent, reason: 'identity_statement' };
  const self = SELF_PATTERN.test(raw);
  if (PAST_PATTERN.test(raw) && !self) return { ...base, ownerPresent, reason: 'past_mention' };
  const question = /[?？]/.test(raw);
  const proposal = PROPOSAL_PATTERN.test(raw);
  if ((question || proposal) && !REQUEST_PATTERN.test(raw)) return { ...base, assignment: 'proposed', ownerPresent, reason: 'proposal_question' };
  if (self) return { ...base, assignment: 'explicit', self: true, ownerPresent, denied: denialNearOwner(raw, ownerVariants), reason: 'self_assignment' };
  if (denialNearOwner(raw, ownerVariants)) return { ...base, ownerPresent, denied: true, reason: 'assignee_denied' };
  const explicit = ownerNearExplicit(raw, ownerVariants) || (REQUEST_PATTERN.test(raw) && tokens.length > 0) || (EXPLICIT_VERB_PATTERN.test(raw) && tokens.length > 0);
  if (explicit) return { ...base, assignment: 'explicit', ownerPresent, reason: 'explicit_assignment' };
  return { ...base, ownerPresent };
}

// --- 通知計画（純粋関数） -------------------------------------------------
const normalizeAssignment = value => ['explicit', 'proposed', 'none', 'conflict'].includes(value) ? value : 'legacy';
const REASON_LABELS = {
  dictionary_missing: '別名辞書が未設定',
  notifications_disabled: '辞書で通知が無効',
  guild_unconfigured: '辞書のGuildが未設定',
  guild_mismatch: '辞書と会議のGuildが不一致',
  membership_unavailable: 'Guildメンバーを取得できない',
  guild_members_unavailable: 'Guildメンバーを取得できない',
  guild_lookup_failed: 'Guildメンバーの照会に失敗',
  not_member: '現在のGuild在籍を確認できない',
  unverified: '管理者がIDを未検証',
  disabled: '辞書で無効化',
  unregistered: '辞書に未登録',
  ambiguous: '別名が複数人に一致（不明）',
  identity_mismatch: 'username照合が不一致',
  empty_name: '別名が空',
  invalid_user_id: 'userIdが不正',
  no_dictionary: '別名辞書が未設定',
  assignment_proposed: '担当候補の提案のみ',
  assignment_conflict: '担当が矛盾（要確認）',
  assignment_not_explicit: '担当が明示されていない',
  assignment_unsupported: '根拠発言が明示担当を支持しない',
  evidence_missing: '根拠発言がない',
  evidence_stale: '根拠発言が失効・訂正済み',
  owner_missing: '担当者名がない',
  owner_not_in_evidence: '根拠発言に担当者名がない',
  self_user_id_missing: '自己申告の発話者IDがない',
  legacy_document: '旧形式（v1）の議事録は通知対象外',
  already_notified: '通知済み（同一アクション・同一担当者）',
  prior_revision_changed: '根拠が訂正済みのため既通知扱い（再送しない）',
  prior_delivery_unknown: '既送信が不明（再送しない）',
  prior_state_unknown: '過去の通知記録が不明（再送しない）',
};
export function mentionReasonLabel(reason) {
  if (!reason) return '理由なし';
  if (REASON_LABELS[reason]) return REASON_LABELS[reason];
  const prefixed = Object.keys(REASON_LABELS).find(key => reason.startsWith(key + '_'));
  return prefixed ? REASON_LABELS[prefixed] : reason;
}
const allowedFromActions = actions => [...new Set(actions.filter(action => action.notify && action.ownerUserId).map(action => action.ownerUserId))];
function describeAction({ state, item, actionIndex, dictionary, guildId, guildMembers, checkMembership: verify }) {
  const evidence = Array.isArray(item?.evidence) ? item.evidence : [];
  const first = evidence[0] ?? null;
  const utterance = first ? state?.utterances?.find(entry => entry.id === first.utteranceId) : null;
  const current = Boolean(utterance && utterance.final && utterance.source !== 'ai' && utterance.revision === first.revision);
  const assignment = normalizeAssignment(item?.assignment);
  const owner = typeof item?.owner === 'string' && item.owner.trim() ? item.owner.trim().slice(0, 120) : null;
  const base = { actionIndex, assignment, owner, ownerUserId: null, resolution: 'unknown', suppressReason: null, notify: false, notified: false, notifiedAt: null,
    assignmentEvidence: first ? { utteranceId: first.utteranceId, revision: first.revision } : null, evidence,
    utteranceIds: [...new Set(evidence.map(ref => ref.utteranceId))], textDigest: mentionTextDigest(item?.text), displayName: null };
  const suppress = (resolution, reason) => ({ ...base, resolution, suppressReason: reason });
  if (!dictionary) return suppress('no_dictionary', 'dictionary_missing');
  if (!first) return suppress('evidence_missing', 'evidence_missing');
  if (!current) return suppress('evidence_stale', 'evidence_stale');
  if (assignment === 'legacy') return suppress('legacy_document', 'legacy_document');
  if (assignment !== 'explicit') return suppress(assignment === 'conflict' ? 'assignment_conflict' : assignment === 'proposed' ? 'assignment_proposed' : 'assignment_not_explicit', assignment === 'conflict' ? 'assignment_conflict' : assignment === 'proposed' ? 'assignment_proposed' : 'assignment_not_explicit');
  const classification = classifyAssignment(utterance.text, { ownerName: owner, aliases: owner ? aliasesForOwner(dictionary, owner) : [] });
  if (classification.assignment !== 'explicit') return suppress('assignment_unsupported', `assignment_unsupported_${classification.reason}`);
  if (classification.self) {
    const speakerUserId = utterance.userId ?? null;
    if (!isSnowflake(speakerUserId)) return suppress('self_user_id_missing', 'self_user_id_missing');
    const identity = resolveUserId(dictionary, speakerUserId, { guildId, guildMembers, checkMembership: verify });
    const resolved = { ...base, ownerUserId: identity.userId ?? speakerUserId, resolution: identity.status, displayName: identity.displayName ?? owner };
    if (identity.status !== 'resolved') return { ...resolved, suppressReason: `self_${identity.status}` };
    return { ...resolved, notify: true };
  }
  if (!owner) return suppress('owner_missing', 'owner_missing');
  if (!classification.ownerPresent) return suppress('owner_not_in_evidence', 'owner_not_in_evidence');
  const identity = resolveAlias(dictionary, owner, { guildId, guildMembers, checkMembership: verify });
  const resolved = { ...base, ownerUserId: identity.userId ?? null, resolution: identity.status, displayName: identity.displayName ?? owner };
  if (identity.status !== 'resolved') return { ...resolved, suppressReason: identity.status };
  return { ...resolved, notify: true };
}
// 純粋関数: 通知対象・抑止理由・根拠ref・辞書版・allowlistを返す。I/OもDiscord送信もしない。
// state は会議状態（utterances/publications/minutesHistory）、dictionary は loadAliasDictionary() の
// dictionary、guildMembers は collectGuildMembership() の戻り値（null は取得不可）。
export function describeMentionPlan(state, version, dictionary, options = {}) {
  const guildId = options.guildId ?? state?.guildId ?? null;
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const guildMembers = options.guildMembers ?? null;
  const verifyMembership = options.checkMembership !== false;
  const priorPublications = Array.isArray(options.priorPublications) ? options.priorPublications : state?.publications ?? [];
  const document = canonicalMinutesDocument(version?.document);
  const actions = (document.actionItems || []).map((item, actionIndex) => describeAction({ state, item, actionIndex, dictionary, guildId, guildMembers, checkMembership: verifyMembership }));
  const plan = { schemaVersion: 1, guildId: isSnowflake(guildId) ? guildId : null, dictionaryVersion: dictionary?.version ?? null, resolvedAt: now,
    enabled: dictionary?.notificationDefaults?.enabled === true, reason: null, actions, allowedUserIds: [] };
  if (!dictionary) plan.reason = 'dictionary_missing';
  else if (!plan.enabled) plan.reason = 'notifications_disabled';
  else if (!isSnowflake(guildId)) plan.reason = 'guild_unconfigured';
  else if (dictionary.guildId !== guildId) plan.reason = 'guild_mismatch';
  if (plan.reason) for (const action of plan.actions) if (action.notify) { action.notify = false; action.suppressReason ??= plan.reason; }
  plan.allowedUserIds = allowedFromActions(plan.actions);
  // 既存の公開記録に基づく二重通知抑止（サーバー側の予約時にも同じ純関数を適用する）。
  const suppressed = applyMentionSuppression(plan, { publications: priorPublications, minutesHistory: state?.minutesHistory ?? [], now });
  return suppressed ?? plan;
}
// 通知候補のuserId（Guild在籍の照合前）。bot/publisherはこのIDだけをGuild APIで照合する。
export function candidateMentionUsers(state, version, dictionary, { guildId = state?.guildId } = {}) {
  if (!dictionary || dictionary.notificationDefaults?.enabled !== true || !guildId || dictionary.guildId !== guildId) return [];
  // 二重通知抑止より前の「識別子が解決できた担当者」を返す。ここで絞らないと、
  // 抑止済みアクションの理由表示がGuild照合不可に置き換わってしまう。
  const plan = describeMentionPlan(state, version, dictionary, { guildId, guildMembers: null, checkMembership: false, priorPublications: [], now: 0 });
  return [...new Set(plan.actions.filter(action => action.resolution === 'resolved' && action.ownerUserId).map(action => action.ownerUserId))];
}
// 非同期ラッパー: 辞書ファイル読込 → 候補IDのGuild照合 → describeMentionPlan。
// 辞書が無い/無効ならGuild照合をせず安全側の計画を返す。例外は通知なしに倒す。
export async function prepareMentionPlan({ state, version, dictionary, guild = null, guildId = state?.guildId ?? guild?.id ?? null, guildMembers, now, loadDictionary = loadAliasDictionary } = {}) {
  let resolvedDictionary = dictionary;
  let loadError = null;
  if (resolvedDictionary === undefined) { const loaded = loadDictionary(); resolvedDictionary = loaded.dictionary; loadError = loaded.error; }
  if (!resolvedDictionary) return describeMentionPlan(state, version, null, { guildId, now, checkMembership: false });
  if (resolvedDictionary.notificationDefaults?.enabled !== true) return describeMentionPlan(state, version, resolvedDictionary, { guildId, now, checkMembership: false });
  let membership = guildMembers ?? null;
  let verifyMembership = true;
  if (membership === null) {
    const candidates = candidateMentionUsers(state, version, resolvedDictionary, { guildId });
    if (candidates.length) { if (guild) membership = await collectGuildMembership(guild, candidates); }
    // 通知候補が無い場合はGuild照会をせず、識別子解決と二重通知抑止の理由をそのまま返す。
    else verifyMembership = false;
  }
  return describeMentionPlan(state, version, resolvedDictionary, { guildId, guildMembers: membership, checkMembership: verifyMembership, now });
}
export function snapshotMentionPlan(plan) {
  const normalized = applyMentionSuppression(plan, { publications: [], minutesHistory: [] });
  return normalized;
}
const evidenceLabel = action => {
  const first = action.assignmentEvidence ?? action.evidence?.[0];
  if (!first) return '根拠なし';
  const short = String(first.utteranceId).slice(0, 8);
  return `${short}@${first.revision}`;
};
const maskedUserId = userId => isSnowflake(userId) ? `****${userId.slice(-4)}` : '不明';
// プレビュー用: 通知対象は表示名で示し、生のuserIdは別行でマスクする（本文へは出さない）。
export function mentionPlanPreview(plan) {
  if (!plan) return '担当メンション：通知なし（計画を作成できませんでした）。';
  const lines = [];
  const enabled = plan.enabled === true && !plan.reason;
  const targets = (plan.actions || []).filter(action => action.notify);
  if (targets.length) {
    lines.push('担当メンション（dry-run・送信しません）');
    for (const action of targets) lines.push(`- 通知対象：${action.displayName || action.owner || '担当者'}（根拠: ${evidenceLabel(action)}／アクション${action.actionIndex + 1}／明示担当・未確認）`);
    lines.push(`- 通知先ID（マスク）: ${targets.map(action => maskedUserId(action.ownerUserId)).join('、')}`);
  } else lines.push(`担当メンション：通知対象なし${enabled ? '' : `（${mentionReasonLabel(plan.reason)}）`}。`);
  const suppressed = (plan.actions || []).filter(action => !action.notify && action.suppressReason);
  for (const action of suppressed.slice(0, 10)) lines.push(`- 抑止: アクション${action.actionIndex + 1} ${action.owner ? `（${action.owner}）` : ''}：${mentionReasonLabel(action.suppressReason)}`);
  lines.push(`別名辞書：${plan.dictionaryVersion ? `v${plan.dictionaryVersion}` : '未読込'}／通知${enabled ? '有効' : '無効'}`);
  return lines.join('\n');
}
// 公開本文の描画に使う actionIndex → 通知判定 の索引。
export function mentionPlanIndex(plan) {
  const map = new Map();
  for (const action of plan?.actions || []) map.set(action.actionIndex, action);
  return map;
}
