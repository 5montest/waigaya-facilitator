import { UserError as Error, UserError } from './errors.js';
import { randomUUID } from 'node:crypto';
import { initialMeeting, transition, modes, canSpeak, isMeaningful } from './meeting.js';

// 音声状態と意味内容の版を分ける。ネットワークを待たずに同期的に判定する。
export class Controller {
  constructor(saved = {}, clock = Date.now) {
    this.clock = clock;
    this.state = {
      ...initialMeeting(clock), id: randomUUID(), topic: 'ワイガヤ', phase: 'diverge', revision: 0,
      utterances: [], decisions: [], aiTurns: [], usage: [], candidate: null,
      request: null, reply: null, autonomous: false, speaking: false, inputHealthy: false, lastVoiceAt: clock(),
      outputEpoch: 0, voiceEpoch: 0, playback: null, error: null, ...saved,
    };
  }
  snapshot() { return structuredClone(this.state); }
  invalidate({ preserveReply = false } = {}) {
    this.state.candidate = null;
    if (!(preserveReply && ['reply', 'autonomous', 'voice_request'].includes(this.state.request?.mode))) this.stop('context_changed');
    if (!(preserveReply && ['reply', 'autonomous', 'voice_request'].includes(this.state.request?.mode))) {
      this.state.reply = null;
      if (this.state.request) this.state.request.status = 'needs_refresh';this.voiceRequestStatus('cancelled');
    }
    this.state.revision++;
    if (preserveReply && ['autonomous','voice_request'].includes(this.state.request?.mode)) { this.state.request.revision = this.state.revision; if (this.state.reply) this.state.reply.snapshotRevision = this.state.revision; }
  }
  configure({ topic, phase, autonomous, mode, quiet }) {
    if (topic !== undefined && (typeof topic !== 'string' || !topic.trim() || topic.length > 200)) throw new Error('議題を入力してください。');
    if (phase !== undefined && !['diverge', 'organize', 'decide'].includes(phase)) throw new Error('議論の段階が不正です。');
    if (autonomous !== undefined && typeof autonomous !== 'boolean') throw new Error('自律発言の設定が不正です。');
    if (mode !== undefined && !Object.hasOwn(modes, mode)) throw new Error('会議モードが不正です。');
    if (quiet !== undefined && typeof quiet !== 'boolean') throw new Error('音声停止の設定が不正です。');
    if (mode !== undefined || quiet !== undefined) {
      this.invalidate();
      if (mode !== undefined) { this.state.mode = mode; this.state.quiet = false; this.state.autonomous = mode === 'facilitator'; }
      if (quiet !== undefined) { this.state.quiet = quiet; if (quiet) this.state.autonomous = false; }
    }
    if ((topic !== undefined && topic !== this.state.topic) || (phase !== undefined && phase !== this.state.phase) || (autonomous !== undefined && autonomous !== this.state.autonomous)) {
      this.invalidate();
      if (topic !== undefined) this.state.topic = topic;
      if (phase !== undefined) this.state.phase = phase;
      if (autonomous !== undefined) this.state.autonomous = autonomous && this.state.mode === 'facilitator';
    }
  }
  lifecycle(action, details = {}) {
    if (transition(this.state, action, this.clock(), details)) { this.invalidate(); this.healthy(false); return true; }
    return false;
  }
  upsert({ id = randomUUID(), text, speaker = null, final = true, startMs, endMs, source = 'manual', userId = null, expectedRevision }) {
    if (typeof text !== 'string' || !text.trim() || text.length > 12000) throw new Error('発言は1〜12,000文字で入力してください。');
    if (typeof id !== 'string' || id.length > 150 || typeof final !== 'boolean') throw new Error('発言情報が不正です。');
    if (speaker !== null && (typeof speaker !== 'string' || speaker.length > 80)) throw new Error('話者情報が不正です。');
    if(userId!==null&&!/^\d{17,22}$/.test(userId))throw new Error('発話者IDが不正です。');
    const old = this.state.utterances.find(u => u.id === id);
    if (expectedRevision !== undefined && old?.revision !== expectedRevision) throw new Error('原発言の版が変わりました。再確認してください。');
    if (startMs === undefined) startMs = old?.startMs ?? null;
    if (endMs === undefined) endMs = old?.endMs ?? null;
    if (![startMs, endMs].every(v => v === null || (Number.isFinite(v) && v >= 0))) throw new Error('時刻が不正です。');
    if (old && old.text === text && old.final === final && old.speaker === speaker && old.startMs === startMs && old.endMs === endMs) return old;
    // 依頼への返答は依頼時点の確定発言を使う。追加・未確定発言の更新で検討を捨てない。
    // 確定発言の訂正は、回答の前提が変わるので取り消す。
    const preserveReply = (!old || !old.final) && (!['autonomous','voice_request'].includes(this.state.request?.mode) || !final || !isMeaningful(text));
    this.invalidate({ preserveReply });
    const next = { id, text, speaker, final, startMs, endMs, source: old?.source ?? source, userId:old?.userId??userId, revision: (old?.revision ?? 0) + 1, receivedAt: old?.receivedAt ?? this.clock() };
    if (old) Object.assign(old, next); else this.state.utterances.push(next);
    this.state.utterances.sort((a, b) => (a.startMs ?? a.receivedAt) - (b.startMs ?? b.receivedAt));
    return next;
  }
  voice(active) {
    this.state.speaking = active;
    if (active) {
      this.state.voiceEpoch++;
      this.state.lastVoiceAt = this.clock();
      this.state.candidate = null;
      this.stop('human_speaking');
      if (this.state.request && !['reply', 'autonomous', 'voice_request'].includes(this.state.request.mode)) this.state.request.status = 'needs_refresh';
    } else this.state.lastVoiceAt = this.clock();
  }
  healthy(value) {
    this.state.inputHealthy = value;
    if (!value) { this.state.voiceEpoch++; this.state.speaking = false; this.state.candidate = null; this.stop('input_lost'); }
  }
  beginRequest({ mode = 'live',voiceRequest } = {}) {
    const id = randomUUID();
    this.stop('new_request');
    this.state.candidate = null;
    this.state.request = { id, mode, status: 'thinking', revision: this.state.revision, createdAt: this.clock(),...(voiceRequest?{voiceRequest:structuredClone(voiceRequest)}:{}) };
    if(voiceRequest){this.state.voiceRequests??=[];this.state.voiceRequests.push({id,...structuredClone(voiceRequest),status:'thinking'});}
    this.state.error = null;
    return { requestId: id, mode, revision: this.state.revision, voiceEpoch: this.state.voiceEpoch, state: this.snapshot() };
  }
  accept(result, ticket) {
    const s = this.state;
    if (s.request?.id !== ticket.requestId || s.request.status !== 'thinking') return false;
    if (!['reply', 'autonomous', 'voice_request'].includes(ticket.mode) && (s.revision !== ticket.revision || s.voiceEpoch !== ticket.voiceEpoch)) return false;
    if (['autonomous','voice_request'].includes(ticket.mode) && s.request.revision !== s.revision) return false;
    if (['reply', 'autonomous', 'voice_request'].includes(ticket.mode)) {
      if (result.action !== 'hold' && !this.evidenceValid(result.evidence)) return false;
      s.request.status = 'ready';this.voiceRequestStatus('ready');
      s.reply = { ...structuredClone(result), requestId: ticket.requestId, snapshotRevision: s.revision, createdAt: this.clock(), topic: s.topic, expiresAt: this.clock() + (['autonomous','voice_request'].includes(ticket.mode) ? 15000 : 60000) };
      return true;
    }
    s.request.status = 'ready';
    if (result.action === 'hold') { s.candidate = null; return true; }
    if (s.speaking || !this.evidenceValid(result.evidence)) { s.request.status = 'needs_refresh'; return false; }
    s.candidate = { ...result, id: randomUUID(), contextRevision: s.revision, requestId: ticket.requestId, expiresAt: this.clock() + 15000 };
    return true;
  }
  voiceRequestStatus(status) { const item=this.state.voiceRequests?.find(v=>v.id===this.state.request?.id);if(item)item.status=status; }
  evidenceValid(refs) {
    return Array.isArray(refs) && refs.length > 0 && refs.every(r => this.state.utterances.some(u => u.id === r.utteranceId && u.revision === r.revision && u.final && u.source !== 'ai'));
  }
  expire() {
    if (this.state.reply && this.clock() >= this.state.reply.expiresAt) {
      this.state.reply = null;
      if (this.state.request) this.state.request.status = 'needs_refresh';
      return true;
    }
    if (this.state.candidate && this.clock() >= this.state.candidate.expiresAt) {
      this.state.candidate = null;
      if (this.state.request) this.state.request.status = 'needs_refresh';
      return true;
    }
    return false;
  }
  permit(candidateId) {
    if (!canSpeak(this.state)) throw new Error('このモード・状態ではAIは音声発言しません。');
    this.expire();
    const s = this.state, c = s.candidate;
    if (!c || c.id !== candidateId || c.contextRevision !== s.revision || !this.evidenceValid(c.evidence)) throw new Error('候補が更新・失効しました。再検討してください。');
    if (!s.inputHealthy || s.speaking || this.clock() - s.lastVoiceAt < 500) throw new Error('マイクの確認と、発話後500msの間が必要です。');
    const epoch = ++s.outputEpoch;
    s.playback = { epoch, candidateId, text: c.text, status: 'preparing', startedAt: null, heardMs: 0 };
    s.candidate = null;
    return { epoch, text: c.text };
  }
  permitReply(requestId) {
    this.expire();
    const s = this.state, reply = s.reply;
    if (!reply || reply.requestId !== requestId || s.request?.id !== requestId || s.request.status !== 'ready' || reply.action === 'hold' || !this.evidenceValid(reply.evidence)) throw new Error('返答が取り消し・更新されました。もう一度 /waigaya ask を使ってください。');
    if (['autonomous','voice_request'].includes(s.request.mode) && reply.snapshotRevision !== s.revision) throw new Error('自律候補の文脈が古くなりました。');
    if (!s.inputHealthy || s.speaking || this.clock() - s.lastVoiceAt < 500) throw new Error('人の発話が終わるのを待っています。');
    s.candidate = { ...reply, id: randomUUID(), contextRevision: s.revision, expiresAt: this.clock() + 15000 };
    const permit = this.permit(s.candidate.id);
    s.reply = null; // 再生を中断しても、古い返答を自動で再開しない。
    return permit;
  }
  played(epoch, heardMs = 0) {
    const p = this.state.playback;
    if (!p || epoch !== this.state.outputEpoch || p.epoch !== epoch || !this.state.inputHealthy || this.state.speaking) return false;
    p.status = 'playing';this.voiceRequestStatus('playing');
    p.startedAt ??= this.clock();
    p.heardMs = Math.max(p.heardMs, Math.min(60000, Math.max(0, heardMs)));
    return true;
  }
  stop(reason = 'manual', epoch = null) {
    const p = this.state.playback;
    if (epoch !== null && p?.epoch !== epoch) return;
    if (['manual', 'new_request', 'discarded', 'input_lost', 'server_restarted'].includes(reason)) {
      this.state.reply = null;
      if (['reply', 'autonomous', 'voice_request'].includes(this.state.request?.mode)) this.state.request.status = 'dismissed';
    }
    if(reason==='completed'||p||['manual','new_request','discarded','input_lost','server_restarted','context_changed'].includes(reason))this.voiceRequestStatus(reason==='completed'?'completed':'cancelled');
    this.state.outputEpoch++;
    if (p) {
      this.state.aiTurns.push({ ...p, finishedAt: this.clock(), outcome: reason });
      this.state.playback = null;
      if (this.state.request) this.state.request.status = reason === 'completed' ? 'completed' : 'needs_refresh';
    }
  }
  discard() {
    this.state.candidate = null;
    this.stop('discarded');
    if (this.state.request) this.state.request.status = 'dismissed';
  }
  confirmDecision({ text, evidence }) {
    if (typeof text !== 'string' || !text.trim() || text.length > 4000 || !this.evidenceValid(evidence)) throw new Error('決定の内容と、確定した根拠発言が必要です。');
    this.invalidate();
    this.state.decisions.push({ id: randomUUID(), text, evidence: structuredClone(evidence), confirmedBy: 'operator', confirmedAt: this.clock() });
  }
}
