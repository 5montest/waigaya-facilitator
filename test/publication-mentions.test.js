import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType,Collection,PermissionFlagsBits,ChannelFlagsBitField } from 'discord.js';
import { Controller } from '../src/controller.js';
import { emptyMinutes } from '../src/minutes.js';
import { approveVersion,applyPublication,normalizeMentionSnapshot,normalizePublications } from '../src/publication.js';
import {
  DiscordMinutesPublisher,SHORT_MINUTES_LIMIT,applyMentionAllowlist,mentionTokensInContent,preparePublication,renderPublishedContent,shortMinutes,selectMinutesHighlights,
} from '../src/discord/minutes-publication.js';
import { parseAliasDictionary,snapshotMentionPlan,describeMentionPlan } from '../src/discord/owner-mentions.js';

// ダミーsnowflakeのみ（実アカウントと無関係）。
const GUILD='123456789012345678',CHANNEL='223456789012345678',OWNER='323456789012345678',THREAD='423456789012345678',BOT='523456789012345678',VC='623456789012345678';
const KTO='111111111111111111',IKE='222222222222222222',CLAY='444444444444444444',ETERNAL='555555555555555555',UNKNOWN_RAW='999999999999999999';
const members=[
  {userId:KTO,usernameHint:'ktokunn',displayNameHint:'ktokunn',aliases:['鈴木'],verified:true,enabled:true},
  {userId:IKE,usernameHint:'iketani_y',displayNameHint:'iketani_y',aliases:['池谷'],verified:true,enabled:true},
  {userId:CLAY,usernameHint:'claytoxicz',displayNameHint:'消防車もどき',aliases:['しみず','きよみず'],verified:true,enabled:true},
  {userId:ETERNAL,usernameHint:'eternalfriend17',displayNameHint:'孔明',aliases:['孔明','木村','まじぱね'],verified:true,enabled:true},
];
function dictionary({notificationDefaults={enabled:true},dictionaryMembers=members,guildId=GUILD}={}) {
  const {dictionary:parsed}=parseAliasDictionary({schemaVersion:1,guildId,notificationDefaults,members:dictionaryMembers});
  return parsed;
}
const ref=(utteranceId,revision=1)=>({utteranceId,revision});
const item=(text,utteranceId='u1')=>({text,evidence:[ref(utteranceId)]});
const action=(text,{owner=null,assignment='none',utteranceId='u1',deadline=null}={})=>({text,owner,deadline,assignment,evidence:[ref(utteranceId)]});
function v2Document({overview=[item('概要。')],topics=[],decisionCandidates=[],openIssues=[],keyFacts=[],actionItems=[]}={}) {
  return {schemaVersion:2,overview,discussionTopics:topics,decisionCandidates,openIssues,keyFacts,actionItems};
}
const UTTERANCES=[
  {id:'u1',revision:1,text:'鈴木さんが購入意向者の価格帯を確認してください。',final:true,source:'discord'},
  {id:'u2',revision:1,text:'池谷さん、設計候補パーツを一覧にしてください。',final:true,source:'discord'},
  {id:'u3',revision:1,text:'しみずさんに聞いてみようか？',final:true,source:'discord'},
  {id:'u4',revision:1,text:'まじぱねさん、図面のレビューをお願いします。',final:true,source:'discord'},
  {id:'u5',revision:1,text:'きよみずにお願いすることになりました。',final:true,source:'discord'},
];
function fixture({document,metadata={},approved=true,publications=[],membershipOverride}={}) {
  const state=new Controller({guildId:GUILD,voiceChannelId:VC,ownerId:OWNER,outputChannelId:CHANNEL,status:'completed',topic:'ロボット開発 @everyone'}).state;
  state.utterances=UTTERANCES.map(entry=>({...entry}));
  const version={version:1,kind:'minutes',document,metadata:{topic:state.topic,startedAt:Date.UTC(2026,9,8,17),endedAt:Date.UTC(2026,9,8,18),participantNames:['参加者A (323456789012345678)'],...metadata},confirmedDecisions:[],transcriptRefs:state.utterances.map(entry=>ref(entry.id)),approvedAt:null};
  state.minutesHistory=[version];state.minutesVersion=1;state.publications=publications;
  if(approved)approveVersion(state,version,OWNER);
  const all={has:()=>true},actor={id:OWNER},bot={id:BOT,user:{bot:true}};
  const sent=[],created=[];
  const thread={id:THREAD,parentId:CHANNEL,ownerId:BOT,archived:false,locked:false,permissionsFor:()=>all,send:async payload=>{sent.push(payload);return{id:'823456789012345678',url:`https://discord.com/channels/${GUILD}/${THREAD}/823456789012345678`};},setArchived:async value=>{thread.archived=value;}};
  const channel={id:CHANNEL,type:ChannelType.GuildForum,availableTags:[],flags:new ChannelFlagsBitField(),
    permissionsFor:member=>member===actor?{has:bits=>(Array.isArray(bits)?bits:[bits]).every(bit=>bit===PermissionFlagsBits.ViewChannel)}:all};
  channel.guild={id:GUILD,channels:{fetch:async id=>id===THREAD?thread:null},members:{fetch:async id=>{
    if(membershipOverride==='unavailable')throw new Error('members api unavailable');
    if(membershipOverride==='lookup_failed'){const error=new Error('lookup failed');error.code=500;throw error;}
    const member=members.find(entry=>entry.userId===id);
    if(!member||membershipOverride==='missing_all'){const error=new Error('Unknown Member');error.code=10007;throw error;}
    return {user:{username:member.usernameHint},displayName:member.displayNameHint};
  }}};
  channel.threads={create:async payload=>{created.push(payload);return thread;},fetchActive:async()=>({threads:new Collection([[THREAD,thread]])}),fetchArchived:async()=>({threads:new Collection(),hasMore:false})};
  channel.messages={fetch:async()=>new Collection()};
  channel.send=async payload=>{sent.push(payload);return{id:'923456789012345678',url:`https://discord.com/channels/${GUILD}/${CHANNEL}/923456789012345678`};};
  const api=async body=>{applyPublication(state,body);return structuredClone(state);};
  return {state,version,channel,thread,sent,created,api,actor,bot};
}
const publish=(r,{dictionary:dict=dictionary(),publisher=new DiscordMinutesPublisher(),mentions}={})=>publisher.publish({state:r.state,channel:r.channel,actor:r.actor,bot:r.bot,api:r.api,mentions:mentions??{dictionary:dict}});
const lastMessage=r=>r.sent.at(-1)??r.created.at(-1)?.message;
const contentOf=r=>lastMessage(r).content;

// --- shortMinutes（v1/v2描画） -------------------------------------------
test('shortMinutesはv1のideas/comparisonsを「議論の要点」へ重要度・論点分布で掲載し、各節2件固定にしない',()=>{
  const document=emptyMinutes();
  document.overview=[item('会議の概要。')];
  document.ideas=[item('A案。','u1'),item('B案。','u2'),item('C案。','u3')];
  document.comparisons=[item('A案は安いがB案は早い。','u1'),item('C案は部品が高い。','u2')];
  document.decisionCandidates=[item('D案を採用するか。','u1'),item('E案を保留するか。','u2'),item('F案を却下するか。','u3')];
  const {state,version}=fixture({document,metadata:{topic:'比較 @everyone'}});
  const content=shortMinutes(state,version);
  assert.match(content,/\*\*議論の要点\*\*/);
  assert.match(content,/\[比較\] A案は安いがB案は早い。/);
  assert.match(content,/\[案\] A案。/);
  const highlightLines=content.split('\n').filter(line=>line.startsWith('- ['));
  assert.ok(highlightLines.length>=3,`highlights=${highlightLines.length}`);
  assert.ok(Array.from(content).length<=SHORT_MINUTES_LIMIT);
  // v1文書でも担当は従来どおり表示する（通知はしない）。
  assert.ok(!content.includes('@everyone'));
  assert.ok(!content.includes('<@'));
  assert.ok(!content.includes('<@&'));
});
test('shortMinutesはv2の論点・カテゴリ・担当状態を表示し、@everyone/<@id>/<@&id>文字列を無害化する',()=>{
  const document=v2Document({
    overview:[item('価格と人員の議論。')],
    topics:[
      {topicKey:'価格',title:'価格帯',entries:[{category:'comparison',text:'2万円案と5千円案を比較した。',evidence:[ref('u1')]},{category:'reason',text:'原価7000円のため5千円は赤字。',evidence:[ref('u1')]}]},
      {topicKey:'人員',title:'人員配分',entries:[{category:'constraint',text:'新規構想と人員が競合する。',evidence:[ref('u2')]},{category:'disagreement',text:'優先順位は未確定で対立がある。',evidence:[ref('u2')]}]},
    ],
    keyFacts:[{kind:'cost',text:'部品原価は約7000円。',evidence:[ref('u1')]}],
    actionItems:[
      action('鈴木さんが価格帯を確認する。',{owner:'鈴木',assignment:'explicit',utteranceId:'u1'}),
      action('池谷さんが資料をまとめる（提案）。',{owner:'池谷',assignment:'proposed',utteranceId:'u2'}),
      action('担当未定の作業。',{owner:null,assignment:'none',utteranceId:'u3'}),
      action('担当が矛盾している作業。',{owner:null,assignment:'conflict',utteranceId:'u4'}),
      action(`@everyone <@${UNKNOWN_RAW}> <@&${GUILD}> を含む文字列。`,{owner:null,assignment:'none',utteranceId:'u5'}),
    ],
  });
  const {state,version}=fixture({document});
  const plan=describeMentionPlan(state,version,dictionary(),{guildId:GUILD,guildMembers:{available:true,members:new Map(members.map(entry=>[entry.userId,{found:true,username:entry.usernameHint}]))},now:1000});
  const content=shortMinutes(state,version,{mentions:plan});
  assert.match(content,/\[比較\] 2万円案と5千円案を比較した。/);
  assert.match(content,/\[制約\] 新規構想と人員が競合する。/);
  assert.match(content,/\[対立\] 優先順位は未確定で対立がある。/);
  assert.match(content,/\[事実\] 部品原価は約7000円。/);
  assert.match(content,/担当：<@111111111111111111>/);
  assert.match(content,/担当候補：池谷（通知しません）/);
  assert.match(content,/担当：担当者特定不可/);
  assert.match(content,/担当：担当未確定（要確認）/);
  assert.ok(!content.includes('@everyone'));
  assert.ok(!content.includes(`<@${UNKNOWN_RAW}>`));
  assert.ok(!content.includes('<@&'));
  assert.ok(Array.from(content).length<=SHORT_MINUTES_LIMIT);
  assert.equal((content.match(/確認済みの決定はありません/g)||[]).length,1);
});
test('本文の実トークンとallowedMentions allowlistを双方向に一致させる',()=>{
  const content='本文 <@111111111111111111> と <@999999999999999999> と <@222222222222222222>';
  const applied=applyMentionAllowlist(content,[KTO,IKE,CLAY]);
  assert.deepEqual(applied.userIds,[KTO,IKE]);
  assert.ok(applied.content.includes(`<@${KTO}>`));
  assert.ok(!applied.content.includes(`<@${UNKNOWN_RAW}>`));
  assert.ok(applied.content.includes('（通知対象外）'));
  const tokens=mentionTokensInContent(applied.content);
  assert.deepEqual([...tokens].sort(),[KTO,IKE].sort());
  // allowlistにあるが本文に無いIDは通知対象にしない。
  assert.ok(!applied.userIds.includes(CLAY));
});

// --- 送信時のメンション・allowlist --------------------------------------
test('明示担当だけを <@id> トークンで差し込み、allowedMentionsはusers allowlist（parse禁止）にする',async()=>{
  const document=v2Document({
    actionItems:[
      action('鈴木さんが価格帯を確認する。',{owner:'鈴木',assignment:'explicit',utteranceId:'u1'}),
      action('池谷さんが資料をまとめる（提案）。',{owner:'池谷',assignment:'proposed',utteranceId:'u2'}),
      action('しみずさんに聞いてみようか？',{owner:'しみず',assignment:'proposed',utteranceId:'u3'}),
    ],
  });
  const r=fixture({document});
  await publish(r);
  const message=lastMessage(r);
  const content=message.content;
  const tokens=mentionTokensInContent(content);
  assert.deepEqual(tokens,[KTO]);
  assert.deepEqual(message.allowedMentions,{parse:[],users:[KTO],repliedUser:false});
  // 双方向一致: usersのIDは本文にトークンがあり、本文のトークンはすべてusersに含まれる。
  for(const id of message.allowedMentions.users)assert.ok(content.includes(`<@${id}>`));
  for(const id of tokens)assert.ok(message.allowedMentions.users.includes(id));
  assert.ok(!content.includes('@everyone'));
  assert.ok(!content.includes('<@&'));
  assert.ok(Array.from(content).length<=2000);
  const publication=r.state.publications.find(entry=>entry.version===1);
  assert.equal(publication.status,'published');
  assert.equal(publication.mentions.enabled,true);
  assert.equal(publication.mentions.dictionaryVersion,dictionary().version);
  assert.deepEqual(publication.mentions.allowedUserIds,[KTO]);
  assert.equal(publication.mentions.actions[0].notified,true);
  assert.equal(publication.mentions.actions[0].ownerUserId,KTO);
  assert.equal(publication.mentions.actions[0].notifiedAt>0,true);
  assert.equal(publication.mentionDelivery.ok,true);
  assert.equal(publication.mentionDelivery.notifiedCount,1);
  assert.ok(!content.includes('waigaya:'));
});
test('辞書無効・未検証・別名衝突・他Guild・Guildメンバー取得不可は通知せず従来どおり全抑止する',async()=>{
  const document=v2Document({actionItems:[action('鈴木さんが価格帯を確認する。',{owner:'鈴木',assignment:'explicit',utteranceId:'u1'})]});
  const cases=[
    {name:'辞書なし',mentions:{dictionary:null}},
    {name:'通知無効',mentions:{dictionary:dictionary({notificationDefaults:{enabled:false}})}},
    {name:'未検証',mentions:{dictionary:dictionary({dictionaryMembers:[{...members[0],verified:false}]})}},
    {name:'別名衝突',mentions:{dictionary:dictionary({dictionaryMembers:[{...members[0]},{userId:IKE,usernameHint:'iketani_y',displayNameHint:'iketani_y',aliases:['鈴木'],verified:true,enabled:true}]})}},
    {name:'他Guild',mentions:{dictionary:dictionary({guildId:'999999999999999999'})}},
    {name:'Guild照合不可',mentions:{dictionary:dictionary()},membershipOverride:'unavailable'},
    {name:'Guild照合失敗',mentions:{dictionary:dictionary()},membershipOverride:'lookup_failed'},
    {name:'Guild在籍なし',mentions:{dictionary:dictionary()},membershipOverride:'missing_all'},
  ];
  for(const entry of cases){
    const r=fixture({document,membershipOverride:entry.membershipOverride});
    await publish(r,entry.mentions?{...entry.mentions}:{});
    const message=lastMessage(r);
    assert.deepEqual(mentionTokensInContent(message.content),[],entry.name);
    assert.deepEqual(message.allowedMentions,{parse:[]},entry.name);
    const publication=r.state.publications.find(row=>row.version===1);
    assert.deepEqual(publication.mentions?.allowedUserIds??[], [], entry.name);
    assert.equal(publication.mentions?.actions?.[0]?.notified??false,false,entry.name);
  }
});
test('v1文書は本文表示のみでメンションしない（後方互換）',async()=>{
  const document=emptyMinutes();
  document.overview=[item('概要。')];
  document.actionItems=[{text:'鈴木さんが価格帯を確認する。',owner:'鈴木',deadline:null,evidence:[ref('u1')]}];
  const r=fixture({document});
  await publish(r);
  const message=lastMessage(r);
  assert.deepEqual(mentionTokensInContent(message.content),[]);
  assert.deepEqual(message.allowedMentions,{parse:[]});
  assert.match(message.content,/担当：鈴木/);
  assert.equal(r.state.publications[0].mentions.actions[0].suppressReason,'legacy_document');
});
test('訂正版では既通知アクションを抑止し、新規割当だけを通知する',async()=>{
  const r=fixture({document:v2Document({actionItems:[action('鈴木さんが価格帯を確認する。',{owner:'鈴木',assignment:'explicit',utteranceId:'u1'})]})});
  await publish(r);
  assert.deepEqual(mentionTokensInContent(contentOf(r)),[KTO]);
  // 版2: 同一アクション（根拠u1・担当鈴木）は通知済み、新規アクション（池谷・根拠u2）だけ通知。
  const version2={...structuredClone(r.version),version:2,approvedAt:null,approvedMarkdown:null,
    document:v2Document({actionItems:[
      action('鈴木さんが価格帯を確認する。',{owner:'鈴木',assignment:'explicit',utteranceId:'u1'}),
      action('池谷さんが設計候補パーツを一覧にする。',{owner:'池谷',assignment:'explicit',utteranceId:'u2'}),
    ]})};
  r.state.minutesHistory.push(version2);r.state.minutesVersion=2;approveVersion(r.state,version2,OWNER);
  await publish(r);
  const message=lastMessage(r);
  assert.deepEqual(mentionTokensInContent(message.content),[IKE]);
  assert.deepEqual(message.allowedMentions,{parse:[],users:[IKE],repliedUser:false});
  assert.match(message.content,/訂正版を追加しました/);
  const publication=r.state.publications.find(entry=>entry.version===2);
  assert.deepEqual(publication.mentions.allowedUserIds,[IKE]);
  assert.equal(publication.mentions.actions[0].suppressReason,'already_notified');
  assert.equal(publication.mentions.actions[1].notified,true);
  // 版1の記録は改ざんしない。
  assert.deepEqual(r.state.publications.find(entry=>entry.version===1).mentions.allowedUserIds,[KTO]);
});
test('根拠が訂正されたアクションは再通知しない（不明扱いで抑止）',async()=>{
  const prior=normalizeMentionSnapshot({schemaVersion:1,guildId:GUILD,enabled:true,actions:[{actionIndex:0,assignment:'explicit',owner:'鈴木',ownerUserId:KTO,notify:true,notified:true,evidence:[{utteranceId:'u1',revision:0}],utteranceIds:['u1'],textDigest:null,displayName:'ktokunn'}]});
  const r=fixture({document:v2Document({actionItems:[action('鈴木さんが価格帯を確認する。',{owner:'鈴木',assignment:'explicit',utteranceId:'u1'})]}),
    publications:[{version:0,channelId:CHANNEL,status:'published',messageId:THREAD,threadId:THREAD,reservationId:'r0',mentions:prior,markdownHash:'x'}]});
  await publish(r);
  const message=lastMessage(r);
  assert.deepEqual(mentionTokensInContent(message.content),[]);
  assert.deepEqual(message.allowedMentions,{parse:[]});
  assert.equal(r.state.publications.at(-1).mentions.actions[0].suppressReason,'prior_revision_changed');
});
test('旧形式（mentions記録なし）の公開済み版と同じ根拠のアクションは再通知しない',async()=>{
  const legacyVersion={...structuredClone(fixture({document:v2Document({actionItems:[action('鈴木さんが価格帯を確認する。',{owner:'鈴木',assignment:'explicit',utteranceId:'u1'})]})}).version),version:1,approvedAt:123,approvedMarkdown:'# 旧版',transcriptRefs:UTTERANCES.map(entry=>ref(entry.id))};
  const r=fixture({document:v2Document({actionItems:[action('鈴木さんが価格帯を確認する。',{owner:'鈴木',assignment:'explicit',utteranceId:'u1'})]}),
    publications:[{version:1,channelId:CHANNEL,status:'published',messageId:THREAD,threadId:THREAD,reservationId:'legacy',mentions:null,markdownHash:'x'}]});
  // 旧版のdocumentを履歴に残し、現在の正式版を版2にする。
  r.version.version=2;r.state.minutesVersion=2;
  r.state.minutesHistory=[legacyVersion,r.version];
  await publish(r);
  assert.deepEqual(mentionTokensInContent(contentOf(r)),[]);
  assert.equal(r.state.publications.at(-1).mentions.actions[0].suppressReason,'prior_state_unknown');
});
test('未送信が確認済み（failed_confirmed）の記録は再通知を許可する',async()=>{
  const r=fixture({document:v2Document({actionItems:[action('鈴木さんが価格帯を確認する。',{owner:'鈴木',assignment:'explicit',utteranceId:'u1'})]})});
  r.channel.threads.create=async()=>{const error=new Error('forbidden');error.status=403;throw error;};
  await assert.rejects(()=>publish(r),/受け付けません/);
  assert.equal(r.state.publications[0].status,'failed_confirmed');
  assert.equal(r.state.publications[0].mentions.actions[0].notified,false);
  r.channel.threads.create=async payload=>{r.created.push(payload);return r.thread;};
  await publish(r);
  const message=lastMessage(r);
  assert.deepEqual(mentionTokensInContent(message.content),[KTO]);
  assert.equal(r.state.publications.at(-1).status,'published');
  assert.equal(r.state.publications.at(-1).mentions.actions[0].notified,true);
});
test('本文長でトークンを落とす場合は通知せず「担当者特定不可」へフォールバックする',()=>{
  const longName='あ'.repeat(40),longDeadline='い'.repeat(40),longText='う'.repeat(200);
  const actions=[
    action('きよみずにお願いすることになりました。',{owner:'きよみず',assignment:'explicit',utteranceId:'u5'}),
    action(longText,{owner:longName,assignment:'explicit',utteranceId:'u1',deadline:longDeadline}),
    action(longText,{owner:'鈴木',assignment:'explicit',utteranceId:'u1'}),
    action(longText,{owner:longName,assignment:'explicit',utteranceId:'u2',deadline:longDeadline}),
    action(longText,{owner:longName,assignment:'explicit',utteranceId:'u3',deadline:longDeadline}),
  ];
  const {state,version}=fixture({document:v2Document({actionItems:actions})});
  const plan={enabled:true,reason:null,dictionaryVersion:dictionary().version,resolvedAt:1000,allowedUserIds:[CLAY,KTO],
    actions:[
      {actionIndex:0,assignment:'explicit',owner:'きよみず',ownerUserId:CLAY,resolution:'resolved',suppressReason:null,notify:true,displayName:'消防車もどき'},
      {actionIndex:1,assignment:'explicit',owner:longName,ownerUserId:ETERNAL,resolution:'resolved',suppressReason:'prior_revision_changed',notify:false,displayName:'孔明'},
      {actionIndex:2,assignment:'explicit',owner:'鈴木',ownerUserId:KTO,resolution:'resolved',suppressReason:null,notify:true,displayName:'ktokunn'},
      {actionIndex:3,assignment:'explicit',owner:longName,ownerUserId:ETERNAL,resolution:'resolved',suppressReason:'prior_revision_changed',notify:false,displayName:'孔明'},
      {actionIndex:4,assignment:'explicit',owner:longName,ownerUserId:ETERNAL,resolution:'resolved',suppressReason:'prior_revision_changed',notify:false,displayName:'孔明'},
    ]};
  // 通常のDiscord上限では本文が収まる。切り捨てが起きる上限を明示して同じフォールバック経路を通す。
  const content=shortMinutes(state,version,{mentions:plan,limit:480});
  assert.ok(Array.from(content).length<=480,`length=${Array.from(content).length}`);
  assert.deepEqual(mentionTokensInContent(content),[CLAY]);
  assert.match(content,/担当者特定不可（本文の長さ制限）/);
  const rendered=renderPublishedContent(state,version,plan);
  assert.deepEqual(rendered.userIds,[CLAY,KTO]);
  assert.ok(Array.from(rendered.content).length<=SHORT_MINUTES_LIMIT);
});
test('送信後報告のnotifiedUserIdsがallowlist外ならfail-closedで通知済みにしない',async()=>{
  const document=v2Document({actionItems:[action('鈴木さんが価格帯を確認する。',{owner:'鈴木',assignment:'explicit',utteranceId:'u1'})]});
  const r=fixture({document,approved:true});
  const plan=describeMentionPlan(r.state,r.version,dictionary(),{guildId:GUILD,guildMembers:{available:true,members:new Map(members.map(entry=>[entry.userId,{found:true,username:entry.usernameHint}]))},now:1000});
  await r.api({action:'publication_reserve',version:1,channelId:CHANNEL,destinationType:'forum',actorId:OWNER,outputRevision:0,mentions:snapshotMentionPlan(plan)});
  const publication=r.state.publications[0];
  assert.deepEqual(publication.mentions.allowedUserIds,[KTO]);
  applyPublication(r.state,{action:'publication',version:1,channelId:CHANNEL,reservationId:publication.reservationId,messageId:THREAD,notifiedUserIds:[KTO,IKE]});
  assert.equal(publication.status,'published');
  assert.equal(publication.mentions.actions[0].notified,false);
  assert.equal(publication.mentionDelivery.ok,false);
  assert.equal(publication.mentionDelivery.reason,'notified_user_not_allowed');
});
test('照合で復旧した送信は通知済みとして扱い、以後の版で再通知しない',async()=>{
  const r=fixture({document:v2Document({actionItems:[action('鈴木さんが価格帯を確認する。',{owner:'鈴木',assignment:'explicit',utteranceId:'u1'})]})});
  const plan=describeMentionPlan(r.state,r.version,dictionary(),{guildId:GUILD,guildMembers:{available:true,members:new Map(members.map(entry=>[entry.userId,{found:true,username:entry.usernameHint}]))},now:1000});
  await r.api({action:'publication_reserve',version:1,channelId:CHANNEL,destinationType:'forum',actorId:OWNER,outputRevision:0,mentions:snapshotMentionPlan(plan)});
  const publication=r.state.publications[0];
  applyPublication(r.state,{action:'publication_link',version:1,channelId:CHANNEL,reservationId:publication.reservationId,messageId:THREAD,actorId:OWNER});
  assert.equal(publication.mentions.actions[0].notified,true);
  // 版2で同じアクションを再公開しても通知しない。
  const version2={...structuredClone(r.version),version:2,approvedAt:null,approvedMarkdown:null};
  r.state.minutesHistory.push(version2);r.state.minutesVersion=2;approveVersion(r.state,version2,OWNER);
  await publish(r);
  assert.deepEqual(mentionTokensInContent(contentOf(r)),[]);
  assert.equal(r.state.publications.at(-1).mentions.actions[0].suppressReason,'already_notified');
});

// --- dry-run / 正規化 ----------------------------------------------------
test('preparePublicationは送信前dry-runとして通知対象・根拠・抑止理由を返し、生のuserIdを本文に出さない',async()=>{
  const document=v2Document({actionItems:[
    action('鈴木さんが価格帯を確認する。',{owner:'鈴木',assignment:'explicit',utteranceId:'u1'}),
    action('池谷さんが資料をまとめる（提案）。',{owner:'池谷',assignment:'proposed',utteranceId:'u2'}),
  ]});
  const r=fixture({document});
  const prepared=await preparePublication({state:r.state,channel:r.channel,actor:r.actor,bot:r.bot,mentions:{dictionary:dictionary()}});
  assert.match(prepared.mentionSummary,/通知対象：ktokunn/);
  assert.match(prepared.mentionSummary,/根拠: u1@1/);
  assert.match(prepared.mentionSummary,/担当候補の提案のみ/);
  assert.ok(!prepared.mentionSummary.includes(KTO));
  assert.deepEqual(prepared.mentionsSnapshot.allowedUserIds,[KTO]);
  assert.equal(prepared.mentionsSnapshot.actions[0].notified,false);
  assert.match(prepared.content,/担当：<@111111111111111111>/);
  assert.equal(r.created.length,0);
  assert.equal(r.sent.length,0);
  assert.equal(r.state.publications.length,0);
});
test('normalizePublicationsは旧記録のmentionsをnull補完し、既存の二重投稿防止記録を壊さない',()=>{
  const state=new Controller({guildId:GUILD,voiceChannelId:VC,ownerId:OWNER,outputChannelId:CHANNEL,status:'completed'}).state;
  state.publications=[{version:1,channelId:CHANNEL,status:'published',messageId:THREAD},{version:2,channelId:CHANNEL,status:'pending'}];
  normalizePublications(state);
  assert.equal(state.publications[0].mentions,null);
  assert.equal(state.publications[1].status,'needs_reconciliation');
  assert.ok(state.publications[0].reservationId);
});
test('selectMinutesHighlightsは重複を除き論点を分散し、決定候補より重要度の高い比較・制約を優先する',()=>{
  const document={schemaVersion:2,overview:[],topics:[
    {topicKey:'a',title:'論点A',entries:[{category:'background',text:'背景A',evidence:[]},{category:'comparison',text:'比較Aは数値7000円。',evidence:[]}]},
    {topicKey:'b',title:'論点B',entries:[{category:'constraint',text:'制約B。',evidence:[]},{category:'comparison',text:'比較Aは数値7000円。',evidence:[]}]},
    {topicKey:'c',title:'論点C',entries:[{category:'reason',text:'理由C。',evidence:[]}]},
  ],decisionCandidates:[],openIssues:[],keyFacts:[],actionItems:[]};
  const highlights=selectMinutesHighlights(document,{max:6});
  const texts=highlights.map(entry=>entry.text);
  assert.equal(new Set(texts).size,texts.length);
  assert.ok(texts.includes('比較Aは数値7000円。'));
  assert.ok(highlights.some(entry=>entry.topic==='論点B'));
  assert.ok(highlights.some(entry=>entry.topic==='論点C'));
});

test('publication_recoverは旧記録とmentions付き記録を保持したまま照合待ちにし、再送しない',()=>{
  const state=new Controller({guildId:GUILD,voiceChannelId:VC,ownerId:OWNER,outputChannelId:CHANNEL,status:'completed'}).state;
  const priorSnapshot=normalizeMentionSnapshot({schemaVersion:1,guildId:GUILD,enabled:true,actions:[{actionIndex:0,assignment:'explicit',owner:'鈴木',ownerUserId:KTO,notify:true,notified:false,evidence:[ref('u1')],utteranceIds:['u1'],textDigest:null,displayName:'ktokunn'}]});
  state.publications=[{version:1,channelId:CHANNEL,status:'pending',mentions:null},{version:2,channelId:CHANNEL,status:'publish_reserved',mentions:priorSnapshot}];
  applyPublication(state,{action:'publication_recover'});
  assert.ok(state.publications.every(entry=>entry.status==='needs_reconciliation'));
  assert.equal(state.publications[0].mentions,null);
  assert.equal(state.publications[1].mentions.actions[0].notify,true);
  assert.equal(state.publications[1].mentions.actions[0].notified,false);
  // 照合待ちの記録は再送せず、通知済みにもしない（不明扱いのまま）。
  assert.equal(state.publications[1].status,'needs_reconciliation');
  assert.equal(state.publications[1].mentionDelivery??null,null);
});
