import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import WebSocket from 'ws';
import { createApp } from '../src/server.js';
import { Store } from '../src/store.js';

async function setup(modelAnalyze, options = {}) {
  const store = new Store(':memory:'); const app = createApp({ store, modelAnalyze, ...options });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = (path, body) => fetch(base + path, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const state = await (await post('/api/sessions', {})).json();
  const path = `/api/sessions/${state.id}`;
  await post(path + '/events', { type: 'utterance', utterance: { id: 'u1', text: 'まだ条件が決まっていません。' } });
  return { app, base, state, path, post, store, get: () => fetch(base + path).then(r => r.json()) };
}
const candidate = { action: 'question', reason: '未決条件', text: 'どの条件を先に決めますか？', evidence: [{ utteranceId: 'u1', revision: 1 }], notes: [] };
test('許可したLANのHostで記録とWebSocketを利用でき、別Originからは操作できない', async () => {
  const r = await setup(undefined, { access: { hosts:['127.0.0.1','192.168.8.10'], networks:['127.0.0.0/8'] } });
  try {
    const port = r.app.server.address().port, host = `192.168.8.10:${port}`, origin = `http://${host}`;
    const response = await new Promise((resolve,reject) => {
      const req = request(r.base + r.path + '/events', { method:'POST', headers:{host,origin,'content-type':'application/json'} }, res => { res.resume(); res.on('end',()=>resolve(res.statusCode)); });
      req.on('error',reject); req.end(JSON.stringify({type:'utterance',utterance:{id:'lan-u',text:'LANから追記します。'}}));
    });
    assert.equal(response,200); assert.ok((await r.get()).utterances.some(u=>u.id==='lan-u'));
    const ws = new WebSocket(r.base.replace('http','ws') + '/live?session=' + r.state.id, {origin,headers:{host}});
    await once(ws,'open'); ws.close();
    const rejected = await fetch(r.base + '/api/sessions', { method:'POST', headers:{host,origin:'http://elsewhere.example','content-type':'application/json'},body:'{}' });
    assert.equal(rejected.status,403);
  } finally { await r.app.close(); }
});
test('MVPはOpenAIだけを公開し、他社への検討依頼を呼び出さずに拒否する', async () => {
  let called = false;
  const r = await setup(() => { called = true; });
  try {
    const config = await (await fetch(r.base + '/api/config')).json();
    assert.ok(config.models.length > 0);
    assert.ok(config.models.every(m => m.provider === 'openai'));
    assert.equal(config.defaultModel, 'gpt-6.1-sol');
    assert.equal(config.audio.provider, 'openai');
    assert.equal(config.audio.defaultSttModel, 'gpt-transcribe');
    assert.equal(config.audio.speakerDiarization, false);
    assert.equal((await r.post(r.path + '/analyze', { provider: 'google', model: 'gemini-3.8-flash' })).status, 400);
    assert.equal(called, false);
  } finally { await r.app.close(); }
});
test('HTTP/WS統合: LLM待機中の発言修正で中断し、後着結果を捨てる', async () => {
  let resolveModel, signal;
  const r = await setup(args => { signal = args.signal; return new Promise(done => { resolveModel = done; }); });
  try {
    const ws = new WebSocket(r.base.replace('http', 'ws') + '/live?session=' + r.state.id, { origin: r.base }); await once(ws, 'open');
    assert.equal((await r.post(r.path + '/analyze', { provider: 'openai', model: 'gpt-6.1-sol' })).status, 202);
    await r.post(r.path + '/events', { type: 'utterance', utterance: { id: 'u1', text: 'いま条件を確認できました。' } });
    assert.equal(signal.aborted, true); resolveModel({ result: candidate, usage: { estimatedUsd: .001 } });
    await new Promise(done => setTimeout(done, 20));
    const next = await r.get(); assert.equal(next.candidate, null); assert.equal(next.request.status, 'needs_refresh');
    assert.ok(r.store.events(r.state.id).some(e => e.kind === 'analysis_stale')); ws.close();
  } finally { await r.app.close(); }
});
test('取消した依頼の遅い応答で候補を復活させない', async () => {
  let finish;
  const r = await setup(() => new Promise(done => { finish = done; }));
  try {
    await r.post(r.path + '/analyze', { provider: 'openai', model: 'gpt-6.1-sol' });
    await r.post(r.path + '/events', { type: 'discard' }); finish({ result: candidate, usage: {} });
    await new Promise(done => setTimeout(done, 20)); const state = await r.get();
    assert.equal(state.candidate, null); assert.equal(state.request.status, 'dismissed');
  } finally { await r.app.close(); }
});
test('別サイトのOriginからの操作とWebSocket接続を受け付けない', async () => {
  const r = await setup();
  try {
    const res = await fetch(r.base + '/api/sessions', { method: 'POST', headers: { origin: 'https://elsewhere.example', 'content-type': 'application/json' }, body: '{}' }); assert.equal(res.status, 403);
    const ws = new WebSocket(r.base.replace('http', 'ws') + '/live?session=' + r.state.id, { origin: 'https://elsewhere.example' });
    await once(ws, 'error'); assert.notEqual(ws.readyState, WebSocket.OPEN);
  } finally { await r.app.close(); }
});
test('逐次発話検知とマイク消失はAPIを待たず候補を取り消す', async () => {
  const r = await setup(async () => ({ result: candidate, usage: {} }));
  try {
    const ws = new WebSocket(r.base.replace('http', 'ws') + '/live?session=' + r.state.id, { origin: r.base });
    await once(ws, 'open'); ws.send(JSON.stringify({ type: 'mic_start', transcribe: false }));
    await new Promise(done => setTimeout(done, 20)); assert.equal((await r.get()).inputHealthy, true);
    await r.post(r.path + '/analyze', { provider: 'openai', model: 'gpt-6.1-sol' }); await new Promise(done => setTimeout(done, 20));
    assert.ok((await r.get()).candidate); ws.send(JSON.stringify({ type: 'vad', active: true })); await new Promise(done => setTimeout(done, 20));
    assert.equal((await r.get()).candidate, null); ws.close(); await new Promise(done => setTimeout(done, 20)); assert.equal((await r.get()).inputHealthy, false);
  } finally { await r.app.close(); }
});
