import { UserError as Error } from './errors.js';
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
    guildId: null, voiceChannelId: null, ownerId: null, participantIds: [], outputChannelId: null, outputRevision:0,destinationHistory:[],
    emptySince: null, autoFinishAfterMs: 180000, recordingNoticeSentAt: null,
    minutesStatus: 'none', minutesVersion: 0, minutesHistory: [], publications: [], voiceRequests: [], fixedOperation:false, publicationPolicy:'human_review', completionJob:null, gaps: [], health: {}, lastError: null };
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
    if(state.fixedOperation&&state.quietBeforeRecovery!==undefined){state.quiet=state.quietBeforeRecovery;delete state.quietBeforeRecovery;state.autonomous=state.mode==='facilitator'&&!state.quiet;}
    state.status = 'recording'; state.health.connection = 'ok'; state.lastError = null;
  } else if (action === 'empty') {
    if (!['recording', 'paused'].includes(state.status)) return false;
    state.emptyPreviousStatus = state.status; state.status = 'empty_grace'; state.emptySince = now;
  } else if (action === 'returned') {
    if (state.status !== 'empty_grace') return false;
    state.status = state.emptyPreviousStatus === 'paused'||details.forcePaused ? 'paused' : 'recording'; state.emptySince = null;
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

export const statusLabels = { created:'開始前',recording:'記録中',paused:'記録を一時停止',empty_grace:'全員退出・復帰待ち',finalizing:'記録終了・議事録生成中',completed:'記録終了',finalize_failed:'記録終了・議事録生成失敗' };
export const minutesLabels = { none:'未作成',generating:'生成中',draft:'下書き・未確認',needs_review:'要再確認',approved:'操作担当者が確認済み',failed:'生成失敗' };
export const healthLabels = { stt:'文字起こし',tts:'AI音声',connection:'接続',storage:'保存',discord_post:'Discord送信',file_export:'ファイル出力' };
