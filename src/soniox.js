import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';

// 確定トークンは一度だけ追加、暫定トークンは毎回置換する。
// endpoint又は話者変更で発言を区切り、同じ発言IDへの更新として渡す。
export class TokenAssembler {
  constructor(emit, prefix = randomUUID()) { this.emit = emit; this.prefix = prefix; this.index = 0; this.final = []; this.lastPreview = null; }
  get id() { return `${this.prefix}-${this.index}`; }
  describe(tokens, final) {
    return { id: this.id, text: tokens.map(t => t.text).join(''), final, speaker: tokens.find(t => t.speaker !== undefined)?.speaker?.toString() ?? null,
      startMs: tokens.find(t => Number.isFinite(t.start_ms))?.start_ms ?? null,
      endMs: tokens.findLast(t => Number.isFinite(t.end_ms))?.end_ms ?? null, source: 'soniox' };
  }
  flush() {
    if (this.final.length) this.emit(this.describe(this.final, true));
    this.final = []; this.lastPreview = null; this.index++;
  }
  consume(response) {
    const pending = [];
    for (const t of response.tokens ?? []) {
      if (t.text === '<end>' || t.text === '<fin>') { if (t.is_final) this.flush(); continue; }
      if (!t.text || t.translation_status === 'translation') continue;
      if (t.is_final) {
        const prev = this.final.findLast(v => v.speaker !== undefined);
        if (prev && t.speaker !== undefined && prev.speaker !== t.speaker) this.flush();
        this.final.push(t);
      } else pending.push(t);
    }
    if (this.final.length || pending.length) {
      const next = this.describe([...this.final, ...pending], false);
      if (JSON.stringify(next) !== this.lastPreview) { this.emit(next); this.lastPreview = JSON.stringify(next); }
    }
    if (response.finished) this.flush();
  }
}

export function connectStt({ emit, onReady, onError, onClose, sampleRate = 16000 }) {
  const ws = new WebSocket('wss://stt-rt.soniox.com/transcribe-websocket', { headers: { Authorization: `Bearer ${process.env.SONIOX_API_KEY}` }, handshakeTimeout: 10000 });
  const assembler = new TokenAssembler(emit);
  ws.on('open', () => {
    ws.send(JSON.stringify({ model: 'stt-rt-v5', audio_format: 'pcm_s16le', sample_rate: sampleRate, num_channels: 1,
      language_hints: ['ja'], enable_speaker_diarization: true, enable_endpoint_detection: true }));
    onReady();
  });
  ws.on('message', data => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.error_code !== undefined) { onError(new Error(`Soniox STT: ${msg.error_code}`)); ws.close(); return; }
      assembler.consume(msg);
    } catch { onError(new Error('Soniox STT応答の処理に失敗しました。')); ws.close(); }
  });
  ws.on('error', () => onError(new Error('Soniox STTへ接続できません。')));
  ws.on('close', onClose);
  return {
    send(buffer) { if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > 256000) throw new Error('音声送信が追いついていません。'); ws.send(buffer); },
    end() { if (ws.readyState === WebSocket.OPEN) ws.send(''); else ws.terminate(); },
    abort() { ws.terminate(); },
  };
}

// PCMを逐次渡す。中断時は接続も切り、生成を継続しない。
export function synthesize({ text, onChunk, onDone, onError }) {
  const stream = randomUUID();
  const ws = new WebSocket('wss://tts-rt.soniox.com/tts-websocket', { headers: { Authorization: `Bearer ${process.env.SONIOX_API_KEY}` }, handshakeTimeout: 10000 });
  let settled = false;
  const fail = message => { if (!settled) { settled = true; onError(new Error(message)); ws.terminate(); } };
  const timer = setTimeout(() => fail('Soniox TTSの生成がタイムアウトしました。'), 30000);
  ws.on('open', () => {
    ws.send(JSON.stringify({ stream_id: stream, model: 'tts-rt-v2', language: 'ja', voice: process.env.SONIOX_VOICE, audio_format: 'pcm_s16le', sample_rate: 24000 }));
    ws.send(JSON.stringify({ stream_id: stream, text, text_end: true }));
  });
  ws.on('message', data => {
    if (settled) return;
    try {
      const msg = JSON.parse(data.toString());
      if (msg.error_code !== undefined) { fail(`Soniox TTS: ${msg.error_code}`); return; }
      if (msg.audio) onChunk(Buffer.from(msg.audio, 'base64'));
      if (msg.terminated) { settled = true; clearTimeout(timer); onDone(); ws.close(); }
    } catch { fail('Soniox TTS応答の処理に失敗しました。'); }
  });
  ws.on('error', () => fail('Soniox TTSへ接続できません。'));
  ws.on('close', () => { clearTimeout(timer); if (!settled) fail('Soniox TTSの接続が途中で切れました。'); });
  return { abort() { settled = true; clearTimeout(timer); ws.terminate(); } };
}
