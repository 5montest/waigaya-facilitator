import http from 'node:http';
import https from 'node:https';
import { X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { Controller } from './controller.js';
import { analyze, catalog, keyFor } from './models.js';
import { Store, markdown } from './store.js';
import { connectStt, synthesize, sttModels, defaultSttModel, ttsModel } from './openai-audio.js';
import { loadOpenAIKey } from './credentials.js';
import { requestAllowed } from './network.js';

const publicDir = resolve(dirname(fileURLToPath(import.meta.url)), '../public');
const staticFiles = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/capture.js': ['capture.js', 'text/javascript'], '/lan': ['lan.html', 'text/html'], '/lan.js': ['lan.js', 'text/javascript'] };
function json(res, status, value) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); }
async function readBody(req) {
  let body = '';
  for await (const c of req) { body += c; if (body.length > 100000) throw new Error('入力が大きすぎます。'); }
  return JSON.parse(body || '{}');
}

export function createApp({ store = new Store(), modelAnalyze = analyze, sttConnect = connectStt, ttsSynthesize = synthesize,
  access = { hosts: ['127.0.0.1', 'localhost'], networks: ['127.0.0.0/8', '::1/128'] }, tls, caCertificate, httpsUrl = null } = {}) {
  const sessions = new Map();
  const certificateFingerprint = caCertificate ? new X509Certificate(caCertificate).fingerprint256 : null;
  let appClosing = false;
  function session(id) {
    if (sessions.has(id)) return sessions.get(id);
    const saved = store.load(id);
    if (!saved) throw new Error('会議が見つかりません。');
    const c = new Controller(saved);
    c.stop('server_restarted'); c.healthy(false); c.state.candidate = null;
    if (c.state.request) c.state.request.status = 'needs_refresh';
    const r = { c, clients: new Set(), pending: null, tts: null, ttsEpoch: null, micOwner: null, heartbeatAt: 0 };
    sessions.set(id, r);
    save(r, 'restored');
    return r;
  }
  function send(ws, event) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event)); }
  function publish(r) { for (const ws of r.clients) send(ws, { type: 'state', state: r.c.snapshot() }); }
  function save(r, kind, payload = {}) {
    if (appClosing) return;
    if (r.pending && ((r.pending.mode !== 'reply' && (r.c.state.revision !== r.pending.revision || r.c.state.voiceEpoch !== r.pending.voiceEpoch)) || r.c.state.request?.id !== r.pending.requestId || r.c.state.request?.status !== 'thinking')) {
      r.pending.abort.abort(); r.pending = null;
    }
    if (r.tts && r.c.state.outputEpoch !== r.ttsEpoch) {
      r.tts.abort(); r.tts = null;
      r.c.state.usage.push({ provider: 'openai', model: ttsModel, kind: 'tts', outcome: 'cancelled_billing_unknown', receivedPcmBytes: r.ttsBytes ?? 0, estimatedUsd: null, at: Date.now() });
    }
    r.c.state.sequence = (r.c.state.sequence ?? 0) + 1;
    store.save(r.c.snapshot(), kind, payload); publish(r);
  }
  function originAllowed(req, write = false) {
    return requestAllowed(req, access, write);
  }
  const handleRequest = async (req, res) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self' blob:; frame-ancestors 'none'");
    try {
      if (!originAllowed(req, req.method !== 'GET')) { json(res, 403, { error: '許可されたLANの操作画面から利用してください。' }); return; }
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.method === 'GET' && staticFiles[url.pathname]) {
        const [file, mime] = staticFiles[url.pathname];
        res.writeHead(200, { 'content-type': `${mime}; charset=utf-8` }); res.end(await readFile(resolve(publicDir, file))); return;
      }
      if (url.pathname === '/lan-ca.crt' && req.method === 'GET' && caCertificate) {
        res.writeHead(200, { 'content-type': 'application/x-x509-ca-cert', 'content-disposition': 'attachment; filename="waigaya-lan-ca.crt"' }); res.end(caCertificate); return;
      }
      if (url.pathname === '/api/config' && req.method === 'GET') {
        json(res, 200, { models: catalog.filter(m => m.provider === 'openai').map(m => ({ ...m, configured: Boolean(keyFor('openai')) })), defaultModel: 'gpt-6.1-sol', audio: { provider: 'openai', configured: Boolean(keyFor('openai')), sampleRate: 24000, sttModels, defaultSttModel, ttsModel, voice: process.env.WAIGAYA_OPENAI_VOICE || 'marin', speakerDiarization: false }, connection: { httpsUrl, certificateUrl: caCertificate ? '/lan-ca.crt' : null, certificateFingerprint }, mode: 'manual', qualityVerified: false }); return;
      }
      if (url.pathname === '/api/sessions' && req.method === 'POST') {
        const c = new Controller();
        const r = { c, clients: new Set(), pending: null, tts: null, ttsEpoch: null, micOwner: null, heartbeatAt: 0 };
        sessions.set(c.state.id, r); save(r, 'created'); json(res, 201, c.snapshot()); return;
      }
      const match = url.pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})(?:\/(events|analyze|markdown|audit))?$/);
      if (!match) { json(res, 404, { error: '見つかりません。' }); return; }
      const r = session(match[1]), route = match[2];
      if (req.method === 'GET') {
        if (route === 'markdown') { res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'content-disposition': 'attachment; filename="waigaya.md"' }); res.end(markdown(r.c.state)); return; }
        json(res, 200, route === 'audit' ? store.events(match[1]) : r.c.snapshot()); return;
      }
      if (req.method !== 'POST' || !req.headers['content-type']?.startsWith('application/json')) throw new Error('JSONで操作してください。');
      const body = await readBody(req);
      if (route === 'events') {
        switch (body.type) {
          case 'utterance': r.c.upsert(body.utterance); break;
          case 'configure': r.c.configure(body); break;
          case 'discard': r.c.discard(); break;
          case 'stop': r.c.stop('manual'); break;
          case 'decision': r.c.confirmDecision(body); break;
          case 'audio_usage': {
            const u=body.usage,model=sttModels.find(m=>m.model===u?.model);
            if(u?.provider!=='openai'||u.kind!=='stt'||!model||!Number.isFinite(u.uploadedAudioSeconds)||u.uploadedAudioSeconds<0||u.uploadedAudioSeconds>86400)throw new Error('音声の使用量が不正です。');
            r.c.state.usage.push({provider:'openai',kind:'stt',model:model.model,uploadedAudioSeconds:u.uploadedAudioSeconds,
              estimatedUsd:u.outcome==='failed_billing_unknown'?null:u.uploadedAudioSeconds/60*model.usdPerMinute,
              outcome:u.outcome==='failed_billing_unknown'?'failed_billing_unknown':'closed',estimateBasis:'送信音声時間×公開単価。請求額ではない',at:Date.now()});
            break;
          }
          default: throw new Error('操作が不正です。');
        }
        save(r, body.type, body); json(res, 200, r.c.snapshot()); return;
      }
      if (route === 'analyze') {
        if (body.provider !== 'openai') throw new Error('MVPではOpenAIのモデルを選んでください。');
        if (body.mode !== undefined && !['live', 'reply'].includes(body.mode)) throw new Error('返答のモードが不正です。');
        if (body.trigger !== undefined && body.trigger !== 'auto') throw new Error('依頼の種類が不正です。');
        if (body.trigger === 'auto' && (!r.c.state.autonomous || body.mode !== 'reply')) throw new Error('自律発言は停止中です。');
        if (!r.c.state.utterances.some(u => u.final)) throw new Error('確定した発言を追加してください。');
        r.pending?.abort.abort();
        const ticket = r.c.beginRequest({ mode: body.mode || 'live' });
        const pending = { ...ticket, abort: new AbortController() }; r.pending = pending;
        save(r, 'analysis_requested', { provider: body.provider, model: body.model, mode: ticket.mode, trigger: body.trigger || 'manual' });
        // モデル処理中も音声入力・停止操作を受け付ける。
        void (async () => {
          try {
            const response = await modelAnalyze({ provider: body.provider, model: body.model, state: ticket.state, requestedReply: ticket.mode === 'reply' && body.trigger !== 'auto', autonomous: body.trigger === 'auto', signal: pending.abort.signal });
            r.c.state.usage.push({ ...response.usage, outcome: 'received', at: Date.now() });
            const accepted = r.c.accept(response.result, ticket);
            if (accepted && r.c.state.revision === ticket.revision) r.c.state.notes = { revision: ticket.revision, items: response.result.notes };
            save(r, accepted ? 'analysis_ready' : 'analysis_stale', { requestId: ticket.requestId, result: response.result, usage: response.usage });
          } catch (e) {
            const aborted = pending.abort.signal.aborted;
            r.c.state.usage.push({ ...(e.usage ?? { provider: body.provider, model: body.model, estimatedUsd: null }), outcome: aborted ? 'cancelled_billing_unknown' : 'failed', at: Date.now() });
            if (r.c.state.request?.id === ticket.requestId && r.c.state.request.status !== 'dismissed') { r.c.state.request.status = aborted ? 'needs_refresh' : 'failed'; if (!aborted) r.c.state.error = e.message; }
            save(r, aborted ? 'analysis_cancelled' : 'analysis_failed', { requestId: ticket.requestId });
          } finally { if (r.pending === pending) r.pending = null; }
        })();
        json(res, 202, r.c.snapshot()); return;
      }
      json(res, 404, { error: '見つかりません。' });
    } catch (e) { json(res, 400, { error: e.message }); }
  };
  const server = http.createServer(handleRequest);
  const secureServer = tls ? https.createServer(tls, handleRequest) : null;

  const wss = new WebSocketServer({ noServer: true, maxPayload: 100000 });
  const upgrade = (req, socket, head) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname !== '/live' || !originAllowed(req, true)) { socket.destroy(); return; }
    try {
      const r = session(url.searchParams.get('session'));
      wss.handleUpgrade(req, socket, head, ws => attach(ws, r));
    } catch { socket.destroy(); }
  };
  server.on('upgrade', upgrade);
  secureServer?.on('upgrade', upgrade);
  function attach(ws, r) {
    r.clients.add(ws); send(ws, { type: 'state', state: r.c.snapshot() });
    let stt = null, healthy = false, closing = false;
    const lost = () => { healthy = false; if (r.micOwner === ws) { r.c.healthy(false); save(r, 'microphone_lost'); } };
    ws.on('message', (raw, binary) => {
      let event;
      try {
        if (binary) {
          if (!stt || !healthy || r.micOwner !== ws) return;
          stt.send(raw); r.heartbeatAt = Date.now(); return;
        }
        event = JSON.parse(raw.toString());
        if (event.type === 'mic_start') {
          if (r.micOwner && r.micOwner !== ws) throw new Error('別の画面がマイクを使用しています。');
          if (stt) throw new Error('マイクは起動済みです。');
          r.micOwner = ws; r.heartbeatAt = Date.now(); closing = false; r.c.healthy(false);
          if (event.transcribe) {
            if (!keyFor('openai')) throw new Error('OpenAIのキーが未設定です。');
            const audioStartedAt = Date.now();
            stt = sttConnect({
              model: event.sttModel || defaultSttModel,
              emit: u => { const aligned = { ...u, startMs: u.startMs === null ? null : audioStartedAt + u.startMs, endMs: u.endMs === null ? null : audioStartedAt + u.endMs }; r.c.upsert(aligned); save(r, 'transcript', aligned); },
              onReady: () => { if (closing) return; healthy = true; r.c.healthy(true); save(r, 'microphone_ready'); send(ws, { type: 'mic_ready', transcribe: true }); },
              onError: e => { lost(); send(ws, { type: 'error', error: e.message }); },
              onClose: () => { lost(); stt = null; send(ws, { type: 'mic_closed' }); },
              onUsage: usage => { r.c.state.usage.push({ ...usage, at: Date.now() }); save(r, 'stt_usage', usage); },
            });
          } else { healthy = true; r.c.healthy(true); save(r, 'vad_only_ready'); send(ws, { type: 'mic_ready', transcribe: false }); }
        } else if (event.type === 'heartbeat' && r.micOwner === ws) {
          r.heartbeatAt = Date.now();
        } else if (event.type === 'vad' && r.micOwner === ws && healthy) {
          if (typeof event.active !== 'boolean') throw new Error('音声状態が不正です。');
          r.c.voice(event.active); save(r, event.active ? 'voice_start' : 'voice_end');
          stt?.voice(event.active);
        } else if (event.type === 'mic_stop' && r.micOwner === ws) {
          closing = true; lost(); stt?.end(); r.micOwner = null;
        } else if (event.type === 'speak' || event.type === 'speak_reply') {
          if (r.micOwner !== ws || !healthy) throw new Error('この画面でマイクを起動してください。');
          if (!keyFor('openai')) throw new Error('OpenAIのキーが未設定です。');
          const permit = event.type === 'speak_reply' ? r.c.permitReply(event.requestId) : r.c.permit(event.candidateId); save(r, 'speech_permitted', permit);
          r.ttsEpoch = permit.epoch;
          send(ws, { type: 'tts_start', ...permit });
          let bytes = 0;
          r.ttsBytes = 0;
          r.tts = ttsSynthesize({ text: permit.text,
            onChunk: b => { bytes += b.length; if (r.ttsEpoch === permit.epoch) r.ttsBytes = bytes; if (r.c.state.outputEpoch === permit.epoch && !r.c.state.speaking) send(ws, { type: 'tts_chunk', epoch: permit.epoch, audio: b.toString('base64'), sampleRate: 24000 }); },
            onDone: () => {
              if (r.c.state.outputEpoch !== permit.epoch || r.ttsEpoch !== permit.epoch) return;
              r.c.state.usage.push({ provider: 'openai', model: ttsModel, kind: 'tts', generatedPcmBytes: bytes, generatedAudioSeconds: bytes / 48000, estimatedUsd: null, at: Date.now() });
              if (r.c.state.outputEpoch === permit.epoch) send(ws, { type: 'tts_done', epoch: permit.epoch });
              r.tts = null; save(r, 'tts_generated', { epoch: permit.epoch, bytes });
            },
            onError: e => { if (r.c.state.outputEpoch === permit.epoch) { r.c.stop('tts_failed'); r.c.state.error = e.message; save(r, 'tts_failed'); } },
          });
        } else if (event.type === 'playback' && r.micOwner === ws) {
          if (r.c.played(event.epoch, Number(event.heardMs) || 0)) save(r, 'playback_progress', { epoch: event.epoch, heardMs: event.heardMs });
        } else if (event.type === 'playback_done' && r.micOwner === ws) {
          r.c.stop('completed', event.epoch); save(r, 'playback_completed');
        } else if (event.type === 'stop') {
          r.c.stop(event.reason === 'human_speaking' ? 'human_speaking' : 'manual'); save(r, 'speech_stopped');
        }
      } catch (e) {
        // 読み上げの直前に人が話し始めても、録音接続を切らず、操作側へ結果を返す。
        if (['speak', 'speak_reply'].includes(event?.type)) send(ws, { type: 'action_error', action: event.type, code: r.c.state.inputHealthy && (r.c.state.speaking || Date.now() - r.c.state.lastVoiceAt < 500) ? 'busy' : 'unavailable', error: e.message });
        else { lost(); send(ws, { type: 'error', error: e.message }); }
      }
    });
    ws.on('error', () => {});
    ws.on('close', () => { closing = true; r.clients.delete(ws); stt?.abort(); if (r.micOwner === ws) { lost(); r.micOwner = null; } });
  }
  const watchdog = setInterval(() => {
    for (const r of sessions.values()) {
      if (r.micOwner && r.c.state.inputHealthy && Date.now() - r.heartbeatAt > 2500) { r.c.healthy(false); save(r, 'microphone_timeout'); send(r.micOwner, { type: 'error', error: 'マイク入力が止まりました。起動し直してください。' }); }
      if (r.c.expire()) save(r, 'candidate_expired');
    }
  }, 100);
  watchdog.unref();
  return {
    server,
    secureServer,
    async close() { clearInterval(watchdog); for (const r of sessions.values()) { r.c.healthy(false); save(r, 'server_shutdown'); } appClosing = true; for (const r of sessions.values()) { r.pending?.abort.abort(); r.tts?.abort(); for (const ws of r.clients) ws.terminate(); } wss.close(); await Promise.all([server, secureServer].filter(Boolean).map(s => new Promise(done => s.close(done)))); store.close(); },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadOpenAIKey();
  const host = process.env.WAIGAYA_HOST || '127.0.0.1';
  const hosts = ['127.0.0.1', 'localhost', ...(process.env.WAIGAYA_ALLOWED_HOSTS || '').split(',').filter(Boolean)];
  const networks = ['127.0.0.0/8', '::1/128', ...(process.env.WAIGAYA_ALLOWED_NETWORKS || '').split(',').filter(Boolean)];
  const tls = process.env.WAIGAYA_TLS_KEY && process.env.WAIGAYA_TLS_CERT ? {
    key: await readFile(process.env.WAIGAYA_TLS_KEY), cert: await readFile(process.env.WAIGAYA_TLS_CERT), minVersion: 'TLSv1.2',
  } : undefined;
  const caCertificate = process.env.WAIGAYA_TLS_CA ? await readFile(process.env.WAIGAYA_TLS_CA) : undefined;
  const app = createApp({ access: { hosts, networks }, tls, caCertificate, httpsUrl: process.env.WAIGAYA_HTTPS_URL || null });
  const port = Number(process.env.WAIGAYA_PORT || 8765);
  app.server.on('error', e => { console.error(e.code === 'EADDRINUSE' ? 'ポートが使用中です。.env.localのWAIGAYA_PORTを変更してください。' : 'サーバーを起動できません。'); void app.close().then(() => process.exit(1)); });
  app.server.listen(port, host, () => console.log(`ワイガヤ試作版: HTTP ${host}:${port} （発言は手動承認）`));
  if (app.secureServer) {
    app.secureServer.on('error', () => { console.error('HTTPSを起動できません。ポートと証明書設定を確認してください。'); void app.close().then(() => process.exit(1)); });
    app.secureServer.listen(Number(process.env.WAIGAYA_HTTPS_PORT || 8766), host, () => console.log(`音声対応HTTPS: ${process.env.WAIGAYA_HTTPS_URL || host}`));
  }
  const quit = () => void app.close().then(() => process.exit(0));
  process.once('SIGINT', quit); process.once('SIGTERM', quit);
}
