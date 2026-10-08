import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { analyze } from '../src/models.js';
import { loadOpenAIKey } from '../src/credentials.js';
import { synthesize, connectStt, sttModels } from '../src/openai-audio.js';

loadOpenAIKey();
if (!process.env.OPENAI_API_KEY) { console.error('OpenAIキーが未設定です。'); process.exit(1); }
const directory = resolve(`results/openai-smoke-${new Date().toISOString().replace(/[:.]/g, '-')}`);
await mkdir(directory, { recursive: true, mode: 0o700 });
const report = { at: new Date().toISOString(), purpose: '接続確認。想定会話と生成した音声を使用。実会議の品質・端末での遅延の評価ではない。', llm: [], stt: [], tts: null };
const state = { topic: '試作品の着手', phase: 'organize', decisions: [], utterances: [
  { id: 'u1', revision: 1, final: true, speaker: 'A', text: '試作品を今月中に作りたいです。' },
  { id: 'u2', revision: 1, final: true, speaker: 'B', text: '聞き取りが終わる前に、仕様を確定することには反対です。' },
  { id: 'u3', revision: 1, final: true, speaker: 'C', text: '捨ててもよい試作品なら並行して進められませんか。' },
] };
const save = () => writeFile(resolve(directory, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
for (const model of ['gpt-6-luna', 'gpt-6.1-sol']) {
  try { const result = await analyze({ provider: 'openai', model, state }); report.llm.push({ model, ...result }); console.log(`${model}: 構造化出力・根拠参照を確認 (${result.usage.elapsedMs}ms)`); }
  catch (e) { report.llm.push({ model, error: e.message, usage: e.usage ?? null }); console.log(`${model}: ${e.message}`); }
  await save();
}
const sample = 'まず、利用者の聞き取り結果を確認しましょう。';
let pcm;
try {
  pcm = await new Promise((done, reject) => { const chunks = []; synthesize({ text: sample, onChunk: c => chunks.push(c), onDone: () => done(Buffer.concat(chunks)), onError: reject }); });
  if (!pcm.length) throw new Error('音声が空でした。');
  const header = Buffer.alloc(44); header.write('RIFF',0); header.writeUInt32LE(36+pcm.length,4); header.write('WAVEfmt ',8); header.writeUInt32LE(16,16); header.writeUInt16LE(1,20); header.writeUInt16LE(1,22); header.writeUInt32LE(24000,24); header.writeUInt32LE(48000,28); header.writeUInt16LE(2,32); header.writeUInt16LE(16,34); header.write('data',36); header.writeUInt32LE(pcm.length,40);
  await writeFile(resolve(directory, 'sample.wav'), Buffer.concat([header,pcm]), { mode: 0o600 });
  report.tts = { model: 'gpt-4o-mini-tts', voice: process.env.WAIGAYA_OPENAI_VOICE || 'marin', input: sample, generatedAudioSeconds: pcm.length / 48000, outcome: 'received' };
  console.log(`OpenAI音声生成: PCM受信を確認 (${report.tts.generatedAudioSeconds.toFixed(2)}秒)`);
} catch (e) { report.tts = { error: e.message }; console.log(`音声生成: ${e.message}`); }
await save();
if (pcm) for (const model of sttModels.map(m => m.model)) {
  try {
    const start = performance.now();
    const output = await new Promise((done,reject) => {
      const results = new Map(); let usage, begun = false;
      const timer = setTimeout(() => { connection.abort(); reject(new Error('接続確認がタイムアウトしました。')); }, pcm.length/48 + 20000);
      const connection = connectStt({ model,
        emit: u => { results.set(u.id,u); }, onUsage: u => { usage = u; },
        onReady: () => { if (begun) return; begun = true; void (async () => {
          try { connection.voice(true); for (let i=0;i<pcm.length;i+=1920) { connection.send(pcm.subarray(i,i+1920)); await new Promise(r => setTimeout(r,40)); } connection.voice(false); connection.end(); }
          catch (e) { connection.abort(); clearTimeout(timer); reject(e); }
        })(); },
        onError: e => { clearTimeout(timer); connection.abort(); reject(e); },
        onClose: () => { clearTimeout(timer); const final = [...results.values()].filter(u => u.final); if (!final.length) reject(new Error('確定した文字起こしを受信できませんでした。')); else done({ utterances: final, usage }); },
      });
    });
    report.stt.push({ model, elapsedMs: Math.round(performance.now()-start), ...output }); console.log(`${model}: 確定結果を確認`);
  } catch (e) { report.stt.push({ model, error: e.message }); console.log(`${model}: ${e.message}`); }
  await save();
}
console.log(`結果：${directory}`);
if (report.llm.some(r=>r.error) || report.tts?.error || report.stt.some(r=>r.error)) process.exitCode=1;
