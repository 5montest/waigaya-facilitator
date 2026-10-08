export const modes = { minutes: '議事録のみ', assistant: '呼びかけた時だけ', facilitator: 'AIワイガヤ' };
export const activeStatuses = ['created', 'recording', 'paused', 'empty_grace'];
export const isMeaningful = text => {
  const value = text.replace(/[\s、。！？!?…・]/g, '');
  return value.length >= 5 && !/^(うん|はい|ええ|ああ|あー|えー|えっと|なるほど|そうですね|そうだね|了解|そうか)$/.test(value);
};
export function canSpeak(state) {
  return state.mode !== 'minutes' && !state.quiet && (!state.guildId || state.status === 'recording');
}
export function initialMeeting(clock = Date.now) {
  return { mode: 'assistant', status: 'created', quiet: false, startedAt: null, endedAt: null, endReason: null,
    guildId: null, voiceChannelId: null, ownerId: null, participantIds: [], outputChannelId: null,
    emptySince: null, autoFinishAfterMs: 180000, recordingNoticeSentAt: null,
    minutesStatus: 'none', minutesVersion: 0, minutesHistory: [], publications: [], gaps: [], health: {}, lastError: null };
}
export function transition(state, action, now = Date.now(), details = {}) {
  const active = activeStatuses.includes(state.status);
  if (action === 'start') {
    if (state.status !== 'created') throw new Error('開始済みです。/waigaya status で状態を確認してください。');
    if (state.guildId && !state.recordingNoticeSentAt) throw new Error('記録開始の通知が必要です。');
    state.status = 'recording'; state.startedAt ??= now;
  } else if (action === 'pause') {
    if (!['recording', 'empty_grace'].includes(state.status)) throw new Error('記録中のみ一時停止できます。');
    state.status = 'paused'; state.emptySince = null;
  } else if (action === 'resume') {
    if (state.status !== 'paused') throw new Error('一時停止中のみ再開できます。');
    state.status = 'recording'; state.health.connection = 'ok'; state.lastError = null;
  } else if (action === 'empty') {
    if (state.status !== 'recording') return false;
    state.status = 'empty_grace'; state.emptySince = now;
  } else if (action === 'returned') {
    if (state.status !== 'empty_grace') return false;
    state.status = 'recording'; state.emptySince = null;
  } else if (action === 'finish') {
    if (!active && state.status !== 'finalize_failed') return false;
    state.status = 'finalizing'; state.endedAt ??= now; state.emptySince = null;
    state.endReason ??= details.reason || 'manual'; state.minutesStatus = 'generating';
  } else throw new Error('会議の操作が不正です。');
  return true;
}

// Timer callbacks are tied to this instance; callers close it before another meeting starts.
export class EmptyGrace {
  constructor({ onEmpty, onReturn, onFinish, clock = Date.now, graceMs = 180000, onError = () => {} }) {
    Object.assign(this, { onEmpty, onReturn, onFinish, clock, graceMs, onError });
    this.emptyAt = null; this.closed = false; this.pending = Promise.resolve();
  }
  members(count) {
    this.pending = this.pending.then(async () => {
      if (this.closed) return;
      if (count === 0 && this.emptyAt === null) { this.emptyAt = this.clock(); await this.onEmpty(); }
      else if (count > 0 && this.emptyAt !== null) { this.emptyAt = null; await this.onReturn(); }
    }).catch(error => this.onError(error));
    return this.pending;
  }
  async tick() {
    await this.pending;
    if (this.closed || this.emptyAt === null || this.clock() - this.emptyAt < this.graceMs) return false;
    this.closed = true; clearInterval(this.timer); await this.onFinish(); return true;
  }
  start() { this.timer = setInterval(() => void this.tick().catch(this.onError), 1000); this.timer.unref(); }
  close() { this.closed = true; clearInterval(this.timer); }
}
