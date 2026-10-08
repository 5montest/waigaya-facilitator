const normalized = text => text.replace(/[\s、。！？!?…・]/g, '');
const acknowledgement = /^(うん|はい|ええ|ああ|あー|えー|えっと|なるほど|そうですね|そうだね|了解|そうか)$/;

export class AutonomousFacilitator {
  constructor(bridge, { clock = Date.now, quietMs = 1800, cooldownMs = 45000, minChars = 60, minTurns = 3, available = () => true, onFailure = () => {} } = {}) {
    this.bridge = bridge; this.clock = clock; this.quietMs = quietMs; this.cooldownMs = cooldownMs;
    this.minChars = minChars; this.minTurns = minTurns; this.available = available; this.onFailure = onFailure;
    this.considered = new Map(); this.nextAt = 0; this.busy = false; this.closed = false;
    this.abort = new AbortController();
  }
  start() { this.timer = setInterval(() => void this.tick(), 250); this.timer.unref?.(); }
  async tick() {
    const state = this.bridge.state, now = this.clock();
    if (this.closed || this.busy || !state?.autonomous || state.mode === 'minutes' || state.quiet || (state.guildId && state.status !== 'recording') || !state.inputHealthy || state.speaking || state.playback || state.reply || state.request?.status === 'thinking' || !this.available() || now < this.nextAt || now - state.lastVoiceAt < this.quietMs) return false;
    const changed = state.utterances.filter(u => u.final && this.considered.get(u.id) !== u.revision);
    const meaningful = changed.filter(u => { const text = normalized(u.text); return text.length >= 5 && !acknowledgement.test(text); });
    if (!meaningful.length || (meaningful.length < this.minTurns && meaningful.reduce((sum, u) => sum + normalized(u.text).length, 0) < this.minChars)) return false;
    this.busy = true; this.nextAt = now + this.cooldownMs;
    for (const u of state.utterances.filter(u => u.final)) this.considered.set(u.id, u.revision);
    try {
      const answer = await this.bridge.ask({ automatic: true, signal: this.abort.signal });
      const reply = answer.reply;
      if (!reply || this.closed || !this.bridge.state.autonomous) return false;
      if (reply.action === 'hold') {
        if (this.bridge.state.reply?.requestId === reply.requestId) await this.bridge.api(this.bridge.path + '/events', { type: 'discard' });
        return false;
      }
      if (answer.aiTurns.some(t => t.outcome === 'completed' && normalized(t.text) === normalized(reply.text))) {
        if (this.bridge.state.reply?.requestId === reply.requestId) await this.bridge.api(this.bridge.path + '/events', { type: 'discard' });
        return false;
      }
      await this.bridge.speakReply(reply.requestId, { quietMs: this.quietMs, signal: this.abort.signal });
      return true;
    } catch (error) {
      if (!this.closed && this.bridge.state?.autonomous) this.onFailure(error);
      return false;
    } finally { this.busy = false; }
  }
  close() { this.closed = true; clearInterval(this.timer); this.abort.abort(); }
}
