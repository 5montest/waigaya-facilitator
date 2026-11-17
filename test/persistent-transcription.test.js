import test from 'node:test';
import assert from 'node:assert/strict';
import { fixedFixture,ids } from './helpers/fixed.js';

test('話者の短い沈黙ではSTTを再接続せず、終了時に一度だけ閉じる',async()=>{
 const r=await fixedFixture();try{
  await r.action('start');for(let i=0;i<8;i++)await r.emit(`比較案${i}の内容を保存します。`);
  assert.equal(r.captures.length,1);assert.equal(r.runtime.meeting.transcriptions.size,1);
  assert.equal((await r.state()).utterances.length,8);await r.action('end');assert.equal(r.runtime.meeting,null);assert.equal((await r.complete()).status,'completed');
 }finally{await r.close();}
});
test('pause以前のSTTが遅れて失敗してもresume後の音声受信・健康状態を消さない',async()=>{
 const handles=[];
 const r=await fixedFixture({transcribe:args=>{let resolve;const closed=new Promise(r=>resolve=r);const h={closed,beginTurn(){},endTurn(){},write(){},end(){resolve();args.onClose();},abort(){resolve();args.onClose();}};handles.push(h);return h;}});
 try{
  await r.action('start');await r.emit('一時停止前の発言');const old=r.captures[0];await r.action('pause');await r.action('resume');await r.capture();
  const current=r.runtime.meeting,live=current.captures.get(ids.owner);assert.equal(r.captures.length,2);
  old.onError(new Error('古い接続の遅延エラー'));await current.bridge.queue;
  assert.equal(current.captures.get(ids.owner),live);assert.equal(current.speakers.get(ids.owner).stt,handles[1]);assert.equal(current.activeSpeakers.has(ids.owner),true);assert.equal(current.blockedUntil.has(ids.owner),false);
  r.captures[1].emit({id:'new-after-error',text:'再開後の発言',final:true,source:'discord',startMs:Date.now(),endMs:Date.now()});await current.bridge.queue;
  assert.ok((await r.state()).utterances.some(u=>u.id==='new-after-error'));
 }finally{for(const h of handles)h.abort();await r.close();}
});
test('50分を超えた話者接続は次の発言前に交代し、古い接続の失敗で新接続を消さない',async()=>{
 const r=await fixedFixture();try{
  await r.action('start');await r.emit('交代前の発言');const old=r.captures[0];r.runtime.meeting.speakers.get(ids.owner).createdAt-=51*60000;
  await r.capture();const live=r.runtime.meeting.captures.get(ids.owner);old.onError(new Error('旧接続'));
  assert.equal(r.captures.length,2);assert.equal(r.runtime.meeting.captures.get(ids.owner),live);assert.equal(r.runtime.meeting.activeSpeakers.has(ids.owner),true);
 }finally{await r.close();}
});
