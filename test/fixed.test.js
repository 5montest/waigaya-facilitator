import test from 'node:test';
import assert from 'node:assert/strict';
import { fixedPolicy,validateChannels } from '../src/discord/fixed-policy.js';
import { detectAddress,VoiceAddressing } from '../src/discord/addressing.js';
import { Controller } from '../src/controller.js';
import { commandFor } from '../src/discord/commands.js';
import { applyPublication,publicationMarkdown,automaticPublicationAllowed } from '../src/publication.js';
import { emptyMinutes } from '../src/minutes.js';
import { fixedFixture,ids,waitFor } from './helpers/fixed.js';
const env={DISCORD_GUILD_ID:ids.guild,WAIGAYA_DISCORD_VOICE_CHANNEL_ID:ids.vc,WAIGAYA_DISCORD_MINUTES_FORUM_ID:ids.forum};
test('固定設定はID・応答方針・真偽値・猶予を検証し、既定はon_call・3分・自動公開',()=>{
 const p=fixedPolicy(env);assert.equal(p.responsePolicy,'on_call');assert.equal(p.emptyGraceMs,180000);assert.equal(p.autoPublish,true);assert.equal(fixedPolicy({}),null);assert.throws(()=>fixedPolicy({}, {required:true}));
 for(const overrides of [{WAIGAYA_DISCORD_MINUTES_FORUM_ID:'名前'},{WAIGAYA_DISCORD_RESPONSE_POLICY:'auto'},{WAIGAYA_DISCORD_AUTO_PUBLISH:'yes'},{WAIGAYA_DISCORD_EMPTY_GRACE_MS:'-1'}])assert.throws(()=>fixedPolicy({...env,...overrides}));
});
test('呼称は冒頭の直接依頼だけ検出し、話題・引用・部分一致・曖昧な文を起動にしない',()=>{
 for(const text of ['ワイガヤ、いまの話をまとめて','わいがや A案とB案どちらがよさそう？','我ヶ谷、ここで懸念はある？','ねえワイガヤ、どう思う？','ワイガヤさん、これどう？'])assert.equal(detectAddress(text).addressed,true,text);
 for(const text of ['ワイガヤっていうBotを作っている','前にワイガヤが言っていた件だけど','ワイガヤが言ったこと','ワイガヤという名前','ワイガヤを作る','このワイガヤに入る','ワイガヤ研究会で話した'])assert.equal(detectAddress(text).addressed,false,text);
 assert.equal(detectAddress('ワイガヤ').clarification,true);assert.equal(detectAddress('我が谷、まとめて').addressed,true);
});
test('固定コマンドは開始にモード・保存先を要求せず、汎用設定を隠しendと旧stopを区別する',()=>{
 const c=commandFor({fixed:true});assert.deepEqual(c.options.find(s=>s.name==='start').options.map(o=>o.name),['topic']);for(const name of ['setup','destination','mode','auto','publish','ask'])assert.ok(!c.options.some(s=>s.name===name));assert.match(c.options.find(s=>s.name==='end').description,/終了/);assert.match(c.options.find(s=>s.name==='stop').description,/記録は継続/);
});
test('音声依頼の生成は人の声だけでは取消さず、新しい意味ある確定発言・修正で取り消す',()=>{
 let now=1000;const c=new Controller({mode:'assistant',status:'recording',guildId:ids.guild,inputHealthy:true},()=>now);c.upsert({id:'call',source:'discord',userId:ids.owner,text:'ワイガヤ、二つの案の違いは？'});const ticket=c.beginRequest({mode:'voice_request',voiceRequest:{utteranceId:'call',revision:1,userId:ids.owner,question:'二つの案の違いは？'}});c.voice(true);assert.equal(c.state.request.status,'thinking');c.voice(false);now+=1000;
 assert.equal(c.accept({action:'summary',text:'違いを整理します。',evidence:[{utteranceId:'call',revision:1}],notes:[]},ticket),true);c.upsert({id:'solved',source:'discord',text:'A案は安くてB案は組立変更に対応できます。'});assert.equal(c.state.reply,null);assert.throws(()=>c.permitReply(ticket.requestId));assert.equal(c.state.voiceRequests[0].status,'cancelled');
});
test('自動公開は固定・通知済み・現行根拠の正式版だけで、人間の承認を捏造しない',()=>{
 const c=new Controller({guildId:ids.guild,status:'completed',fixedOperation:true,voiceChannelId:ids.vc,fixedVoiceChannelId:ids.vc,outputChannelId:ids.forum,fixedMinutesForumId:ids.forum,autoPublicationNoticeAt:1000,publicationPolicy:'auto_publish_ai_draft'});c.upsert({id:'u',source:'discord',text:'A案を試してみる案です。'});c.state.status='completed';const d=emptyMinutes();d.decisionCandidates=[{text:'A案の試行案。',evidence:[{utteranceId:'u',revision:1}]}];const v={version:1,kind:'minutes',document:d,approvedAt:null,approvedBy:null,confirmedDecisions:[],transcriptRefs:[{utteranceId:'u',revision:1}]};c.state.minutesHistory=[v];c.state.minutesVersion=1;
 assert.equal(automaticPublicationAllowed(c.state),true);applyPublication(c.state,{action:'publication_reserve',version:1,channelId:ids.forum,destinationType:'forum',actorId:ids.bot});assert.equal(v.approvedAt,null);assert.equal(c.state.publications[0].approvedMarkdown,null);assert.equal(c.state.publications[0].reviewStatus,'ai_unreviewed');assert.match(publicationMarkdown(c.state,v),/AI生成・未確認/);
 for(const change of [{autoPublicationNoticeAt:null},{outputChannelId:ids.other},{voiceChannelId:ids.otherVc}])assert.equal(automaticPublicationAllowed({...c.state,...change}),false);
});
test('VoiceAddressingは暫定・再送・Bot音源・名前だけの連呼を抑止し、キューは最新1件に限定する',async()=>{
 let resolve,now=1000,calls=0;const member={user:{bot:false}},s={status:'recording',mode:'assistant',inputHealthy:true,health:{},aiTurns:[],request:null};const current={acceptAudio:true,bridge:{state:s,path:'/mock',api:async()=>{},ask:async({voiceRequest,signal})=>{calls++;if(calls>1)return{reply:null};await new Promise(r=>{resolve=r;signal.addEventListener('abort',r,{once:true});});return{reply:null};},speakReply:async()=>{}},channel:{members:new Map([[ids.owner,member]])}};
 const a=new VoiceAddressing(current,{clock:()=>now});const u=(id,text,final=true)=>({id,text,revision:1,source:'discord',final});a.observe(u('p','ワイガヤ、まとめて',false),ids.owner);assert.equal(calls,0);a.observe(u('n','ワイガヤ'),ids.owner);a.observe(u('n','ワイガヤ'),ids.owner);await new Promise(r=>setTimeout(r,0));assert.equal(calls,1);a.observe(u('n2','ワイガヤ'),ids.owner);assert.equal(a.pending,null);
 a.observe(u('b','ワイガヤ、B案は？'),ids.owner);a.observe(u('c','ワイガヤ、C案は？'),ids.owner);resolve();await a.running;assert.ok(calls<=2);a.close();
});

test('呼びかけプロンプトは直接質問・情報回答だけを送り、AI発言を人の根拠にしない',async()=>{
 const {analyze,parseResult}=await import('../src/models.js');const old=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='mock-only';
 const state={topic:'比較',phase:'organize',decisions:[],aiTurns:[],utterances:[{id:'call',revision:2,final:true,text:'ワイガヤ、これはどんな仕組み？',source:'discord'},{id:'ai',revision:1,final:true,text:'全員合意した。',source:'ai'}],request:{mode:'voice_request',voiceRequest:{utteranceId:'call',revision:2,userId:ids.owner,question:'これはどんな仕組み？'}}};
 try{const r=await analyze({provider:'openai',model:'gpt-6.1-sol',state,fetchImpl:async(_,args)=>{const b=JSON.parse(args.body),input=JSON.parse(b.input);assert.match(b.instructions,/直接の質問/);assert.match(b.instructions,/公開・削除/);assert.match(b.instructions,/最新情報を調べたと偽りません/);assert.equal(b.tools,undefined);assert.equal(b.store,false);assert.equal(b.text.format.strict,true);assert.equal(input.utterances.length,1);assert.equal(input.voiceRequest.utteranceId,input.utterances[0].id);return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({action:'summary',text:'一般的にはこの仕組みです。',reason:'直接回答',notes:[],evidence:[{utteranceId:input.voiceRequest.utteranceId,revision:2}]})}]}],usage:{input_tokens:1,output_tokens:1}});}});assert.equal(r.result.evidence[0].utteranceId,'call');assert.throws(()=>parseResult(JSON.stringify({...r.result,evidence:[{utteranceId:'ai',revision:1}]}),state));}
 finally{if(old===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=old;}
});

test('固定先検証は削除・種類違い・別ギルド・フォーラム権限喪失を拒否する',async()=>{
 const {ChannelType}=await import('discord.js');const policy=fixedPolicy(env);const guild={id:ids.guild,members:{me:{}},channels:{fetch:async id=>channels.get(id)}};const all={has:()=>true};const channels=new Map([[ids.vc,{type:ChannelType.GuildVoice,guildId:ids.guild,permissionsFor:()=>all}],[ids.forum,{type:ChannelType.GuildForum,guildId:ids.guild,permissionsFor:()=>all}]]);
 await validateChannels(guild,policy);const forum=channels.get(ids.forum);forum.guildId=ids.other;await assert.rejects(()=>validateChannels(guild,policy));forum.guildId=ids.guild;forum.type=ChannelType.GuildText;await assert.rejects(()=>validateChannels(guild,policy));forum.type=ChannelType.GuildForum;forum.permissionsFor=()=>({has:()=>false});await assert.rejects(()=>validateChannels(guild,policy));channels.delete(ids.forum);await assert.rejects(()=>validateChannels(guild,policy));
});
