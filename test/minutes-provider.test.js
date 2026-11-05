import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../src/controller.js';
import { MinutesGenerator, emptyMinutes, structuredMinutes } from '../src/minutes.js';
import { minutesEndpoint, minutesModel } from '../src/models.js';

const withKey=async fn=>{const old=process.env.WAIGAYA_MINUTES_API_KEY;process.env.WAIGAYA_MINUTES_API_KEY='mock-only';try{await fn();}finally{if(old===undefined)delete process.env.WAIGAYA_MINUTES_API_KEY;else process.env.WAIGAYA_MINUTES_API_KEY=old;}};
const resultFor=input=>{const d=emptyMinutes();const u=input.utterances[0];d.overview=[{text:'条件を比較した。',evidence:[{utteranceId:u.id,revision:u.revision}]}];return d;};

test('DeepSeek V4.1 Flashの出力途切れも使用トークンを各試行一回記録し、費用を概算で残す',async()=>withKey(async()=>{
  const c=new Controller();c.upsert({id:'original',text:'条件を比較します。'});let calls=0;const usage=[];
  const generator=new MinutesGenerator({generate:args=>structuredMinutes({...args,fetchImpl:async()=>{calls++;return Response.json({stop_reason:'max_tokens',usage:{input_tokens:100,output_tokens:200},content:[]});}})});
  await assert.rejects(generator.generateDraft(c.state,{onUsage:u=>usage.push(u)}),/途切れ/);
  assert.equal(calls,3);assert.equal(usage.length,3);
  for(const u of usage){assert.equal(u.provider,'deepseek');assert.equal(u.outputTokens,200);assert.equal(u.estimatedUsd,.00027);assert.equal(u.outcome,'incomplete');}
}));
test('DeepSeek V4.1 Flashはtextブロックだけを読み、ブリッジのURLが/v1で終わっても二重にしない',async()=>withKey(async()=>{
  const old=process.env.WAIGAYA_MINUTES_BASE_URL;process.env.WAIGAYA_MINUTES_BASE_URL='http://127.0.0.1:7684/v1/';
  try{
    assert.equal(minutesEndpoint(),'http://127.0.0.1:7684/v1/messages');
    assert.equal(minutesModel(),'deepseek-v4.1-flash');
    const response=await structuredMinutes({input:{},fetchImpl:async()=>Response.json({stop_reason:'end_turn',content:[{type:'thinking',thinking:'ignore'},{type:'text',text:'```json\n'+JSON.stringify(emptyMinutes())+'\n```'}],usage:{input_tokens:10,output_tokens:30}})});
    assert.deepEqual(response.result,emptyMinutes());assert.equal(response.usage.estimatedUsd,.000039);assert.equal(response.usage.provider,'deepseek');
  }finally{if(old===undefined)delete process.env.WAIGAYA_MINUTES_BASE_URL;else process.env.WAIGAYA_MINUTES_BASE_URL=old;}
}));
test('根拠配列が欠けた出力はTypeErrorで終了せず、形式エラーとして一度やり直す',async()=>{
  const c=new Controller();c.upsert({id:'original',text:'比較条件を確認します。'});let calls=0;
  const generator=new MinutesGenerator({generate:async({input})=>{calls++;const result=resultFor(input);if(calls===1)delete result.overview[0].evidence;else assert.match(input.validationError,/形式/);return{result,usage:{}};}});
  const document=await generator.generateDraft(c.state);assert.equal(calls,2);assert.equal(document.overview[0].evidence[0].utteranceId,'original');
});
test('別チャンクの実在する発言を根拠にした出力も拒否する',async()=>{
  const c=new Controller();for(let i=0;i<2;i++)c.upsert({id:'original-'+i,text:'比較条件を確認します。'.repeat(8)});
  const generator=new MinutesGenerator({chunkLimit:220,generate:async({input})=>{const result=resultFor(input);result.overview[0].evidence=[{utteranceId:input.utterances[0].id==='u1'?'u2':'u1',revision:1}];return{result,usage:{}};}});
  await assert.rejects(generator.generateDraft(c.state),/根拠/);
});
test('同じ短縮IDと本文でも原発言IDが変われば保存済み結果を混用しない',async()=>{
  const c=new Controller();c.upsert({id:'first-original',text:'比較条件を確認します。'});const saved=new Map();let calls=0;
  const generator=new MinutesGenerator({generate:async({input})=>{calls++;return{result:resultFor(input),usage:{}};}});
  const checkpoints={load:key=>saved.get(key),save:(key,value)=>saved.set(key,value)};
  await generator.generateDraft(c.state,{checkpoints});c.state.utterances[0].id='replacement-original';
  const document=await generator.generateDraft(c.state,{checkpoints});assert.equal(calls,2);assert.equal(document.overview[0].evidence[0].utteranceId,'replacement-original');
});

test('旧GLM用の接続設定も互換として読み替え、議事録モデルは環境変数で差し替えられる',async()=>{
  const keys=['WAIGAYA_MINUTES_BASE_URL','WAIGAYA_GLM_BASE_URL','ANTHROPIC_BASE_URL','WAIGAYA_MINUTES_MODEL'];
  const saved=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  try{
    delete process.env.WAIGAYA_MINUTES_BASE_URL;delete process.env.ANTHROPIC_BASE_URL;
    process.env.WAIGAYA_GLM_BASE_URL='http://127.0.0.1:9999/v1';
    assert.equal(minutesEndpoint(),'http://127.0.0.1:9999/v1/messages');
    delete process.env.WAIGAYA_MINUTES_MODEL;
    assert.equal(minutesModel(),'deepseek-v4.1-flash');
    process.env.WAIGAYA_MINUTES_MODEL='deepseek-v4.1-flash-test';
    assert.equal(minutesModel(),'deepseek-v4.1-flash-test');
  }finally{for(const k of keys){if(saved[k]===undefined)delete process.env[k];else process.env[k]=saved[k];}}
});
