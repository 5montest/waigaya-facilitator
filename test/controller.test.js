import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../src/controller.js';
import { Store, markdown } from '../src/store.js';

function fixture() {
  let now = 10000; const c = new Controller({}, () => now);
  c.upsert({ id: 'u1', text: '仕様の確定には反対です。', speaker: 'B' });
  const result = { action: 'question', reason: '条件が未決', text: '仕様を決める前に、何を確認しますか？', evidence: [{ utteranceId: 'u1', revision: 1 }], notes: [] };
  return { c, result, advance: ms => { now += ms; } };
}
test('部分結果の修正で発言を重複させず、候補を無効にする', () => {
  const { c, result } = fixture(); c.accept(result, c.beginRequest());
  c.upsert({ id: 'u1', text: '仕様の確定に賛成ではありません。' });
  assert.equal(c.state.utterances.length, 1); assert.equal(c.state.utterances[0].revision, 2); assert.equal(c.state.candidate, null);
});
test('文字起こしの修正で音声時刻と発言順を保つ', () => {
  let now = 10000;
  const c = new Controller({}, () => now);
  c.upsert({ id: 'audio', text: '条件が必要です。', startMs: 9000, endMs: 9500, source: 'openai' });
  c.upsert({ id: 'manual', text: '続けて確認します。' });
  now = 20000;
  c.upsert({ id: 'audio', text: '条件の確認が必要です。' });
  c.upsert({ id: 'manual', text: '続けて確認を行います。' });
  assert.deepEqual(c.state.utterances.map(u => u.id), ['audio', 'manual']);
  assert.equal(c.state.utterances[0].startMs, 9000);
  assert.equal(c.state.utterances[0].endMs, 9500);
  assert.equal(c.state.utterances[1].receivedAt, 10000);
});
test('人が話し始め、STTの確定前に終わった場合も古いLLM応答を捨てる', () => {
  const { c, result } = fixture(); const ticket = c.beginRequest(); c.voice(true); c.voice(false);
  assert.equal(c.accept(result, ticket), false); assert.equal(c.state.request.status, 'needs_refresh');
});
test('依頼への返答は会話の追加で中断せず、静かになってから一度だけ再生する', () => {
  const { c, result, advance } = fixture();c.healthy(true);
  const ticket=c.beginRequest({mode:'reply'});c.voice(true);
  c.upsert({id:'u2',text:'追加の条件も確認します。',final:false});
  c.upsert({id:'u2',text:'追加の条件も確認します。',final:true});
  assert.equal(c.state.request.status,'thinking');assert.equal(c.accept(result,ticket),true);
  assert.equal(c.state.reply.text,result.text);assert.equal(c.state.candidate,null);
  assert.throws(()=>c.permitReply(ticket.requestId));c.voice(false);advance(499);assert.throws(()=>c.permitReply(ticket.requestId));advance(1);
  const permit=c.permitReply(ticket.requestId);assert.equal(permit.text,result.text);assert.equal(c.state.reply,null);
  c.upsert({id:'late',text:'再生前の発言の文字起こしが遅れて確定しました。'});assert.equal(c.state.playback.epoch,permit.epoch);
  c.voice(true);assert.equal(c.state.playback,null);c.voice(false);advance(1000);assert.throws(()=>c.permitReply(ticket.requestId));
});
test('確定発言の訂正・手動停止・入力消失・新しい依頼は待機中の返答を取り消す', () => {
  for(const change of [c=>c.upsert({id:'u1',text:'前の発言を訂正します。'}),c=>c.stop('manual'),c=>c.healthy(false),c=>c.beginRequest({mode:'reply'}),c=>c.configure({topic:'別の話題'})]){
    const {c,result,advance}=fixture();c.healthy(true);advance(1000);
    const ticket=c.beginRequest({mode:'reply'});assert.equal(c.accept(result,ticket),true);change(c);
    assert.throws(()=>c.permitReply(ticket.requestId));
  }
});
test('新しい依頼・議題・段階の変更で古い応答を採用しない', () => {
  for (const change of [c => c.beginRequest(), c => c.configure({ topic: '次の話題' }), c => c.configure({ phase: 'organize' })]) {
    const { c, result } = fixture(); const ticket = c.beginRequest(); change(c); assert.equal(c.accept(result, ticket), false);
  }
});
test('候補の失効後も明示的依頼を完了扱いにせず再検討できる', () => {
  const { c, result, advance } = fixture(); c.accept(result, c.beginRequest()); const id = c.state.candidate.id; advance(15000);
  assert.throws(() => c.permit(id)); assert.equal(c.state.request.status, 'needs_refresh');
});
test('入力不明・発話中・発話後500ms未満では再生を許可しない', () => {
  const { c, result, advance } = fixture(); c.accept(result, c.beginRequest()); const id = c.state.candidate.id;
  assert.throws(() => c.permit(id)); c.healthy(true); c.state.lastVoiceAt = 10000; assert.throws(() => c.permit(id));
  advance(500); const p = c.permit(id); assert.equal(p.text, result.text);
});
test('割り込み時にepochを更新し、後着音声と再生通知を無効にする', () => {
  const { c, result, advance } = fixture(); c.healthy(true); advance(1000); c.accept(result, c.beginRequest());
  const permit = c.permit(c.state.candidate.id); assert.ok(c.played(permit.epoch, 200));
  c.voice(true); assert.equal(c.state.playback, null); assert.equal(c.played(permit.epoch, 500), false);
  assert.equal(c.state.aiTurns[0].outcome, 'human_speaking'); assert.equal(c.state.aiTurns[0].heardMs, 200);
});
test('入力消失は準備中の発言も止め、再生開始済みと記録しない', () => {
  const { c, result, advance } = fixture(); c.healthy(true); advance(1000); c.accept(result, c.beginRequest()); c.permit(c.state.candidate.id);
  c.healthy(false); assert.equal(c.state.playback, null); assert.equal(c.state.aiTurns[0].startedAt, null);
});
test('古い再生完了通知は新しい再生を止めない', () => {
  const { c, result, advance } = fixture(); c.healthy(true); advance(1000);
  c.accept(result, c.beginRequest()); const old = c.permit(c.state.candidate.id); c.stop();
  c.accept(result, c.beginRequest()); const next = c.permit(c.state.candidate.id); c.stop('completed', old.epoch);
  assert.equal(c.state.playback.epoch, next.epoch);
});
test('未確定又は修正前の発言を決定の根拠にできず、修正後は要確認にする', () => {
  const { c } = fixture(); assert.throws(() => c.confirmDecision({ text: '決定', evidence: [{ utteranceId: 'u1', revision: 9 }] }));
  c.confirmDecision({ text: '聞き取りを先に行う', evidence: [{ utteranceId: 'u1', revision: 1 }] });
  c.upsert({ id: 'u1', text: '聞き取りは不要という意味ではありません。' }); assert.match(markdown(c.state), /要再確認/);
});
test('履歴と状態を同じトランザクションで保存し、修正前の発言が監査履歴に残る', () => {
  const store = new Store(':memory:'); const { c } = fixture(); store.save(c.snapshot(), 'utterance', c.state.utterances[0]);
  c.upsert({ id: 'u1', text: '訂正します。' }); store.save(c.snapshot(), 'utterance', c.state.utterances[0]);
  assert.equal(store.load(c.state.id).utterances[0].revision, 2); assert.equal(store.events(c.state.id)[0].payload.text, '仕様の確定には反対です。'); store.close();
});

test('音声依頼の再検討中は補足が続いても破棄せず、根拠訂正と新依頼は取り消す', () => {
  for (const change of [c => c.upsert({id:'u1',text:'前提を訂正します。'}), c => c.beginRequest({mode:'voice_request'})]) {
    const {c,result,advance}=fixture();c.healthy(true);advance(1000);
    const ticket=c.beginRequest({mode:'voice_request',contextLocked:true});
    for(let i=0;i<5;i++)c.upsert({id:'extra-'+i,text:'補足の条件です。'});
    assert.equal(c.state.request.status,'thinking');assert.equal(c.accept(result,ticket),true);
    c.upsert({id:'after-ready',text:'回答待ちの間の補足です。'});
    const permit=c.permitReply(ticket.requestId);
    c.upsert({id:'after-permit',text:'許可後に遅れて届いた文字起こしです。'});
    assert.equal(c.state.playback.epoch,permit.epoch);change(c);assert.equal(c.state.playback,null);
  }
});
test('自律返答の許可後は相槌中も音声と再生通知を保ち、確定した割込みで止める', () => {
  const {c,result,advance}=fixture();c.healthy(true);advance(1000);
  const ticket=c.beginRequest({mode:'autonomous'});assert.equal(c.accept(result,ticket),true);
  const permit=c.permitReply(ticket.requestId);
  c.voice(true,{interrupt:false});c.upsert({id:'ack',text:'なるほど、参考になります。'});
  assert.equal(c.state.playback.epoch,permit.epoch);assert.equal(c.played(permit.epoch,1200),true);
  c.stop('human_speaking');assert.equal(c.state.playback,null);assert.equal(c.played(permit.epoch,1500),false);
});
