import test from 'node:test';
import assert from 'node:assert/strict';
import { AutonomousFacilitator } from '../src/discord/autonomy.js';

function fixture({action='summary',completed=false}={}){
  let now=10000,calls=0,spoken=0,discarded=0;
  const state={autonomous:true,inputHealthy:true,speaking:false,lastVoiceAt:0,utterances:[],aiTurns:completed?[{text:'条件を整理します。',outcome:'completed'}]:[],reply:null,playback:null};
  const bridge={state,path:'/session',async ask(options){calls++;assert.equal(options.automatic,true);state.reply={requestId:'r'+calls,action,text:'条件を整理します。'};return state;},async speakReply(id,options){assert.equal(id,state.reply.requestId);assert.equal(options.quietMs,1800);spoken++;state.reply=null;},async api(_,body){assert.equal(body.type,'discard');state.reply=null;discarded++;}};
  const facilitator=new AutonomousFacilitator(bridge,{clock:()=>now});
  const add=(id,text)=>state.utterances.push({id,revision:1,final:true,text});
  return {state,facilitator,add,advance:ms=>{now+=ms;},counts:()=>({calls,spoken,discarded})};
}
test('相づち・発話中・短い沈黙では呼び出さず、意味のある3発言の区切りで自律的に話す',async()=>{
  const f=fixture();f.add('ack','なるほど。');assert.equal(await f.facilitator.tick(),false);
  for(let i=0;i<3;i++)f.add('u'+i,'配線の役割を分かりやすく示したい。');
  f.state.speaking=true;assert.equal(await f.facilitator.tick(),false);f.state.speaking=false;f.state.lastVoiceAt=9900;assert.equal(await f.facilitator.tick(),false);
  f.advance(1800);assert.equal(await f.facilitator.tick(),true);assert.deepEqual(f.counts(),{calls:1,spoken:1,discarded:0});
  f.facilitator.close();
});
test('同じ会話で呼び出しを繰り返さず、新しい会話も45秒の間隔を守る',async()=>{
  const f=fixture();for(let i=0;i<3;i++)f.add('u'+i,'ジャンプと歩く動きの両立を検討します。');await f.facilitator.tick();
  assert.equal(await f.facilitator.tick(),false);for(let i=3;i<6;i++)f.add('u'+i,'バルブを並列にする案を試します。');assert.equal(await f.facilitator.tick(),false);
  f.advance(45000);assert.equal(await f.facilitator.tick(),true);assert.equal(f.counts().calls,2);f.facilitator.close();
});
test('holdと既に完了した同じ発言は読み上げず、停止設定を尊重する',async()=>{
  for(const options of [{action:'hold'},{completed:true}]){
    const f=fixture(options);for(let i=0;i<3;i++)f.add('u'+i,'ピンの役割が分かりにくい点を確認します。');
    assert.equal(await f.facilitator.tick(),false);assert.deepEqual(f.counts(),{calls:1,spoken:0,discarded:1});f.facilitator.close();
  }
  const f=fixture();for(let i=0;i<3;i++)f.add('u'+i,'新しい条件について整理したい。');f.state.autonomous=false;assert.equal(await f.facilitator.tick(),false);assert.equal(f.counts().calls,0);f.facilitator.close();
});
