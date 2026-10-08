import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { keyFor } from './models.js';

export const sttModels = [
  { model: 'gpt-transcribe', label: 'GPT Transcribe（区切り後に認識・低コスト）', usdPerMinute: .0045 },
  { model: 'gpt-live-transcribe', label: 'GPT Live Transcribe（逐次表示）', usdPerMinute: .017 },
  { model: 'gpt-realtime-whisper', label: 'GPT Realtime Whisper（逐次表示）', usdPerMinute: .017 },
];
export const defaultSttModel = 'gpt-transcribe';
export const ttsModel = 'gpt-4o-mini-tts';

// item_idとcommit順を結び付け、最終結果の到着順で会話を並べ替えない。
// 時刻は端末から送ったPCMの境界。単語の時刻や話者をモデルから得たものではない。
export class TranscriptAssembler {
  constructor(emit, prefix = randomUUID()) { this.emit = emit; this.prefix = prefix; this.pending = []; this.items = new Map(); this.currentSpan = { startMs: 0, endMs: 0 }; }
  commit(span) { this.pending.push(span); }
  consume(event) {
    if (!event.item_id) return;
    let item = this.items.get(event.item_id);
    if (event.type === 'input_audio_buffer.committed') {
      const span = this.pending.shift();
      if (!span) throw new Error('文字起こしの発言順を確認できません。');
      item ??= { text: '', final: false };
      Object.assign(item, span, { mapped: true }); this.items.set(event.item_id, item);
      if (item.text.trim()) this.publish(event.item_id, item);
      return;
    }
    if (!['conversation.item.input_audio_transcription.delta', 'conversation.item.input_audio_transcription.completed'].includes(event.type)) return;
    item ??= { text: '', final: false, ...this.currentSpan, mapped: false };
    // 完了後に遅延したdeltaが来ても、確定した内容を暫定へ戻さない。
    if (item.final) return;
    if (event.type.endsWith('.completed')) { item.text = event.transcript ?? ''; item.final = true; }
    else item.text += event.delta ?? '';
    this.items.set(event.item_id, item);
    if (!item.mapped) item.endMs = this.currentSpan.endMs;
    if (item.text.trim()) this.publish(event.item_id, item);
  }
  publish(id, item) {
    this.emit({ id: `${this.prefix}-${id}`, text: item.text, final: item.final && item.mapped, speaker: null, startMs: item.startMs, endMs: item.endMs, source: 'openai' });
  }
}

export function transcriptionConfig(model) {
  if (!sttModels.some(m => m.model === model)) throw new Error('対応していない文字起こしモデルです。');
  const transcription = model === 'gpt-realtime-whisper' ? { model, language: 'ja', delay: 'medium' } : { model, languages: ['ja'] };
  return { type: 'session.update', session: { type: 'transcription', audio: { input: { format: { type: 'audio/pcm', rate: 24000 }, transcription, turn_detection: null } } } };
}

export function connectStt({ emit, onReady, onError, onClose, onUsage = () => {}, model = defaultSttModel, WebSocketImpl = WebSocket }) {
  const config = transcriptionConfig(model);
  const assembler = new TranscriptAssembler(emit);
  const ws = new WebSocketImpl('wss://api.openai.com/v1/realtime?intent=transcription', { headers: { Authorization: `Bearer ${keyFor('openai')}` }, handshakeTimeout: 10000 });
  let ready = false, closing = false, failed = false, frames = 0, boundary = 0, pendingBytes = 0, hasSpeech = false, active = false, committedMs = 0;
  const inFlight = new Set();
  let closeTimer;
  const fail = message => { if (!failed && !closing) { failed = true; onError(new Error(message)); ws.terminate(); } };
  const setupTimer = setTimeout(() => fail('OpenAI文字起こしの設定がタイムアウトしました。'), 12000);
  function send(event) { ws.send(JSON.stringify(event)); }
  function commit() {
    if (!ready || pendingBytes < 4800 || !hasSpeech) return false;
    const endMs = frames / 24;
    assembler.commit({ startMs: boundary / 24, endMs });
    committedMs += endMs - boundary / 24;
    boundary = frames; pendingBytes = 0; hasSpeech = active;
    assembler.currentSpan = { startMs: boundary / 24, endMs: endMs };
    send({ type: 'input_audio_buffer.commit' }); return true;
  }
  function clear() { send({ type: 'input_audio_buffer.clear' }); boundary = frames; pendingBytes = 0; assembler.currentSpan = { startMs: boundary / 24, endMs: frames / 24 }; }
  function finishIfDone() {
    if (closing && assembler.pending.length === 0 && inFlight.size === 0) ws.close();
  }
  ws.on('open', () => send(config));
  ws.on('message', data => {
    if (failed) return;
    try {
      const event = JSON.parse(data.toString());
      if (event.type === 'error' || event.type === 'conversation.item.input_audio_transcription.failed') { fail('OpenAI文字起こしに失敗しました。モデルの利用権限・残高を確認してください。'); return; }
      if (event.type === 'session.updated') { clearTimeout(setupTimer); ready = true; onReady(); }
      if (event.type === 'input_audio_buffer.committed') inFlight.add(event.item_id);
      assembler.consume(event);
      if (event.type === 'conversation.item.input_audio_transcription.completed') inFlight.delete(event.item_id);
      finishIfDone();
    } catch { fail('OpenAI文字起こしの応答を処理できません。'); }
  });
  ws.on('error', () => fail('OpenAI文字起こしへ接続できません。'));
  ws.on('close', () => {
    clearTimeout(setupTimer); clearTimeout(closeTimer);
    const uploadedAudioSeconds = frames / 24000;
    onUsage({ provider: 'openai', kind: 'stt', model, uploadedAudioSeconds, committedAudioSeconds: committedMs / 1000,
      estimatedUsd: uploadedAudioSeconds / 60 * sttModels.find(m => m.model === model).usdPerMinute,
      estimateBasis: '送信した音声時間×2026-10-08公開単価。請求額ではない', outcome: failed ? 'failed_billing_unknown' : 'closed' });
    onClose();
  });
  return {
    send(buffer) {
      if (!ready || closing || ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > 512000) throw new Error('音声送信が追いついていません。');
      if (buffer.length % 2) throw new Error('PCM音声の長さが不正です。');
      frames += buffer.length / 2; pendingBytes += buffer.length;
      assembler.currentSpan.endMs = frames / 24;
      send({ type: 'input_audio_buffer.append', audio: buffer.toString('base64') });
      if (pendingBytes >= 48000 * 12 && hasSpeech && active) commit();
      // 長い無音を次の発言へ蓄積しない。先頭の検知遅延用に最大2秒は残す。
      else if (pendingBytes >= 48000 * 2 && !hasSpeech && !active) clear();
    },
    voice(value) { active = value; if (value) hasSpeech = true; else commit(); },
    end() {
      if (closing) return;
      if (!ready) { closing = true; ws.terminate(); return; }
      active = false; commit(); closing = true;
      closeTimer = setTimeout(() => { onError(new Error('最後の文字起こしが時間内に確定しませんでした。')); ws.terminate(); }, 10000);
      finishIfDone();
    },
    abort() { closing = true; ws.terminate(); },
  };
}

// Speech APIのPCMを逐次再生する。ネットワーク境界で16bitサンプルが分割される場合を扱う。
export function synthesize({ text, onChunk, onDone, onError, fetchImpl = fetch }) {
  const abort = new AbortController();
  let reader, cancelled = false;
  void (async () => {
    try {
      const response = await fetchImpl('https://api.openai.com/v1/audio/speech', {
        method: 'POST', headers: { authorization: `Bearer ${keyFor('openai')}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: ttsModel, voice: process.env.WAIGAYA_OPENAI_VOICE || 'marin', input: text, response_format: 'pcm', instructions: '日本語で、落ち着いた短い進行補助として、入力文をそのまま読み上げてください。' }),
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30000)]),
      });
      if (cancelled) { await response.body?.cancel(); return; }
      if (!response.ok) throw new Error(`OpenAI音声生成: HTTP ${response.status}（利用権限・残高を確認）`);
      if (!response.body) throw new Error('OpenAI音声生成から音声を受信できません。');
      reader = response.body.getReader(); let tail = Buffer.alloc(0);
      while (!cancelled) {
        const { value, done } = await reader.read(); if (cancelled) return; if (done) break;
        const buffer = Buffer.concat([tail, Buffer.from(value)]), length = buffer.length - buffer.length % 2;
        tail = buffer.subarray(length); if (length) onChunk(buffer.subarray(0, length));
      }
      if (tail.length) throw new Error('OpenAIのPCM音声が途中で終了しました。');
      if (!cancelled) onDone();
    } catch (e) {
      if (!cancelled) onError(new Error(e.message?.startsWith('OpenAI') ? e.message : 'OpenAI音声生成へ接続できません（タイムアウトを含む）。'));
    } finally { reader?.releaseLock(); }
  })();
  return { abort() { cancelled = true; abort.abort(); void reader?.cancel().catch(() => {}); } };
}
