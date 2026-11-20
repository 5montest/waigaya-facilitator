import test from 'node:test';
import assert from 'node:assert/strict';
import {Controller} from '../src/controller.js';
import {minutesMarkdown,emptyMinutes} from '../src/minutes.js';
import {shortMinutes} from '../src/discord/minutes-publication.js';
import {knownActionValue} from '../src/action-display.js';
test('担当と期限は分かる欄だけ表示し、どちらも不明でもアクション本文を残す',()=>{
 for(const v2 of [false,true])for(const [owner,deadline] of [[null,null],['確認者',null],[null,'来週'],['確認者','来週'],['不明','未定'],['',' ']]){
  const state=new Controller({status:'completed'}).state;
  const document=v2?{schemaVersion:2,overview:[],discussionTopics:[],decisionCandidates:[],openIssues:[],keyFacts:[],actionItems:[]}:emptyMinutes();
  document.actionItems=[{text:'配線を確認する。',owner,deadline,evidence:[],...(v2?{assignment:owner==='確認者'?'explicit':'none'}:{})}];
  const original=structuredClone(document),version={version:1,kind:'minutes',document,confirmedDecisions:[]};
  for(const output of [minutesMarkdown(state,version),shortMinutes(state,version)]){
   assert.match(output,/配線を確認する/);assert.doesNotMatch(output,/担当：不明|期限：不明|期限：未定|担当者特定不可/);
   assert.equal(output.includes('担当：確認者'),owner==='確認者');assert.equal(output.includes('期限：来週'),deadline==='来週');
   if(!knownActionValue(owner))assert.doesNotMatch(output,/担当：|担当判定：/);
   if(!knownActionValue(deadline))assert.doesNotMatch(output,/期限：/);
  }
  assert.deepEqual(document,original);
 }
});
