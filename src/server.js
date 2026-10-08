import http from 'node:http';
import https from 'node:https';
import { X509Certificate, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { Controller } from './controller.js';
import { analyze, catalog, keyFor } from './models.js';
import { Store, markdown } from './store.js';
import { connectStt, synthesize, sttModels, defaultSttModel, ttsModel } from './openai-audio.js';
import { loadOpenAIKey, loadServiceToken } from './credentials.js';
import { requestAllowed } from './network.js';

import { MinutesGenerator, checkMinutes, minutesMarkdown, minutesStale } from './minutes.js';
import { activeStatuses, canSpeak, modes } from './meeting.js';

const publicDir = resolve(dirname(fileURLToPath(import.meta.url)), '../public');
const staticFiles = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/capture.js': ['capture.js', 'text/javascript'], '/lan': ['lan.html', 'text/html'], '/lan.js': ['lan.js', 'text/javascript'] };
function json(res, status, value) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); }
async function readBody(req) {
  let body = '';
  for await (const c of req) { body += c; if (body.length > 100000) throw new Error('入力が大きすぎます。'); }
  return JSON.parse(body || '{}');
}

export function createApp({ store = new Store(), modelAnalyze = analyze, sttConnect = connectStt, ttsSynthesize = synthesize,
  minutesGenerator = new MinutesGenerator(), serviceToken = loadServiceToken(),
  access = { hosts: ['127.0.0.1', 'localhost'], networks: ['127.0.0.0/8', '::1/128'] }, tls, caCertificate, httpsUrl = null } = {}) {
  const sessions = new Map(), minutesJobs = new Map();
  const serviceAuthorized = req => {
    const supplied = req.headers.authorization?.replace(/^Bearer /, '');
    const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
    return Boolean(local && serviceToken && supplied && Buffer.byteLength(supplied) === Buffer.byteLength(serviceToken) && timingSafeEqual(Buffer.from(supplied), Buffer.from(serviceToken)));
  };
  const protectedSession = state => state?.guildId || state?.utterances?.some(u => u.source === 'discord');
  // Crash recovery is read-only with regard to microphones. Explicit resume is required.
  for (const saved of store.list()) {
    if (!protectedSession(saved)) continue;
    if (['recording', 'empty_grace', 'created'].includes(saved.status) || !saved.status) { saved.status = 'paused'; saved.endReason = 'server_restarted'; saved.gaps ??= []; saved.gaps.push({ kind: 'server_restarted', startedAt: saved.lastPersistedAt || null, endedAt: Date.now() }); }
    else if (saved.status === 'finalizing') { saved.status = 'finalize_failed'; saved.minutesStatus = 'failed'; }
    saved.autonomous = false; saved.quiet = true; store.save(saved, 'restart_requires_explicit_resume');
  }
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
    if (r.pending && ((!['reply', 'autonomous'].includes(r.pending.mode) && (r.c.state.revision !== r.pending.revision || r.c.state.voiceEpoch !== r.pending.voiceEpoch)) || r.c.state.request?.id !== r.pending.requestId || r.c.state.request?.status !== 'thinking')) {
      r.pending.abort.abort(); r.pending = null;
    }
    if (r.tts && r.c.state.outputEpoch !== r.ttsEpoch) {
      r.tts.abort(); r.tts = null;
      r.c.state.usage.push({ provider: 'openai', model: ttsModel, kind: 'tts', outcome: 'cancelled_billing_unknown', receivedPcmBytes: r.ttsBytes ?? 0, estimatedUsd: null, at: Date.now() });
    }
    r.c.state.sequence = (r.c.state.sequence ?? 0) + 1;
    r.c.state.lastPersistedAt = Date.now();
    try { store.save(r.c.snapshot(), kind, payload); r.c.state.health.storage = 'ok'; }
    catch { r.c.healthy(false); r.c.state.health.storage = 'failed'; r.c.state.lastError = '保存に失敗しました。直近の更新が保存されたとは確認できません。'; publish(r); throw new Error(r.c.state.lastError); }
    publish(r);
  }
  function generateMinutes(r, { retry = false, summary = false } = {}) {
    const id = r.c.state.id;
    if (minutesJobs.has(id)) return minutesJobs.get(id);
    if (!summary && !retry && r.c.state.status === 'completed') return Promise.resolve(r.c.snapshot());
    if (summary && !activeStatuses.includes(r.c.state.status)) throw new Error('会議は終了済みです。議事録を取得してください。');
    const snapshot = r.c.snapshot();
    if (!summary) r.c.lifecycle('finish');
    r.c.state.minutesStatus = 'generating'; save(r, summary ? 'summary_requested' : 'minutes_requested');
    const abort = new AbortController();
    const job = (async () => {
      try {
        const document = await minutesGenerator.generateDraft(snapshot, { signal: abort.signal, onUsage: usage => { r.c.state.usage.push({ ...usage, outcome: 'received', at: Date.now() }); save(r, 'minutes_usage'); } });
        if (appClosing) return;
        checkMinutes(document, snapshot);
        const version = { version: ++r.c.state.minutesVersion, document, generatedAt: Date.now(), approvedAt: null, approvedBy: null,
          transcriptRefs: snapshot.utterances.filter(u => u.final && u.source !== 'ai').map(u => ({ utteranceId: u.id, revision: u.revision })),
          contextRevision: snapshot.revision, kind: summary ? 'summary' : 'minutes' };
        r.c.state.minutesHistory.push(version);
        r.c.state.minutesStatus = minutesStale(r.c.state, version) ? 'needs_review' : 'draft';
        if (!summary) r.c.state.status = 'completed';
        r.c.state.lastError = null; save(r, 'minutes_ready', { version: version.version });
      } catch {
        if (appClosing) return;
        r.c.state.minutesStatus = 'failed'; if (!summary) r.c.state.status = 'finalize_failed';
        r.c.state.lastError = '議事録生成に失敗しました。文字起こしの削除は行っていません。保存状態はstatusで確認し、minutesから再生成できます。';
        save(r, 'minutes_failed');
      } finally { minutesJobs.delete(id); }
      return r.c.snapshot();
    })();
    minutesJobs.set(id, job); r.minutesAbort = abort;
    return job;
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
        const body = await readBody(req);
        if (body.discord && !serviceAuthorized(req)) { json(res, 403, { error: 'Discord会議は認証済みBotから開始してください。' }); return; }
        const metadata = body.discord || {};
        if (body.discord && !['guildId', 'voiceChannelId', 'ownerId'].every(k => /^\d{17,22}$/.test(metadata[k] || ''))) throw new Error('Discord会議の識別情報が不正です。');
        const c = new Controller({ mode: 'minutes', ...metadata });
        if (body.mode) c.configure({ mode: body.mode });
        const r = { c, clients: new Set(), pending: null, tts: null, ttsEpoch: null, micOwner: null, heartbeatAt: 0 };
        sessions.set(c.state.id, r); save(r, 'created'); json(res, 201, c.snapshot()); return;
      }
      if (url.pathname === '/api/sessions' && req.method === 'GET') {
        if (!serviceAuthorized(req)) { json(res, 403, { error: '会議一覧はDiscordから確認してください。' }); return; }
        json(res, 200, store.list().filter(s => s.guildId === url.searchParams.get('guildId')).map(s => ({ id: s.id, topic: s.topic, status: s.status, mode: s.mode, startedAt: s.startedAt, ownerId: s.ownerId, voiceChannelId: s.voiceChannelId, minutesStatus: s.minutesStatus, minutesVersion: s.minutesVersion })).sort((a,b) => (b.startedAt || 0) - (a.startedAt || 0))); return;
      }
      const match = url.pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})(?:\/(events|analyze|markdown|audit|finish|minutes|minutes.md|transcript.md|summary))?$/);
      if (!match) { json(res, 404, { error: '見つかりません。' }); return; }
      const saved = sessions.get(match[1])?.c.state || store.load(match[1]);
      if (protectedSession(saved) && !serviceAuthorized(req)) { json(res, 403, { error: 'Discord会議はDiscordの権限付き操作から確認してください。' }); return; }
      const r = session(match[1]), route = match[2];
      if (req.method === 'GET') {
        if (route === 'markdown' || route === 'transcript.md') { res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'content-disposition': 'attachment; filename="waigaya.md"' }); res.end(markdown(r.c.state)); return; }
        if (route === 'minutes.md') { res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'content-disposition': 'attachment; filename="minutes.md"' }); res.end(minutesMarkdown(r.c.state)); return; }
        if (route === 'minutes') { json(res, 200, { status: r.c.state.minutesStatus, versions: r.c.state.minutesHistory }); return; }
        json(res, 200, route === 'audit' ? store.events(match[1]) : r.c.snapshot()); return;
      }
      if (req.method !== 'POST' || !req.headers['content-type']?.startsWith('application/json')) throw new Error('JSONで操作してください。');
      const body = await readBody(req);
      if (['finish', 'summary'].includes(route)) {
        if (route === 'finish' && activeStatuses.includes(r.c.state.status)) r.c.lifecycle('finish', { reason: body.reason || 'manual' });
        const job = generateMinutes(r, { retry: Boolean(body.retry), summary: route === 'summary' });
        void job.catch(() => {}); json(res, 202, r.c.snapshot()); return;
      }
      if (route === 'minutes') {
        if (body.action === 'retry') { void generateMinutes(r, { retry: true, summary: activeStatuses.includes(r.c.state.status) }).catch(() => {}); json(res, 202, r.c.snapshot()); return; }
        const version = r.c.state.minutesHistory.at(-1);
        if (!version || version.version !== body.version) throw new Error('議事録の版が変わりました。もう一度確認してください。');
        if (body.action === 'edit') {
          checkMinutes(body.document, r.c.state);
          r.c.state.minutesHistory.push({ ...version, version: ++r.c.state.minutesVersion, document: body.document, editedAt: Date.now(), editedBy: body.actorId || 'operator', approvedAt: null, approvedBy: null });
          r.c.state.minutesStatus = 'draft';
        } else if (body.action === 'approve') {
          if (minutesStale(r.c.state, version)) throw new Error('原発言が変わっています。再生成・確認してください。');
          version.approvedAt = Date.now(); version.approvedBy = body.actorId || 'operator'; r.c.state.minutesStatus = 'approved';
        } else if (['publication_reserve', 'publication'].includes(body.action)) {
          if (!version.approvedAt || minutesStale(r.c.state, version) || body.channelId !== r.c.state.outputChannelId) throw new Error('確認済みの版と指定公開先が必要です。');
          const old = r.c.state.publications.find(p => p.version === version.version && p.channelId === body.channelId);
          if (body.action === 'publication_reserve') {
            if (old) throw new Error('この版は共有済みか送信結果の確認待ちです。二重投稿は行いません。');
            r.c.state.publications.push({ version: version.version, channelId: body.channelId, status: 'pending', messageId: null, at: Date.now() });
          } else {
            if (!old || old.status !== 'pending') throw new Error('共有の予約がありません。');
            old.messageId = body.messageId; old.status = 'published'; old.publishedAt = Date.now();
          }
        } else throw new Error('議事録の操作が不正です。');
        save(r, 'minutes_' + body.action, { actorId: body.actorId, version: body.version }); json(res, 200, r.c.snapshot()); return;
      }
      if (route === 'events') {
        switch (body.type) {
          case 'utterance': {
            const u = body.utterance;
            if (r.c.state.guildId && u?.source === 'discord' && !(r.c.state.status === 'recording' || (r.c.state.status === 'empty_grace' && u.startMs <= r.c.state.emptySince))) throw new Error('記録を受け付けていない会議です。');
            r.c.upsert(u);
            if (r.c.state.minutesHistory.some(v => minutesStale(r.c.state, v))) r.c.state.minutesStatus = 'needs_review';
            break;
          }
          case 'lifecycle': r.c.lifecycle(body.action, body); break;
          case 'participant': if (!/^\d{17,22}$/.test(body.userId)) throw new Error('参加者情報が不正です。'); else if (!r.c.state.participantIds.includes(body.userId)) r.c.state.participantIds.push(body.userId); break;
          case 'health': {
            if (!['stt', 'tts', 'connection', 'discord_post', 'file_export'].includes(body.kind)) throw new Error('障害種別が不正です。');
            r.c.state.health[body.kind] = body.healthy ? 'ok' : 'failed';
            if (body.gap) r.c.state.gaps.push({ kind: body.kind, startedAt: body.gap.startedAt ?? null, endedAt: body.gap.endedAt ?? Date.now() });
            break;
          }
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
        if (body.mode !== undefined && !['live', 'reply', 'autonomous'].includes(body.mode)) throw new Error('返答のモードが不正です。');
        if (body.trigger !== undefined && body.trigger !== 'auto') throw new Error('依頼の種類が不正です。');
        if (body.trigger === 'auto' && (!canSpeak(r.c.state) || r.c.state.mode !== 'facilitator' || !r.c.state.autonomous || body.mode !== 'autonomous')) throw new Error('自律発言は停止中です。');
        if (!r.c.state.utterances.some(u => u.final)) throw new Error('確定した発言を追加してください。');
        r.pending?.abort.abort();
        const ticket = r.c.beginRequest({ mode: body.mode || 'live' });
        const pending = { ...ticket, abort: new AbortController() }; r.pending = pending;
        save(r, 'analysis_requested', { provider: body.provider, model: body.model, mode: ticket.mode, trigger: body.trigger || 'manual' });
        // モデル処理中も音声入力・停止操作を受け付ける。
        void (async () => {
          try {
            const response = await modelAnalyze({ provider: body.provider, model: body.model, state: ticket.state, requestedReply: ticket.mode === 'reply' && body.trigger !== 'auto', autonomous: body.trigger === 'auto', onMemory: memory => { if (!r.c.state.contextMemory) r.c.state.contextMemory = []; if (!r.c.state.contextMemory.some(m => m.key === memory.key)) r.c.state.contextMemory.push(memory); save(r, 'context_memory'); }, onContextUsage: usage => { r.c.state.usage.push({ ...usage, kind: 'context_summary', at: Date.now() }); save(r, 'context_summary_usage'); }, signal: pending.abort.signal });
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
      const saved = sessions.get(url.searchParams.get('session'))?.c.state || store.load(url.searchParams.get('session'));
      if (protectedSession(saved) && !serviceAuthorized(req)) { socket.destroy(); return; }
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
          if (['paused', 'empty_grace', 'finalizing', 'completed', 'finalize_failed'].includes(r.c.state.status)) return;
          stt.send(raw); r.heartbeatAt = Date.now(); return;
        }
        event = JSON.parse(raw.toString());
        if (event.type === 'mic_start') {
          if (['paused', 'empty_grace', 'finalizing', 'completed', 'finalize_failed'].includes(r.c.state.status)) throw new Error('記録は停止中です。明示的に再開してください。');
          if (!r.c.state.guildId && r.c.state.status === 'created') r.c.lifecycle('start');
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
          if (!canSpeak(r.c.state)) throw new Error('このモードではAI音声は停止しています。');
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
        if (['speak', 'speak_reply'].includes(event?.type)) send(ws, { type: 'action_error', action: event.type, code: canSpeak(r.c.state) && r.c.state.inputHealthy && (r.c.state.speaking || Date.now() - r.c.state.lastVoiceAt < 500) ? 'busy' : 'unavailable', error: e.message });
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
    async close() { clearInterval(watchdog); for (const r of sessions.values()) { r.c.healthy(false); save(r, 'server_shutdown'); } appClosing = true; for (const r of sessions.values()) { r.pending?.abort.abort(); r.minutesAbort?.abort(); r.tts?.abort(); for (const ws of r.clients) ws.terminate(); } wss.close(); await Promise.all([server, secureServer].filter(Boolean).map(s => new Promise(done => s.close(done)))); store.close(); },
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
