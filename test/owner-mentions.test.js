import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ALIAS_FILE_ENV,aliasDictionaryVersion,canonicalMinutesDocument,candidateMentionUsers,classifyAssignment,collectGuildMembership,
  describeMentionPlan,loadAliasDictionary,mentionPlanPreview,mentionReasonLabel,normalizeAliasName,parseAliasDictionary,
  prepareMentionPlan,resolveAlias,resolveUserId,snapshotMentionPlan,
} from '../src/discord/owner-mentions.js';
import { applyMentionSuppression,normalizeMentionSnapshot,verifyMentionDelivery,markMentionNotifications } from '../src/publication.js';

// ダミーsnowflakeのみを使う（実アカウントと無関係な17〜22桁の数値文字列）。
const GUILD='123456789012345678';
const KTO='111111111111111111',IKE='222222222222222222',ORI='333333333333333333',CLAY='444444444444444444',ETERNAL='555555555555555555',FIVE='666666666666666666';
const UNKNOWN_RAW='999999999999999999';
const member=(userId,usernameHint,displayNameHint,aliases=[],extra={})=>({userId,usernameHint,displayNameHint,aliases,verified:true,enabled:true,...extra});
const BASE_MEMBERS=[
  member(KTO,'ktokunn','ktokunn',['鈴木','鈴木氏']),
  member(IKE,'iketani_y','iketani_y',['池谷']),
  member(ORI,'orishikan_74100','オリシーカン',['折原']),
  member(CLAY,'claytoxicz','消防車もどき',['しみず','きよみず']),
  member(ETERNAL,'eternalfriend17','孔明',['孔明','木村','まじぱね']),
  member(FIVE,'5montest','5montest',[]),
];
function dictionary({members=BASE_MEMBERS,guildId=GUILD,enabled=true}={}) {
  const {dictionary:parsed}=parseAliasDictionary({schemaVersion:1,guildId,notificationDefaults:{enabled,mentionOnlyExplicitAssignees:true,mentionProposedAssignees:false,suppressRepeatMentions:true},members});
  return parsed;
}
function membership({members=BASE_MEMBERS,missing=[],lookupFailed=[],usernames={}}={}) {
  const map=new Map();
  for(const entry of members)if(!missing.includes(entry.userId))map.set(entry.userId,{found:true,id:entry.userId,username:usernames[entry.userId]??entry.usernameHint});
  for(const id of lookupFailed)map.set(id,{found:false,reason:'lookup_failed'});
  return {available:true,members:map};
}
function fixture({text='',owner=null,assignment='explicit',userId,speakerUserId,evidenceRevision=1,utteranceRevision=1,final=true,source='discord',documentOverride}={}) {
  const utterance={id:'u1',revision:utteranceRevision,text,final,source,...(speakerUserId?{userId:speakerUserId}:{})};
  const state={id:'session-1',guildId:GUILD,utterances:[utterance],publications:[],minutesHistory:[]};
  const document=documentOverride??{schemaVersion:2,overview:[],discussionTopics:[],decisionCandidates:[],openIssues:[],keyFacts:[],
    actionItems:[{text:'アクション',owner,deadline:null,assignment,evidence:[{utteranceId:'u1',revision:evidenceRevision}]}]};
  const version={version:1,kind:'minutes',document,metadata:{},confirmedDecisions:[],approvedAt:null};
  state.minutesHistory=[version];
  return {state,version};
}
function planFor(options,{planOptions={},dictionaryOptions={},membershipOptions={}}={}) {
  const {state,version}=fixture(options);
  return describeMentionPlan(state,version,dictionary(dictionaryOptions),{guildId:GUILD,guildMembers:membership(membershipOptions),now:1000,...planOptions});
}

// --- 限定正規化・別名解決 ------------------------------------------------
test('別名はNFKC・空白・句読点・敬称だけを限定正規化し、完全一致のみ解決する',()=>{
  assert.equal(normalizeAliasName('鈴木さん'),'鈴木');
  assert.equal(normalizeAliasName('鈴木氏'),'鈴木');
  assert.equal(normalizeAliasName(' 鈴木　さん '),'鈴木');
  assert.equal(normalizeAliasName('孔明先生'),'孔明');
  assert.equal(normalizeAliasName('ＳＵＺＵＫＩ'),'suzuki');
  assert.equal(normalizeAliasName('きよみず、'),'きよみず');
  assert.equal(normalizeAliasName('鈴木さんさん'),'鈴木');
  assert.equal(normalizeAliasName(''),'');
  const dict=dictionary();
  assert.equal(resolveAlias(dict,'鈴木',{guildId:GUILD,guildMembers:membership()}).status,'resolved');
  assert.equal(resolveAlias(dict,'鈴木さん',{guildId:GUILD,guildMembers:membership()}).userId,KTO);
  assert.equal(resolveAlias(dict,'鈴木氏',{guildId:GUILD,guildMembers:membership()}).userId,KTO);
  // 部分一致は解決しない。
  assert.equal(resolveAlias(dict,'鈴木一郎',{guildId:GUILD,guildMembers:membership()}).status,'unregistered');
  assert.equal(resolveAlias(dict,'鈴',{guildId:GUILD,guildMembers:membership()}).status,'unregistered');
  assert.equal(resolveAlias(dict,'木村さんと鈴木さん',{guildId:GUILD,guildMembers:membership()}).status,'unregistered');
});
test('辞書は未設定・壊れたJSON・schemaVersion違い・不正IDを安全側に扱う',()=>{
  const root=mkdtempSync(join(tmpdir(),'wg-alias-'));
  try{
    const missing=loadAliasDictionary({env:{[ALIAS_FILE_ENV]:join(root,'none.json')}});
    assert.equal(missing.dictionary,null);assert.equal(missing.error,'alias_dictionary_missing');
    const broken=join(root,'broken.json');writeFileSync(broken,'{not json');
    assert.equal(loadAliasDictionary({env:{[ALIAS_FILE_ENV]:broken}}).error,'alias_dictionary_invalid_json');
    const wrongSchema=join(root,'schema.json');writeFileSync(wrongSchema,JSON.stringify({schemaVersion:2,members:[]}));
    assert.equal(loadAliasDictionary({env:{[ALIAS_FILE_ENV]:wrongSchema}}).error,'別名辞書のschemaVersionは1を指定してください。');
    assert.equal(parseAliasDictionary(null).dictionary,null);
    assert.equal(parseAliasDictionary({schemaVersion:1,members:'x'}).dictionary,null);
    const sample=loadAliasDictionary({file:'config/waigaya-member-aliases.sample.json'});
    assert.ok(sample.dictionary);
    assert.equal(sample.dictionary.notificationDefaults.enabled,false);
    assert.equal(sample.dictionary.guildId,null);
    for(const entry of sample.dictionary.members){assert.equal(entry.userId,null);assert.equal(entry.verified,false);assert.equal(entry.enabled,false);}
    const {dictionary:withInvalid}=parseAliasDictionary({schemaVersion:1,guildId:GUILD,notificationDefaults:{enabled:true},members:[member('not-a-snowflake','x','x',['x'])]});
    assert.equal(withInvalid.members[0].invalid,true);
    assert.equal(resolveAlias(withInvalid,'x',{guildId:GUILD,guildMembers:membership()}).status,'unregistered');
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('辞書の内容ハッシュを辞書版として使い、内容が変われば版も変わる',()=>{
  const first=dictionary();
  assert.match(first.version,/^[0-9a-f]{16}$/);
  assert.equal(aliasDictionaryVersion(dictionary()),first.version);
  const changed=dictionary({members:[...BASE_MEMBERS,member('777777777777777777','extra','extra',['追加'])].map(entry=>({...entry}))});
  assert.notEqual(changed.version,first.version);
  // パスや読込時刻ではなく内容で決まる。
  const again=parseAliasDictionary({schemaVersion:1,guildId:GUILD,notificationDefaults:{enabled:true,mentionOnlyExplicitAssignees:true,mentionProposedAssignees:false,suppressRepeatMentions:true},members:BASE_MEMBERS});
  assert.equal(again.dictionary.version,first.version);
});
test('別名衝突・未検証・無効・他Guild・在籍不明は未解決（通知しない）',()=>{
  const ambiguous=dictionary({members:[member(KTO,'a','a',['鈴木']),member(IKE,'b','b',['鈴木'])]});
  assert.equal(resolveAlias(ambiguous,'鈴木',{guildId:GUILD,guildMembers:membership({members:[]})}).status,'ambiguous');
  const unverified=dictionary({members:[member(KTO,'ktokunn','ktokunn',['鈴木'],{verified:false})]});
  assert.equal(resolveAlias(unverified,'鈴木',{guildId:GUILD,guildMembers:membership({members:[]})}).status,'unverified');
  const disabled=dictionary({members:[member(KTO,'ktokunn','ktokunn',['鈴木'],{enabled:false})]});
  assert.equal(resolveAlias(disabled,'鈴木',{guildId:GUILD,guildMembers:membership({members:[]})}).status,'disabled');
  const otherGuild=dictionary({guildId:'999999999999999999'});
  assert.equal(resolveAlias(otherGuild,'鈴木',{guildId:GUILD,guildMembers:membership()}).status,'guild_mismatch');
  const noGuild=dictionary({guildId:null});
  assert.equal(resolveAlias(noGuild,'鈴木',{guildId:GUILD,guildMembers:membership()}).status,'guild_mismatch');
  assert.equal(resolveAlias(dictionary(),'鈴木',{guildId:GUILD,guildMembers:{available:false,members:new Map()}}).status,'membership_unavailable');
  assert.equal(resolveAlias(dictionary(),'鈴木',{guildId:GUILD,guildMembers:membership({missing:[KTO]})}).status,'not_member');
  assert.equal(resolveAlias(dictionary(),'鈴木',{guildId:GUILD,guildMembers:membership({lookupFailed:[KTO]})}).status,'membership_unavailable');
  // usernameHintと実usernameが一致しないIDは誤登録の可能性があるため未解決。
  assert.equal(resolveAlias(dictionary(),'鈴木',{guildId:GUILD,guildMembers:membership({usernames:{[KTO]:'someone_else'}})}).status,'identity_mismatch');
  const duplicate=parseAliasDictionary({schemaVersion:1,guildId:GUILD,notificationDefaults:{enabled:true},members:[member(KTO,'a','a',['A']),member(KTO,'b','b',['B'])]}).dictionary;
  assert.ok(duplicate.members.every(entry=>entry.invalid));
  assert.equal(resolveAlias(duplicate,'A',{guildId:GUILD,guildMembers:membership()}).status,'unregistered');
});
test('Guildメンバー照合は対象ユーザーだけを取得し、取得不可・不明メンバー・照会失敗を区別する',async()=>{
  const fetched=[];
  const guild={members:{fetch:async id=>{fetched.push(id);if(id===KTO)return{user:{username:'ktokunn'},displayName:'ktokunn'};const error=new Error('Unknown Member');error.code=10007;throw error;}}};
  const result=await collectGuildMembership(guild,[KTO,IKE,IKE,'invalid',UNKNOWN_RAW]);
  assert.deepEqual(fetched,[KTO,IKE,UNKNOWN_RAW]);
  assert.equal(result.available,true);
  assert.equal(result.members.get(KTO).found,true);
  assert.equal(result.members.get(IKE).reason,'not_member');
  assert.equal(result.members.get(UNKNOWN_RAW).reason,'not_member');
  const failing={members:{fetch:async()=>{throw new Error('network down');}}};
  const failed=await collectGuildMembership(failing,[KTO]);
  assert.equal(failed.members.get(KTO).reason,'lookup_failed');
  assert.equal((await collectGuildMembership({},[KTO])).available,false);
});
test('自己申告は発話者userIdを辞書とGuild在籍で検証する',()=>{
  const dict=dictionary();
  assert.equal(resolveUserId(dict,FIVE,{guildId:GUILD,guildMembers:membership()}).status,'resolved');
  assert.equal(resolveUserId(dict,UNKNOWN_RAW,{guildId:GUILD,guildMembers:membership()}).status,'unregistered');
  assert.equal(resolveUserId(dict,'abc',{guildId:GUILD,guildMembers:membership()}).status,'invalid_user_id');
});

// --- 担当判定の独立分類（D3/D5の元になる分類） ---------------------------
test('担当分類は明示・提案・過去の言及・否定・矛盾・自己申告を区別する',()=>{
  const cases=[
    ['鈴木さんが購入意向者の価格帯を確認してください','鈴木','explicit'],
    ['池谷さん、設計候補パーツを一覧にしてください','池谷','explicit'],
    ['折原が基板を調べると言っていた','折原','none'],
    ['しみずさんに聞いてみようか？','しみず','proposed'],
    ['きよみずにお願いすることになりました','きよみず','explicit'],
    ['孔明先生と木村さんは同じ人だよ','木村','none'],
    ['まじぱねさん、図面のレビューをお願いします','まじぱね','explicit'],
    ['鈴木さんはやらなくていい。私がやる','鈴木','explicit'],
    ['鈴木氏の案がよかった','鈴木','none'],
    ['5montestがやる？','5montest','proposed'],
    ['担当は鈴木さん？ いや池谷さん','鈴木','conflict'],
    ['（複数人の発言が重なり判別できません）',null,'none'],
    ['田中さんが確認してください','田中','explicit'],
    ['@everyone <@999999999999999999> 鈴木さんが確認してください','鈴木','explicit'],
  ];
  for(const [text,owner,expected] of cases){
    const result=classifyAssignment(text,{ownerName:owner});
    assert.equal(result.assignment,expected,`${text} -> ${result.assignment}`);
  }
  const self=classifyAssignment('鈴木さんはやらなくていい。私がやる',{ownerName:'鈴木'});
  assert.equal(self.self,true);assert.equal(self.denied,true);
  const conflict=classifyAssignment('担当は鈴木さん？ いや池谷さん',{ownerName:'鈴木'});
  assert.equal(conflict.conflict,true);
});

// --- D5の14ケース（担当解決 + 自動メンション可否） -----------------------
const D5=[
  {id:1,text:'鈴木さんが購入意向者の価格帯を確認してください',owner:'鈴木',assignment:'explicit',notify:true,userId:KTO},
  {id:2,text:'池谷さん、設計候補パーツを一覧にしてください',owner:'池谷',assignment:'explicit',notify:true,userId:IKE},
  {id:3,text:'折原が基板を調べると言っていた',owner:'折原',assignment:'explicit',notify:false,reason:'assignment_unsupported'},
  {id:4,text:'しみずさんに聞いてみようか？',owner:'しみず',assignment:'proposed',notify:false,reason:'assignment_proposed'},
  {id:5,text:'きよみずにお願いすることになりました',owner:'きよみず',assignment:'explicit',notify:true,userId:CLAY},
  {id:6,text:'孔明先生と木村さんは同じ人だよ',owner:'木村',assignment:'explicit',notify:false,reason:'assignment_unsupported'},
  {id:7,text:'まじぱねさん、図面のレビューをお願いします',owner:'まじぱね',assignment:'explicit',notify:true,userId:ETERNAL},
  {id:8,text:'鈴木さんはやらなくていい。私がやる',owner:null,assignment:'explicit',speakerUserId:FIVE,notify:true,userId:FIVE,notKto:true},
  {id:9,text:'鈴木氏の案がよかった',owner:'鈴木',assignment:'explicit',notify:false,reason:'assignment_unsupported'},
  {id:10,text:'5montestがやる？',owner:'5montest',assignment:'proposed',notify:false,reason:'assignment_proposed'},
  {id:11,text:'担当は鈴木さん？ いや池谷さん',owner:'鈴木',assignment:'explicit',notify:false,reason:'assignment_unsupported'},
  {id:12,text:'（複数人の発言が重なり判別できません）',owner:null,assignment:'none',notify:false,reason:'assignment_not_explicit'},
  {id:13,text:'田中さんが確認してください',owner:'田中',assignment:'explicit',notify:false,reason:'unregistered'},
  {id:14,text:`@everyone <@${UNKNOWN_RAW}> <@&${GUILD}> 鈴木さんが確認してください`,owner:'鈴木',assignment:'explicit',notify:true,userId:KTO},
];
test('D5の14ケース: 明示担当だけがID一致で通知対象になり、提案・過去・否定・曖昧は抑止する',()=>{
  assert.equal(D5.length,14);
  for(const entry of D5){
    const plan=planFor({text:entry.text,owner:entry.owner,assignment:entry.assignment,speakerUserId:entry.speakerUserId});
    const action=plan.actions[0];
    assert.equal(plan.actions.length,1,`case${entry.id}`);
    assert.equal(plan.enabled,true,`case${entry.id}`);
    assert.equal(action.notify,entry.notify,`case${entry.id}: ${action.suppressReason}`);
    if(entry.notify){
      assert.equal(plan.allowedUserIds.length,1,`case${entry.id}`);
      assert.equal(plan.allowedUserIds[0],entry.userId,`case${entry.id}`);
      assert.equal(action.ownerUserId,entry.userId,`case${entry.id}`);
      assert.equal(action.suppressReason,null,`case${entry.id}`);
      assert.deepEqual(action.assignmentEvidence,{utteranceId:'u1',revision:1});
      assert.match(action.textDigest,/^[0-9a-f]{16}$/);
    }else{
      assert.deepEqual(plan.allowedUserIds,[],`case${entry.id}`);
      assert.ok(action.suppressReason,`case${entry.id} needs reason`);
      if(entry.reason)assert.ok(action.suppressReason.startsWith(entry.reason),`case${entry.id}: ${action.suppressReason}`);
    }
    if(entry.notKto)assert.ok(!plan.allowedUserIds.includes(KTO));
  }
});
test('D5ケース8: 自己申告で発話者IDが取れない場合は未解決、辞書未登録なら通知しない',()=>{
  const noId=planFor({text:'鈴木さんはやらなくていい。私がやる',owner:null,assignment:'explicit'});
  assert.equal(noId.actions[0].notify,false);
  assert.equal(noId.actions[0].suppressReason,'self_user_id_missing');
  const unregistered=planFor({text:'私がやります',owner:null,assignment:'explicit',speakerUserId:UNKNOWN_RAW});
  assert.equal(unregistered.actions[0].notify,false);
  assert.equal(unregistered.actions[0].suppressReason,'self_unregistered');
});

// --- 辞書・Guild・v1の安全側 ---------------------------------------------
test('辞書が無い/通知無効/Guild不一致/未検証は通知対象なし',()=>{
  const noDictionary=describeMentionPlan(fixture({text:'鈴木さんが確認してください',owner:'鈴木'}).state,fixture({text:'鈴木さんが確認してください',owner:'鈴木'}).version,null,{guildId:GUILD,now:1});
  assert.equal(noDictionary.reason,'dictionary_missing');assert.deepEqual(noDictionary.allowedUserIds,[]);
  const disabled=planFor({text:'鈴木さんが確認してください',owner:'鈴木'},{dictionaryOptions:{enabled:false}});
  assert.equal(disabled.reason,'notifications_disabled');assert.deepEqual(disabled.allowedUserIds,[]);
  const otherGuild=planFor({text:'鈴木さんが確認してください',owner:'鈴木'},{dictionaryOptions:{guildId:'999999999999999999'}});
  assert.equal(otherGuild.reason,'guild_mismatch');assert.deepEqual(otherGuild.allowedUserIds,[]);
  const unverified=planFor({text:'鈴木さんが確認してください',owner:'鈴木'},{dictionaryOptions:{members:[member(KTO,'ktokunn','ktokunn',['鈴木'],{verified:false})]},membershipOptions:{members:[]}});
  assert.deepEqual(unverified.allowedUserIds,[]);
  assert.ok(unverified.actions[0].suppressReason.startsWith('unverified'));
  const noMembership=planFor({text:'鈴木さんが確認してください',owner:'鈴木'},{planOptions:{guildMembers:null}});
  assert.deepEqual(noMembership.allowedUserIds,[]);
});
test('v1文書（assignmentなし）は本文表示のみで通知対象外',()=>{
  const v1Document={overview:[],ideas:[],comparisons:[],decisionCandidates:[],openIssues:[],actionItems:[{text:'鈴木さんが確認する。',owner:'鈴木',deadline:null,evidence:[{utteranceId:'u1',revision:1}]}]};
  const plan=planFor({text:'鈴木さんが購入意向者の価格帯を確認してください',documentOverride:v1Document});
  assert.deepEqual(plan.allowedUserIds,[]);
  assert.equal(plan.actions[0].suppressReason,'legacy_document');
});
test('根拠が失効・訂正・欠落している場合は通知しない',()=>{
  const stale=planFor({text:'鈴木さんが確認してください',owner:'鈴木',utteranceRevision:2,evidenceRevision:1});
  assert.equal(stale.actions[0].suppressReason,'evidence_stale');
  const notFinal=planFor({text:'鈴木さんが確認してください',owner:'鈴木',final:false});
  assert.equal(notFinal.actions[0].suppressReason,'evidence_stale');
  const ai=planFor({text:'鈴木さんが確認してください',owner:'鈴木',source:'ai'});
  assert.equal(ai.actions[0].suppressReason,'evidence_stale');
  const missing=planFor({text:'鈴木さんが確認してください',owner:'鈴木',documentOverride:{schemaVersion:2,overview:[],discussionTopics:[],decisionCandidates:[],openIssues:[],keyFacts:[],actionItems:[{text:'x',owner:'鈴木',deadline:null,assignment:'explicit',evidence:[]}]}});
  assert.equal(missing.actions[0].suppressReason,'evidence_missing');
});
test('根拠先頭発言に担当者名が無い場合は通知しない',()=>{
  // 根拠発言が担当を明示していない。
  const none=planFor({text:'配線を確認します。',owner:'鈴木',assignment:'explicit'});
  assert.equal(none.actions[0].notify,false);
  assert.equal(none.actions[0].suppressReason,'assignment_unsupported_no_assignee');
  // 根拠発言は別の人の担当を明示している（担当者名の取り違え）。
  const other=planFor({text:'池谷さんが確認してください',owner:'鈴木',assignment:'explicit'});
  assert.equal(other.actions[0].notify,false);
  assert.equal(other.actions[0].suppressReason,'owner_not_in_evidence');
});
test('候補ユーザーは通知可能な明示担当だけを返し、Guild照合は候補だけに絞る',async()=>{
  const {state,version}=fixture({text:'鈴木さんが確認してください',owner:'鈴木'});
  const candidates=candidateMentionUsers(state,version,dictionary(),{guildId:GUILD});
  assert.deepEqual(candidates,[KTO]);
  const fetched=[];
  const guild={members:{fetch:async id=>{fetched.push(id);return{user:{username:'ktokunn'}};}}};
  const plan=await prepareMentionPlan({state,version,dictionary:dictionary(),guild,guildId:GUILD,now:1000});
  assert.deepEqual(fetched,[KTO]);
  assert.deepEqual(plan.allowedUserIds,[KTO]);
  // 辞書ファイルからの読み込み経路（環境変数）も安全側に動く。
  const root=mkdtempSync(join(tmpdir(),'wg-alias-'));
  try{
    const file=join(root,'aliases.json');
    writeFileSync(file,JSON.stringify({schemaVersion:1,guildId:GUILD,notificationDefaults:{enabled:true},members:BASE_MEMBERS}));
    const loaded=await prepareMentionPlan({state,version,guild,guildId:GUILD,now:1000,loadDictionary:()=>loadAliasDictionary({env:{[ALIAS_FILE_ENV]:file}})});
    assert.deepEqual(loaded.allowedUserIds,[KTO]);
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('describeMentionPlanは純粋関数で、状態を変更せずnowを反映する',()=>{
  const {state,version}=fixture({text:'鈴木さんが確認してください',owner:'鈴木'});
  const before=JSON.stringify(state),dict=dictionary(),dictBefore=JSON.stringify(dict);
  const first=describeMentionPlan(state,version,dict,{guildId:GUILD,guildMembers:membership(),now:4242});
  const second=describeMentionPlan(state,version,dict,{guildId:GUILD,guildMembers:membership(),now:4242});
  assert.deepEqual(first,second);
  assert.equal(first.resolvedAt,4242);
  assert.equal(JSON.stringify(state),before);
  assert.equal(JSON.stringify(dict),dictBefore);
  assert.equal(first.dictionaryVersion,dict.version);
});

// --- 二重通知抑止 ---------------------------------------------------------
function snapshotFor({ownerUserId=KTO,evidence=[{utteranceId:'u1',revision:1}],notified=false,notify=true,text='アクション',owner='鈴木'}={}) {
  return normalizeMentionSnapshot({schemaVersion:1,guildId:GUILD,enabled:true,actions:[{actionIndex:0,assignment:'explicit',owner,ownerUserId,notify,notified,evidence,utteranceIds:evidence.map(ref=>ref.utteranceId),textDigest:null,displayName:owner}]});
}
function priorPublication(overrides={}) {
  return {version:1,channelId:'223456789012345678',status:'published',mentions:null,messageId:'423456789012345678',reservationId:'r1',...overrides};
}
test('同一会議・同一担当者・同一根拠の通知は版を跨いで1回だけ（already_notified）',()=>{
  const plan=planFor({text:'鈴木さんが確認してください',owner:'鈴木'},{planOptions:{priorPublications:[priorPublication({mentions:snapshotFor({notified:true})})]}});
  assert.deepEqual(plan.allowedUserIds,[]);
  assert.equal(plan.actions[0].suppressReason,'already_notified');
  // 別の担当者・別アクションは抑止しない。
  const otherOwner=planFor({text:'鈴木さんが確認してください',owner:'鈴木'},{planOptions:{priorPublications:[priorPublication({mentions:snapshotFor({ownerUserId:IKE})})]}});
  assert.deepEqual(otherOwner.allowedUserIds,[KTO]);
});
test('送信結果不明・旧形式・根拠訂正は「不明」として再通知しない',()=>{
  const unknownDelivery=planFor({text:'鈴木さんが確認してください',owner:'鈴木'},{planOptions:{priorPublications:[priorPublication({status:'needs_reconciliation',mentions:snapshotFor({notified:false})})]}});
  assert.equal(unknownDelivery.actions[0].suppressReason,'prior_delivery_unknown');
  const revisionChanged=planFor({text:'鈴木さんが確認してください',owner:'鈴木'},{planOptions:{priorPublications:[priorPublication({mentions:snapshotFor({notified:true,evidence:[{utteranceId:'u1',revision:0}]})})]}});
  assert.equal(revisionChanged.actions[0].suppressReason,'prior_revision_changed');
  const legacySameEvidence=planFor({text:'鈴木さんが確認してください',owner:'鈴木'},{planOptions:{priorPublications:[priorPublication({mentions:null})]}});
  assert.equal(legacySameEvidence.actions[0].suppressReason,'prior_state_unknown');
});
test('未送信が確定した記録は再通知を許可し、新規アクションは訂正版で通知する',()=>{
  const failed=planFor({text:'鈴木さんが確認してください',owner:'鈴木'},{planOptions:{priorPublications:[priorPublication({status:'failed_confirmed',mentions:snapshotFor({notified:false})})]}});
  assert.deepEqual(failed.allowedUserIds,[KTO]);
  // 訂正版: 既通知アクションは抑止、新規アクションだけ通知。
  const {state,version}=fixture({text:'鈴木さんが確認してください',owner:'鈴木'});
  version.document.actionItems.push({text:'池谷さんが資料をまとめる。',owner:'池谷',deadline:null,assignment:'explicit',evidence:[{utteranceId:'u2',revision:1}]});
  state.utterances.push({id:'u2',revision:1,text:'池谷さん、設計候補パーツを一覧にしてください',final:true,source:'discord'});
  state.publications=[priorPublication({mentions:snapshotFor({notified:true})})];
  const plan=describeMentionPlan(state,version,dictionary(),{guildId:GUILD,guildMembers:membership(),now:1000});
  assert.deepEqual(plan.allowedUserIds,[IKE]);
  assert.equal(plan.actions[0].suppressReason,'already_notified');
  assert.equal(plan.actions[1].notify,true);
});
test('送信後報告のnotifiedUserIdsはallowlistの部分集合だけを受け付け、不一致はfail-closed',()=>{
  const snapshot=snapshotFor({notified:false});
  const publication={status:'publish_reserved',mentions:snapshot};
  assert.deepEqual(verifyMentionDelivery(publication,[KTO]).accepted,[KTO]);
  assert.equal(verifyMentionDelivery(publication,[KTO]).ok,true);
  const rejected=verifyMentionDelivery(publication,[KTO,IKE]);
  assert.equal(rejected.ok,false);assert.deepEqual(rejected.accepted,[]);assert.deepEqual(rejected.rejected,[IKE]);
  assert.equal(verifyMentionDelivery(publication,['not-a-snowflake']).ok,true);
  const truncated=verifyMentionDelivery(publication,[]);
  assert.equal(truncated.ok,true);assert.deepEqual(truncated.accepted,[]);assert.deepEqual(truncated.truncated,[KTO]);
  markMentionNotifications(publication,[KTO],1234);
  assert.equal(publication.mentions.actions[0].notified,true);
  assert.equal(publication.mentions.actions[0].notifiedAt,1234);
  const noSnapshot=verifyMentionDelivery({status:'publish_reserved',mentions:null},[KTO]);
  assert.equal(noSnapshot.ok,false);
});
test('スナップショットは辞書版・Guild・assignmentEvidence・textDigestを保持し再現できる',()=>{
  const plan=planFor({text:'鈴木さんが確認してください',owner:'鈴木'});
  const snapshot=snapshotMentionPlan(plan);
  assert.equal(snapshot.schemaVersion,1);
  assert.equal(snapshot.guildId,GUILD);
  assert.equal(snapshot.dictionaryVersion,dictionary().version);
  assert.equal(snapshot.enabled,true);
  assert.equal(snapshot.resolvedAt,1000);
  assert.deepEqual(snapshot.allowedUserIds,[KTO]);
  assert.deepEqual(snapshot.actions[0].assignmentEvidence,{utteranceId:'u1',revision:1});
  assert.match(snapshot.actions[0].textDigest,/^[0-9a-f]{16}$/);
  assert.equal(snapshot.actions[0].notified,false);
  const reapplied=applyMentionSuppression(snapshot,{publications:[],minutesHistory:[]});
  assert.deepEqual(reapplied.allowedUserIds,[KTO]);
});

// --- プレビュー -----------------------------------------------------------
test('dry-runプレビューは表示名・根拠ref・抑止理由・辞書版を示し、生のuserIdを出さない',()=>{
  const {state,version}=fixture({text:'鈴木さんが確認してください',owner:'鈴木'});
  version.document.actionItems.push({text:'折原が調べる。',owner:'折原',deadline:null,assignment:'explicit',evidence:[{utteranceId:'u2',revision:1}]});
  state.utterances.push({id:'u2',revision:1,text:'折原が基板を調べると言っていた',final:true,source:'discord'});
  const preview=mentionPlanPreview(describeMentionPlan(state,version,dictionary(),{guildId:GUILD,guildMembers:membership(),now:1000}));
  assert.match(preview,/通知対象：ktokunn/);
  assert.match(preview,/根拠: u1@1/);
  assert.match(preview,/抑止: アクション2/);
  assert.match(preview,/根拠発言が明示担当を支持しない/);
  assert.match(preview,/別名辞書：v[0-9a-f]{16}／通知有効/);
  assert.ok(!preview.includes(KTO));
  assert.ok(!preview.includes(UNKNOWN_RAW));
  const empty=mentionPlanPreview(describeMentionPlan(state,version,null,{guildId:GUILD,now:1000}));
  assert.match(empty,/別名辞書が未設定/);
  assert.equal(mentionReasonLabel('already_notified'),'通知済み（同一アクション・同一担当者）');
  assert.equal(mentionReasonLabel('assignment_unsupported_past_mention'),'根拠発言が明示担当を支持しない');
});

// --- v1/v2正規形 ----------------------------------------------------------
test('canonicalMinutesDocumentはv1のideas/comparisonsとv2のdiscussionTopicsをtopicsへ写す',()=>{
  const v1={overview:[{text:'概要',evidence:[{utteranceId:'u1',revision:1}]}],ideas:[{text:'A案',evidence:[{utteranceId:'u1',revision:1}]}],comparisons:[{text:'比較',evidence:[{utteranceId:'u1',revision:1}]}],decisionCandidates:[],openIssues:[],actionItems:[{text:'やる',owner:'鈴木',deadline:null,evidence:[{utteranceId:'u1',revision:1}]}]};
  const canonical1=canonicalMinutesDocument(v1);
  assert.equal(canonical1.schemaVersion,1);
  assert.deepEqual(canonical1.topics.map(topic=>topic.topicKey),['ideas','comparisons']);
  assert.deepEqual(canonical1.topics[0].entries.map(entry=>entry.category),['idea']);
  assert.deepEqual(canonical1.topics[1].entries.map(entry=>entry.category),['comparison']);
  assert.equal(canonical1.actionItems[0].assignment,undefined);
  const v2={schemaVersion:2,overview:[],discussionTopics:[{topicKey:'t1',title:'価格',entries:[{category:'reason',text:'理由',evidence:[{utteranceId:'u1',revision:1}]}]}],decisionCandidates:[],openIssues:[],keyFacts:[{kind:'cost',text:'7000円',evidence:[{utteranceId:'u1',revision:1}]}],actionItems:[]};
  const canonical2=canonicalMinutesDocument(v2);
  assert.equal(canonical2.schemaVersion,2);
  assert.equal(canonical2.topics[0].title,'価格');
  assert.equal(canonical2.topics[0].entries[0].category,'reason');
  assert.equal(canonical2.keyFacts[0].text,'7000円');
});
