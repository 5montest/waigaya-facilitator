import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chromium } from '@playwright/test';
import { createApp } from '../src/server.js';
import { Store } from '../src/store.js';
import { writeFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

async function settings(page) {
  await page.getByRole('button', { name: 'メニュー', exact: true }).click();
  await page.getByRole('button', { name: '設定', exact: true }).click();
}
async function sample(page) {
  await settings(page);
  await page.locator('.advanced summary').click();
  await page.getByRole('button', { name: 'サンプルを追加', exact: true }).click();
}
async function records(page) {
  await page.getByRole('button', { name: 'メニュー', exact: true }).click();
  await page.getByRole('button', { name: '決定・メモ', exact: true }).click();
}

test('実ブラウザ: 記録・修正・人による決定確認・再読込・狭い画面', async () => {
  const app = createApp({ store: new Store(':memory:') }); app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  let browser;
  try {
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage(); const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${app.server.address().port}`);
    assert.equal(await page.locator('#settingsDialog').isVisible(), false);
    assert.equal(await page.locator('#aiPanel').isVisible(), false);
    await sample(page);
    await page.waitForFunction(() => document.querySelectorAll('.utterance').length === 3);
    await page.locator('#utterances button').nth(1).click(); await page.locator('#editText').fill('聞き取りが終わるまで、仕様を確定しないでください。');
    await page.getByRole('button', { name: '修正を保存' }).click(); await page.getByText('聞き取りが終わるまで、仕様を確定しないでください。', { exact: true }).waitFor();
    assert.equal(await page.locator('.utterance').count(), 3);
    await records(page); await page.locator('#decisionEntry summary').click(); await page.locator('#decisionText').fill('聞き取りを先に行うことを確認した。');
    await page.locator('#decisionRef').selectOption({ index: 1 }); await page.getByRole('button', { name: '決定を記録' }).click();
    await page.locator('.decision').waitFor(); await page.reload(); await records(page); await page.locator('.decision').waitFor(); await page.locator('#recordDialog [data-close]').click();
    await page.locator('#utterances button').nth(1).click(); await page.locator('#editText').fill('訂正：並行して試作品を作ることは可能です。');
    await page.getByRole('button', { name: '修正を保存' }).click(); await records(page); await page.getByText('根拠発言が更新されています：要再確認').waitFor(); await page.locator('#recordDialog [data-close]').click();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: '/tmp/waigaya-mobile.png', fullPage: true });
  } finally { await browser?.close(); await app.close(); }
});

test('実ブラウザの音声経路: Worklet入力・手動承認・端末停止・後着音声の拒否', async () => {
  const envNames = ['OPENAI_API_KEY'];
  const old = envNames.map(n => process.env[n]); envNames.forEach(n => { process.env[n] = 'mock-only'; });
  const wavPath = `/tmp/waigaya-silence-${randomUUID()}.wav`;
  const wav = Buffer.alloc(44 + 48000 * 2 * 30); wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(96000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40); await writeFile(wavPath, wav);
  let synthesis, aborted = false, browser;
  const app = createApp({ store: new Store(':memory:'), modelAnalyze: async ({ state }) => ({
    result: { action: 'question', text: '未決の条件を一つ確認しますか？', reason: 'テスト用の模擬応答', evidence: [{ utteranceId: state.utterances[0].id, revision: state.utterances[0].revision }], notes: [] }, usage: { provider: 'mock', model: 'mock', estimatedUsd: null },
  }), ttsSynthesize: handlers => { synthesis = handlers; return { abort() { aborted = true; } }; } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening'); const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    browser = await chromium.launch({ headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${wavPath}`] });
    const page = await browser.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => {
      const OriginalWorklet = window.AudioWorkletNode;
      window.AudioWorkletNode = class extends OriginalWorklet { constructor(...args) { super(...args); window.captureForTest = this; } };
      const make = AudioContext.prototype.createBufferSource;
      window.audioTest = { started: 0, stopped: 0 };
      AudioContext.prototype.createBufferSource = function (...args) { const s = make.apply(this,args); const start = s.start.bind(s), stop = s.stop.bind(s); s.start = (...a) => { window.audioTest.started++; start(...a); }; s.stop = (...a) => { window.audioTest.stopped++; stop(...a); }; return s; };
    });
    await page.goto(base); await settings(page); await page.locator('#meetingMode').selectOption('assistant'); await page.locator('#configure').click(); await sample(page);
    await page.waitForFunction(() => document.querySelectorAll('.utterance').length === 3);
    await settings(page); await page.locator('#transcribe').uncheck(); await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByRole('button', { name: '開始', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#audioStatus').textContent.includes('マイク接続中'));
    assert.equal(await page.locator('#meetingMode').inputValue(),'assistant');
    await page.getByRole('button', { name: 'AIに聞く' }).click();
    await page.getByText('未決の条件を一つ確認しますか？', { exact: true }).waitFor();
    await page.getByRole('button', { name: '読み上げる' }).click();
    await page.waitForFunction(() => document.querySelector('#analysisStatus').textContent === '読み上げ中');
    assert.ok(synthesis); synthesis.onChunk(Buffer.alloc(48000));
    await page.waitForFunction(() => window.audioTest.started === 1);
    await page.evaluate(() => window.captureForTest.port.onmessage({ data: { pcm: new ArrayBuffer(1920), rms: .1 } }));
    await page.waitForFunction(() => window.audioTest.stopped === 1);
    await page.waitForFunction(async () => { const id = localStorage.getItem('waigaya-session'); const s = await (await fetch(`/api/sessions/${id}`)).json(); return s.playback === null; });
    assert.equal(aborted, true);
    synthesis.onChunk(Buffer.alloc(48000)); synthesis.onDone();
    await page.evaluate(() => new Promise(done => setTimeout(done,100))); assert.equal((await page.evaluate(() => window.audioTest)).started, 1);
    await page.getByRole('button', { name: '記録を一時停止', exact: true }).click();
    await page.getByText('録音を保存', { exact: true }).waitFor(); assert.deepEqual(errors, []);
  } finally {
    await browser?.close(); await app.close(); await unlink(wavPath);
    envNames.forEach((n,i) => { if (old[i] === undefined) delete process.env[n]; else process.env[n] = old[i]; });
  }
});

test('開始だけで既定モデルの文字起こしを始め、終了して録音を保存できる', async () => {
  const oldKey = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = 'mock-only';
  let selectedModel, recorded = false, browser;
  const app = createApp({ store:new Store(':memory:'), sttConnect: handlers => {
    selectedModel = handlers.model; queueMicrotask(handlers.onReady);
    return {
      send() { if (!recorded) { recorded = true; handlers.emit({ id:'mock-transcript',text:'開始だけで記録します。',speaker:null,final:true,startMs:0,endMs:40,source:'openai' }); } },
      voice() {}, end() { handlers.onClose(); }, abort() {},
    };
  } });
  app.server.listen(0,'127.0.0.1'); await once(app.server,'listening');
  try {
    browser = await chromium.launch({headless:true,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
    const page = await browser.newPage({viewport:{width:390,height:844}}); const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(`http://127.0.0.1:${app.server.address().port}`);
    await page.waitForFunction(()=>document.querySelector('#sttModel').options.length===3);
    assert.equal(await page.locator('#transcribe').isChecked(),true);
    await page.getByRole('button',{name:'開始',exact:true}).click();
    await page.getByText('開始だけで記録します。',{exact:true}).waitFor();
    assert.equal(selectedModel,'gpt-transcribe');
    await page.getByRole('button',{name:'記録を一時停止',exact:true}).click();
    await page.getByRole('link',{name:'録音を保存',exact:true}).waitFor();
    await page.getByRole('button',{name:'メニュー',exact:true}).click();
    await page.getByRole('button',{name:'新しい会議',exact:true}).click();
    await page.locator('#empty').waitFor();
    assert.equal(await page.locator('#error').isVisible(),false);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    assert.deepEqual(errors,[]);
  } finally { await browser?.close(); await app.close(); if(oldKey===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=oldKey; }
});
