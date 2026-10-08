import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, parseResult, conversationInput } from '../src/models.js';
const state = { topic: '試作', phase: 'organize', decisions: [], utterances: [{ id: 'u1', revision: 1, final: true, text: '聞き取りの前に確定しないで。', speaker: 'B' }] };
const result = { action: 'question', reason: '条件確認', text: '聞き取りで何を確認しますか？', evidence: [{ utteranceId: 'u1', revision: 1 }], notes: [] };
test('スキーマが合っても存在しない根拠、暫定根拠、決定メモは拒否する', () => {
  assert.throws(() => parseResult(JSON.stringify({ ...result, evidence: [{ utteranceId: 'fake', revision: 1 }] }), state));
  assert.throws(() => parseResult(JSON.stringify(result), { ...state, utterances: [{ ...state.utterances[0], final: false }] }));
  assert.throws(() => parseResult(JSON.stringify({ ...result, notes: [{ kind: 'decision', text: '決定済み', evidence: result.evidence }] }), state));
});
test('Googleの現行steps形式を解析し、思考トークンも出力費用へ含める', async () => {
  const old = process.env.GEMINI_API_KEY; process.env.GEMINI_API_KEY = 'mock-credential';
  try {
    const response = await analyze({ provider: 'google', model: 'gemini-3.8-flash', state, fetchImpl: async (url, args) => {
      const body = JSON.parse(args.body); assert.equal(body.system_instruction.includes('沈黙は合意'), true); assert.equal(body.store, false); assert.match(url, /interactions$/);
      return Response.json({ status: 'completed', steps: [{ type: 'thought', content: [{ type: 'text', text: 'ignored' }] }, { type: 'model_output', content: [{ type: 'text', text: JSON.stringify(result) }] }], usage: { total_input_tokens: 100, total_output_tokens: 20, total_thought_tokens: 30, total_cached_tokens: 0 } });
    } });
    assert.equal(response.result.text, result.text); assert.equal(response.usage.outputTokens, 50); assert.equal(response.usage.estimatedUsd, .0002625);
  } finally { if (old === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = old; }
});
for (const [provider, model, env, raw] of [
  ['openai', 'gpt-6-luna', 'OPENAI_API_KEY', { status: 'completed', output: [{ type: 'reasoning', content: [] }, { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(result) }] }], usage: { input_tokens: 100, output_tokens: 20 } }],
  ['anthropic', 'claude-haiku-4-5', 'ANTHROPIC_API_KEY', { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(result) }], usage: { input_tokens: 100, output_tokens: 20 } }],
  ['deepseek', 'deepseek-flash', 'DEEPSEEK_API_KEY', { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }], usage: { prompt_tokens: 100, completion_tokens: 20 } }],
]) test(`${provider}: 公式応答形式から同じ候補と使用量を取得`, async () => {
  const old = process.env[env]; process.env[env] = 'mock-credential';
  try {
    const response = await analyze({ provider, model, state, fetchImpl: async () => Response.json(raw) });
    assert.deepEqual(response.result, result); assert.equal(response.usage.inputTokens, 100);
  } finally { if (old === undefined) delete process.env[env]; else process.env[env] = old; }
});
test('API失敗時に生の応答・キーを含む文字列をエラー表示へ返さない', async () => {
  const old = process.env.GEMINI_API_KEY; process.env.GEMINI_API_KEY = 'mock-credential';
  try { await assert.rejects(() => analyze({ provider: 'google', model: 'gemini-3.8-flash', state, fetchImpl: async () => new Response('sensitive echoed request', { status: 401 }) }), /HTTP 401/); }
  finally { if (old === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = old; }
});
test('長い識別番号や時刻を含む多数の発言を欠落させず圧縮し、モデルの根拠を元の発言へ戻す', async () => {
  const old=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='mock-credential';
  const longState={...state,utterances:Array.from({length:180},(_,i)=>({id:'capture-0123456789abcdef0123456789abcdef-item-0123456789abcdef-'+i,revision:3,final:true,text:'並列バルブで速い動きと遅い動きを両立したい。'+i,speaker:'参加者 (123456789012345678)',startMs:1000000+i*1000,endMs:1000999+i*1000,receivedAt:2000000+i,source:'discord'}))};
  try{
    assert.ok(JSON.stringify(longState.utterances).length>36000);
    const packed=conversationInput(longState),input=JSON.parse(packed.input);assert.equal(input.utterances.length,180);assert.equal(Object.keys(input.speakers).length,1);assert.ok(packed.input.length<36000);
    for(let i=0;i<180;i++){assert.equal(input.utterances[i].text,longState.utterances[i].text);assert.equal(packed.aliases.get(input.utterances[i].id),longState.utterances[i].id);}
    const response=await analyze({provider:'openai',model:'gpt-6.1-sol',state:longState,autonomous:true,fetchImpl:async(_,args)=>{
      const body=JSON.parse(args.body);assert.match(body.instructions,/自律的な進行/);const input=JSON.parse(body.input);
      return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({...result,evidence:[{utteranceId:input.utterances[179].id,revision:3}],notes:[{kind:'open_issue',text:'動きの両立',evidence:[{utteranceId:input.utterances[0].id,revision:3}]}]})}]}],usage:{input_tokens:100,output_tokens:20}});
    }});
    assert.equal(response.result.evidence[0].utteranceId,longState.utterances[179].id);assert.equal(response.result.notes[0].evidence[0].utteranceId,longState.utterances[0].id);
  }finally{if(old===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=old;}
});
