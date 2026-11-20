import test from 'node:test';
import assert from 'node:assert/strict';
import { Events } from 'discord.js';
import { fixedFixture,ids,waitFor } from './helpers/fixed.js';

test('旧on_call設定でも引数なしstartは議事録のみ。誤った呼びかけ文字起こしでも音声ゼロ',async()=>{
 const r=await fixedFixture({startMode:null,responsePolicy:'on_call'});try{
  const reply=await r.action('start');assert.equal((await r.state()).mode,'minutes');assert.match(reply.content,/AI音声は停止/);
  await r.emit('ワイガヤ、今の話をまとめて。');await r.emit('ワイガヤ、今日の目的は配線の確認です');await r.emit('ワイガヤ、脱線したら声をかけて');
  assert.equal(r.requests.length,0);assert.equal(r.tts.length,0);assert.equal((await r.state()).utterances.length,3);
  const status=await r.action('status');assert.match(status.content,/議事録のみ／AI音声：常にOFF/);
  await r.action('end');assert.equal((await r.complete()).status,'completed');assert.equal(r.created.length,1);
 }finally{await r.close();}
});
test('音声参加は明示選択し、主催者が議事録のみに戻したら生成中の回答・遅着音声を停止する',async()=>{
 let release;const r=await fixedFixture({startMode:null,modelAnalyze:()=>new Promise(resolve=>{release=resolve;})});try{
  await r.action('start',{strings:{mode:'assistant'}});const id=(await r.state()).id;await r.emit('ワイガヤ、二つの案を比較して');await waitFor(()=>Boolean(release));
  await r.action('mode',{strings:{mode:'minutes'}});assert.equal((await r.state()).mode,'minutes');assert.equal((await r.state()).id,id);
  release({result:{action:'hold',text:'',reason:'取消済み',evidence:[],notes:[]},usage:{}});await r.runtime.meeting.addressing.running;
  const b=r.runtime.meeting.bridge;b.state.playback={epoch:999};b.state.outputEpoch=999;b.emit('audio',{type:'tts_start',epoch:999});b.emit('audio',{type:'tts_chunk',epoch:999,sampleRate:24000,audio:Buffer.alloc(960).toString('base64')});
  assert.equal(r.tts.length,0);assert.equal(r.runtime.meeting.playback.epoch,null);
  await r.emit('ワイガヤ、まとめて');assert.equal((await r.state()).utterances.length,2);
 }finally{release?.({result:{action:'hold',text:'',reason:'終了',evidence:[],notes:[]},usage:{}});await r.close();}
});
test('DiscordのサーバーミュートはAIだけ停止し、解除しても勝手に再開しない',async()=>{
 const r=await fixedFixture();try{
  await r.action('start');r.client.emit(Events.VoiceStateUpdate,{channelId:ids.vc},{id:ids.bot,channelId:ids.vc,serverMute:true});await waitFor(async()=>(await r.state()).quiet);
  assert.equal((await r.state()).status,'recording');r.client.emit(Events.VoiceStateUpdate,{channelId:ids.vc,serverMute:true},{id:ids.bot,channelId:ids.vc,serverMute:false});
  await r.emit('ワイガヤ、まとめて');assert.equal(r.tts.length,0);assert.equal((await r.state()).quiet,true);
 }finally{await r.close();}
});
test('固定会議APIも旧on_call設定で無指定モードを音声参加へ昇格しない',async()=>{
 const r=await fixedFixture();try{
  const s=await r.api('/api/sessions',{discord:{guildId:ids.guild,voiceChannelId:ids.vc,ownerId:ids.owner,recordingNoticeSentAt:Date.now(),autoPublicationNoticeAt:Date.now()}});assert.equal(s.mode,'minutes');
 }finally{await r.close();}
});
