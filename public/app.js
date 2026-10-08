import { AutonomousFacilitator } from '/autonomy.js';
const $ = id => document.getElementById(id);
let state, config, ws, editingId = null, mic = null, starting = false, transcriptKey = null;
let ready = false, transcribing = false, heartbeat = 0, voice = false, above = 0, below = 0;
let audioCtx, currentEpoch = null, blockedEpoch = null, playAt = 0, audioDone = false, sources = new Set(), playbackStart = 0, progressTimer;
function error(message) { $('error').textContent = message; $('error').hidden = false; }
function clearError() { $('error').hidden = true; }
function socket(event) { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event)); }
async function api(path, body) {
  const r = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json(); if (!r.ok) throw new Error(data.error || '操作に失敗しました。'); return data;
}
const endpoint = suffix => `/api/sessions/${state.id}/${suffix}`;
function displayText(parent, tag, text, className = '') { const e = document.createElement(tag); e.textContent = text; e.className = className; parent.append(e); return e; }
function evidenceText(refs) {
  return refs.map(r => { const u = state.utterances.find(u => u.id === r.utteranceId); return u ? `${u.speaker ?? '話者不明'}（版${r.revision}）「${u.text.slice(0,80)}」` : '根拠を確認してください'; }).join('／');
}
function openDialog(id) { $(id).showModal(); }
function renderTranscript() {
  const key = JSON.stringify([state.id, state.utterances, state.aiTurns]);
  if (key === transcriptKey) return false;
  transcriptKey = key;
  const t = $('utterances'); t.replaceChildren();
  const items = [...state.utterances.map(u => ({ type: 'human', at: u.startMs ?? u.receivedAt, value: u })),
    ...state.aiTurns.map(turn => ({ type: 'ai', at: turn.startedAt ?? turn.finishedAt, value: turn }))].sort((a, b) => a.at - b.at);
  for (const item of items) {
    const u = item.value;
    if (item.type === 'ai') {
      const row = document.createElement('article'); row.className = 'utterance ai-history';
      const meta = displayText(row, 'div', '', 'message-meta'); displayText(meta, 'span', 'AI', 'ai-label');
      displayText(meta, 'span', u.outcome === 'completed' ? '読み上げ終了' : u.startedAt === null ? '読み上げ前に停止' : '途中で停止');
      displayText(row, 'p', u.text); t.append(row); continue;
    }
    const row = document.createElement('article'); row.className = 'utterance' + (u.final ? '' : ' partial');
    const meta = displayText(row, 'div', '', 'message-meta');
    const name = displayText(meta, 'span', `${u.source === 'sample' ? 'サンプル · ' : ''}${u.speaker ?? '発言'}${u.final ? '' : ' · 認識中'}`);
    name.title = `${u.final ? '確定' : '暫定'} · 版${u.revision}`;
    const btn = displayText(meta, 'button', '修正', 'edit');
    btn.onclick = () => { editingId = u.id; $('speaker').value = u.speaker ?? ''; $('editText').value = u.text; openDialog('editDialog'); $('editText').focus(); };
    displayText(row, 'p', u.text); t.append(row);
  }
  $('empty').hidden = items.length > 0;
  return true;
}
function render(next) {
  if (state?.id === next.id && (next.sequence ?? 0) < (state.sequence ?? 0)) return;
  const timeline = $('timeline'), nearBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 100;
  const previousCandidate = state?.candidate?.id, prevEpoch = state?.outputEpoch; state = next;
  if (currentEpoch !== null && state.outputEpoch !== currentEpoch) halt();
  if (prevEpoch !== state.outputEpoch && !state.playback) halt();
  if (!$('settingsDialog').open) { $('topic').value = state.topic; $('phase').value = state.phase; $('meetingMode').value = state.mode; }
  $('topicTitle').textContent = state.topic; $('topicTitle').hidden = state.topic === 'ワイガヤ';
  $('export').href = endpoint('transcript.md'); $('minutesExport').href = endpoint('minutes.md'); $('minutesExport').hidden = !state.minutesHistory?.length;
  $('meetingFinish').disabled = ['finalizing','completed','finalize_failed'].includes(state.status); $('meetingPause').disabled = !['recording','empty_grace'].includes(state.status);
  const transcriptChanged = renderTranscript();
  const status = { thinking: '考えています…', ready: state.candidate ? '提案' : 'いまは発言を見送ります。', needs_refresh: '会話が進みました。もう一度聞けます。', failed: 'もう一度お試しください。' };
  $('aiPanel').hidden = !state.playback && !['thinking', 'ready', 'needs_refresh', 'failed'].includes(state.request?.status);
  $('analysisStatus').textContent = state.playback ? '読み上げ中' : status[state.request?.status] || '';
  const detailOpen = previousCandidate === state.candidate?.id && $('candidate').querySelector('details')?.open;
  $('candidate').replaceChildren();
  if (state.candidate) {
    displayText($('candidate'), 'div', state.candidate.text);
    const detail = document.createElement('details'); detail.open = Boolean(detailOpen);
    displayText(detail, 'summary', '根拠を見る'); displayText(detail, 'div', state.candidate.reason); displayText(detail, 'div', evidenceText(state.candidate.evidence)); $('candidate').append(detail);
  } else if (state.playback) displayText($('candidate'), 'div', state.playback.text);
  $('speak').hidden = !state.candidate || state.mode === 'minutes' || state.quiet; $('discard').hidden = !state.candidate; $('stop').hidden = !state.playback;
  $('voiceNotice').hidden = state.mode === 'minutes' || state.quiet || (!state.candidate && !state.playback);
  $('speak').disabled = state.mode === 'minutes' || state.quiet || !state.candidate || !mic || !ready || voice || !state.inputHealthy || !config.audio.configured;
  $('speak').title = !mic ? '開始してから読み上げられます' : voice ? '人の発話が終わるまで待ちます' : '';
  $('analyze').disabled = state.request?.status === 'thinking' || !state.utterances.some(u => u.final) || !config.models[$('model').value]?.configured;
  $('notes').replaceChildren();
  if (state.notes?.revision === state.revision && state.notes.items.length) for (const n of state.notes.items) {
    const row = displayText($('notes'), 'div', n.text, 'note'); displayText(row, 'small', { idea: '案', difference: '意見の違い', open_issue: '未決の論点' }[n.kind]); displayText(row, 'small', '根拠：' + evidenceText(n.evidence));
  } else displayText($('notes'), 'p', 'まだありません。', 'hint');
  const sums = state.usage.filter(u => typeof u.estimatedUsd === 'number');
  $('usage').textContent = `LLM ${state.usage.filter(u => u.model && !u.kind).length}回 · 概算 $${sums.reduce((s,u) => s + u.estimatedUsd, 0).toFixed(5)}。音声生成・使用量不明の処理・税は含みません。`;
  $('decisions').replaceChildren(); for (const d of state.decisions) { const row = displayText($('decisions'), 'div', d.text, 'decision'); const stale = !d.evidence.every(r => state.utterances.some(u => u.final && u.id === r.utteranceId && u.revision === r.revision)); displayText(row, 'small', stale ? '根拠発言が更新されています：要再確認' : '操作担当者が確認'); }
  if (!state.decisions.length) displayText($('decisions'), 'p', 'まだありません。', 'hint');
  const selectedRef = $('decisionRef').value; $('decisionRef').replaceChildren();
  for (const u of state.utterances.filter(u => u.final)) $('decisionRef').add(new Option(`${u.speaker ?? '発言'}：${u.text.slice(0, 70)}`, u.id));
  if (state.utterances.some(u => u.id === selectedRef)) $('decisionRef').value = selectedRef;
  if (state.error) error(state.error);
  audioStatus();
  if (nearBottom && (transcriptChanged || previousCandidate !== state.candidate?.id || prevEpoch !== state.outputEpoch)) timeline.scrollTop = timeline.scrollHeight;
}
function audioStatus() {
  $('audioStatus').textContent = !mic ? (starting ? '準備中' : '待機中') : !ready || !state?.inputHealthy ? '接続中' : voice ? '聞いています' : transcribing ? '記録中' : 'マイク接続中';
  $('audioStatus').textContent += ` · ${{minutes:'議事録のみ',assistant:'呼びかけ応答',facilitator:'AIワイガヤ'}[state?.mode] || ''}${state?.status === 'paused' ? ' · 一時停止' : state?.status === 'completed' ? ' · 会議終了' : state?.status === 'finalizing' ? ' · 議事録生成中' : state?.minutesStatus === 'failed' ? ' · 議事録生成失敗' : ''}`;
  $('audioStatus').classList.toggle('active', Boolean(mic && ready && state?.inputHealthy));
  $('micLabel').textContent = starting ? '準備中' : mic ? '記録を一時停止' : state?.status === 'paused' ? '記録を再開' : ['completed','finalizing','finalize_failed'].includes(state?.status) ? '会議終了' : '開始';
  $('mic').classList.toggle('recording', Boolean(mic)); $('mic').disabled = starting || ['finalizing','completed','finalize_failed'].includes(state?.status);
}
function halt(notify = false) {
  if (currentEpoch !== null) blockedEpoch = currentEpoch;
  for (const s of sources) { try { s.stop(); } catch {} } sources.clear();
  clearInterval(progressTimer); currentEpoch = null; playAt = 0; audioDone = false;
  if (notify) socket({ type: 'stop' });
}
function completed() {
  if (audioDone && sources.size === 0 && currentEpoch !== null) {
    socket({ type: 'playback', epoch: currentEpoch, heardMs: Math.round((performance.now() - playbackStart) || 0) });
    socket({ type: 'playback_done', epoch: currentEpoch }); halt();
  }
}
function chunk(event) {
  if (!audioCtx || event.epoch !== currentEpoch || event.epoch === blockedEpoch || voice || !ready || state?.outputEpoch !== event.epoch) return;
  const bytes = Uint8Array.from(atob(event.audio), c => c.charCodeAt(0));
  const view = new DataView(bytes.buffer); const pcm = new Float32Array(Math.floor(bytes.length / 2));
  for (let i = 0; i < pcm.length; i++) pcm[i] = view.getInt16(i * 2, true) / 32768;
  const buffer = audioCtx.createBuffer(1, pcm.length, event.sampleRate); buffer.copyToChannel(pcm, 0);
  const source = audioCtx.createBufferSource(); source.buffer = buffer; source.connect(audioCtx.destination);
  playAt = Math.max(playAt, audioCtx.currentTime + .025); source.start(playAt); playAt += buffer.duration; sources.add(source);
  if (!playbackStart) {
    playbackStart = performance.now(); socket({ type: 'playback', epoch: currentEpoch, heardMs: 0 });
    progressTimer = setInterval(() => socket({ type: 'playback', epoch: currentEpoch, heardMs: Math.round(performance.now() - playbackStart) }), 300);
  }
  source.onended = () => { sources.delete(source); completed(); };
}
function connect() {
  const currentId = state.id;
  ws = new WebSocket(`${location.origin.replace('http', 'ws')}/live?session=${currentId}`);
  ws.onmessage = event => {
    if (state.id !== currentId) return;
    const e = JSON.parse(event.data);
    if (e.type === 'state') render(e.state);
    else if (e.type === 'mic_ready') { ready = true; transcribing = e.transcribe; render(state); }
    else if (e.type === 'tts_start') { halt(); currentEpoch = e.epoch; blockedEpoch = null; playbackStart = 0; }
    else if (e.type === 'tts_chunk') chunk(e);
    else if (e.type === 'tts_done' && e.epoch === currentEpoch) { audioDone = true; completed(); }
    else if (e.type === 'mic_closed' || e.type === 'error') { halt(); ready = false; if (e.error) error(e.error); void stopMic(); }
  };
  ws.onclose = () => { if (state.id !== currentId) return; halt(); ready = false; void stopMic(); error('接続が切れました。記録は保存されています。画面を再読込してください。'); };
}
async function stopMic() {
  halt(true); socket({ type: 'mic_stop' }); ready = false;
  if (mic) { mic.worklet.disconnect(); mic.input.disconnect(); mic.stream.getTracks().forEach(t => t.stop());
    if (mic.recorder?.state !== 'inactive') mic.recorder?.stop(); mic = null; }
  $('transcribe').disabled = !config?.audio.configured; $('sttModel').disabled = false; voice = false; above = below = 0; audioStatus();
}
async function startMic() {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error('マイクはHTTPSの画面で使えます。「LANで音声を使う手順」から接続してください。');
  if (ws?.readyState !== WebSocket.OPEN) throw new Error('画面の接続を待ってください。');
  starting = true; audioStatus();
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    audioCtx ??= new AudioContext(); await audioCtx.resume(); await audioCtx.audioWorklet.addModule('/capture.js');
    const input = audioCtx.createMediaStreamSource(stream); const worklet = new AudioWorkletNode(audioCtx, 'waigaya-capture');
    const mute = audioCtx.createGain(); mute.gain.value = 0; input.connect(worklet); worklet.connect(mute); mute.connect(audioCtx.destination);
    const chunks = []; let recorder;
    if (window.MediaRecorder) { recorder = new MediaRecorder(stream); recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); }; recorder.onstop = () => { const blob = new Blob(chunks, { type: recorder.mimeType }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.textContent = '録音を保存'; a.download = `waigaya-${new Date().toISOString().slice(0,10)}.${recorder.mimeType.includes('mp4') ? 'm4a' : 'webm'}`; a.className = 'button quiet'; $('recordings').append(a); }; recorder.start(1000); }
    mic = { stream, input, worklet, recorder }; $('transcribe').disabled = true; $('sttModel').disabled = true;
    stream.getTracks()[0].onended = () => { error('マイク入力が終了しました。'); void stopMic(); };
    worklet.port.onmessage = ({ data }) => {
      if (!mic || ws?.readyState !== WebSocket.OPEN) return;
      const loud = data.rms >= Number($('threshold').value);
      if (loud) {
        above += 40; below = 0;
        // 最初の検知で再生を止める。通信やSTTの結果を待たない。
        if (currentEpoch !== null) halt(true);
        if (above >= 120 && !voice) { voice = true; socket({ type: 'vad', active: true }); audioStatus(); }
      } else { above = 0; below += 40; if (below >= 500 && voice) { voice = false; socket({ type: 'vad', active: false }); audioStatus(); } }
      if (ready && transcribing) { if (ws.bufferedAmount > 256000) { error('音声送信が追いついていません。'); void stopMic(); } else ws.send(data.pcm); }
      if (ready && performance.now() - heartbeat > 500) { socket({ type: 'heartbeat' }); heartbeat = performance.now(); }
    };
    socket({ type: 'mic_start', transcribe: $('transcribe').checked, sttModel: $('sttModel').value });
  } catch (e) {
    stream?.getTracks().forEach(t => t.stop());
    await audioCtx?.close(); audioCtx = undefined; mic = null; ready = false;
    throw e;
  } finally { starting = false; audioStatus(); }
}
function resetEdit() { editingId = null; $('editText').value = ''; $('editDialog').close(); }
function action(fn) { return async event => { event?.preventDefault(); clearError(); try { await fn(); } catch (e) { error(e.message); } }; }
function updateInput() { $('utteranceForm').querySelector('button').disabled = !$('text').value.trim(); $('text').style.height = 'auto'; $('text').style.height = Math.min(130, $('text').scrollHeight) + 'px'; }
$('text').addEventListener('input', updateInput);
$('text').addEventListener('keydown', event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) { event.preventDefault(); $('utteranceForm').requestSubmit(); } });
$('openMenu').onclick = () => openDialog('menuDialog');
$('openSettings').onclick = () => { $('menuDialog').close(); $('topic').value = state.topic; $('phase').value = state.phase; openDialog('settingsDialog'); };
$('openRecord').onclick = () => { $('menuDialog').close(); openDialog('recordDialog'); };
for (const button of document.querySelectorAll('[data-close]')) button.onclick = () => button.closest('dialog').close();
$('editDialog').addEventListener('close', () => { editingId = null; });
$('mic').onclick = action(async () => { if (starting) return; if (mic) { await stopMic(); render(await api(endpoint('events'),{type:'lifecycle',action:'pause'})); } else { if(state.status === 'paused') render(await api(endpoint('events'),{type:'lifecycle',action:'resume'})); await startMic(); } });
$('stop').onclick = action(async () => { halt(true); render(await api(endpoint('events'), { type: 'stop' })); });
$('configure').onclick = action(async () => { render(await api(endpoint('events'), { type: 'configure', topic: $('topic').value, phase: $('phase').value, mode: $('meetingMode').value })); $('settingsDialog').close(); });
$('utteranceForm').onsubmit = action(async () => { render(await api(endpoint('events'), { type: 'utterance', utterance: { text: $('text').value, speaker: null, final: true } })); $('text').value = ''; updateInput(); });
$('editForm').onsubmit = action(async () => { if (!editingId) return; render(await api(endpoint('events'), { type: 'utterance', utterance: { id: editingId, text: $('editText').value, speaker: $('speaker').value || null, final: true } })); resetEdit(); });
$('analyze').onclick = action(async () => { const m = config.models[$('model').value]; render(await api(endpoint('analyze'), { provider: m.provider, model: m.model })); $('timeline').scrollTop = $('timeline').scrollHeight; });
$('meetingPause').onclick = action(async () => { await stopMic(); render(await api(endpoint('events'),{type:'lifecycle',action:'pause'})); $('menuDialog').close(); });
$('meetingFinish').onclick = action(async () => { if(!confirm('記録を終了し、議事録の下書きを作成しますか？')) return; await stopMic(); render(await api(endpoint('finish'),{})); $('menuDialog').close(); });
$('model').onchange = () => render(state);
$('speak').onclick = action(async () => { await audioCtx?.resume(); if (voice || !ready) throw new Error('開始して、人の発話が終わってから読み上げられます。'); socket({ type: 'speak', candidateId: state.candidate?.id }); });
$('discard').onclick = action(async () => render(await api(endpoint('events'), { type: 'discard' })));
$('decisionForm').onsubmit = action(async () => { const u = state.utterances.find(u => u.id === $('decisionRef').value); render(await api(endpoint('events'), { type: 'decision', text: $('decisionText').value, evidence: u ? [{ utteranceId: u.id, revision: u.revision }] : [] })); $('decisionText').value = ''; $('decisionEntry').open = false; });
$('sample').onclick = action(async () => { for (const [speaker, text] of [['A', '試作品を今月中に作りたいですね。'], ['B', '利用者の聞き取りが終わるまでは、仕様の確定には反対です。'], ['C', 'それなら、聞き取りと並行して捨ててもよい試作品を作る案はどうでしょう。']]) render(await api(endpoint('events'), { type: 'utterance', utterance: { speaker, text, source: 'sample', final: true } })); $('settingsDialog').close(); });
$('newSession').onclick = action(async () => { await stopMic(); if (ws) { ws.onclose = null; ws.close(); } state = await api('/api/sessions', {}); localStorage.setItem('waigaya-session', state.id); resetEdit(); $('text').value = ''; updateInput(); render(state); connect(); $('menuDialog').close(); });
const automaticBridge = {
  get state(){ return state; }, get path(){return `/api/sessions/${state.id}`;},
  api: (path,body) => api(path,body),
  async ask(){ const result = await api(endpoint('analyze'),{provider:'openai',model:config.defaultModel,mode:'autonomous',trigger:'auto'}); const id=result.request.id; render(result);
    const deadline=Date.now()+35000; while(Date.now()<deadline){if(state.request?.id!==id || state.request.status!=='thinking')return state;await new Promise(resolve=>setTimeout(resolve,100));} throw new Error('自律検討が時間内に完了しませんでした。'); },
  async speakReply(requestId){const deadline=Date.now()+15000;while(Date.now()<deadline){if(state.reply?.requestId!==requestId||state.mode!=='facilitator'||state.quiet)throw new Error('候補が失効しました。');if(ready&&!voice&&state.inputHealthy&&!state.speaking&&Date.now()-state.lastVoiceAt>=1800){socket({type:'speak_reply',requestId});return;}await new Promise(resolve=>setTimeout(resolve,100));}throw new Error('発言待ちを終了しました。');},
};
const facilitator = new AutonomousFacilitator(automaticBridge,{available:()=>Boolean(mic&&ready),onFailure:()=>{}});facilitator.start();
try {
  config = await api('/api/config');
  if (!window.isSecureContext) {
    const notice = $('connectionNotice'); notice.hidden = false;
    displayText(notice, 'span', 'マイクを使うには ');
    if (config.connection?.httpsUrl) { const secure = displayText(notice, 'a', 'HTTPSで開く'); secure.href = config.connection.httpsUrl; displayText(notice, 'span', ' · '); }
    const link = displayText(notice, 'a', '初回の設定'); link.href = '/lan';
  }
  config.models.forEach((m, i) => $('model').add(new Option(`${m.label}${m.configured ? '' : '（キー未設定）'}`, i)));
  const first = config.models.findIndex(m => m.configured); const preferred = config.models.findIndex(m => m.model === config.defaultModel); $('model').value = preferred >= 0 ? preferred : Math.max(0, first);
  $('credentials').textContent = `OpenAI：${first >= 0 ? 'キー設定あり' : 'キー未設定'}。読み上げ：${config.audio.ttsModel}。実会議での品質は評価中です。`;
  $('transcribe').disabled = !config.audio.configured; $('transcribe').checked = config.audio.configured;
  config.audio.sttModels.forEach(m => $('sttModel').add(new Option(m.label, m.model)));
  $('sttModel').value = config.audio.defaultSttModel;
  const saved = localStorage.getItem('waigaya-session');
  if (saved) { try { state = await api(`/api/sessions/${saved}`); } catch {} }
  state ??= await api('/api/sessions', {}); localStorage.setItem('waigaya-session', state.id); render(state); updateInput(); connect();
} catch (e) { error(e.message); }
window.addEventListener('pagehide', () => { facilitator.close(); halt(); mic?.stream.getTracks().forEach(t => t.stop()); ws?.close(); });
