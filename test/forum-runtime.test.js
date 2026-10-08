import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter,once } from 'node:events';
import { ChannelType,Collection,Events,PermissionFlagsBits } from 'discord.js';
import { Store } from '../src/store.js';
import { createApp } from '../src/server.js';
import { runBot } from '../src/discord/bot.js';
import { emptyMinutes } from '../src/minutes.js';
const guildId='123456789012345678',vcId='223456789012345678',ownerId='323456789012345678',forumId='423456789012345678',threadId='523456789012345678',botId='623456789012345678',textId='723456789012345678';
async function fixture(){
 const previous=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='mock-only';const store=new Store(':memory:');let generated=0;
 const app=createApp({store,serviceToken:'test-service',minutesGenerator:{generateDraft:async state=>{generated++;const d=emptyMinutes(),u=state.utterances[0];if(u)d.overview=[{text:'配線図の試行を検討した。',evidence:[{utteranceId:u.id,revision:u.revision}]}];return d;}}});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');const base=`http://127.0.0.1:${app.server.address().port}`;
 const api=async(path,body,authorized=true)=>{const response=await fetch(base+path,{method:body?'POST':'GET',headers:{origin:base,'content-type':'application/json',...(authorized?{authorization:'Bearer test-service'}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,body:await response.json()};};
 const replies=[],created=[],sent=[],all={has:()=>true};const member={id:ownerId,user:{bot:false},displayName:'主催者'},bot={id:botId,user:{bot:true}};
 const actorPermissions={has:bits=>(Array.isArray(bits)?bits:[bits]).every(b=>[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.Connect].includes(b))};
 const vc={id:vcId,name:'模擬会議室',type:ChannelType.GuildVoice,members:new Collection([[ownerId,member]]),permissionsFor:()=>all,send:async()=>({id:'notice'})};
 const thread={id:threadId,parentId:forumId,ownerId:botId,permissionsFor:()=>all,send:async payload=>{sent.push(payload);return{id:'823456789012345678',url:`https://discord.com/channels/${guildId}/${threadId}/823456789012345678`};}};
 const forum={id:forumId,type:ChannelType.GuildForum,availableTags:[],flags:{has:()=>false},permissionsFor:m=>m===member?actorPermissions:all,threads:{create:async payload=>{created.push(payload);return thread;}}};
 const text={id:textId,type:ChannelType.GuildText,permissionsFor:()=>all,send:async payload=>{sent.push(payload);return{id:'923456789012345678',url:`https://discord.com/channels/${guildId}/${textId}/923456789012345678`};}};
 const channels=new Collection([[vcId,vc],[forumId,forum],[threadId,thread],[textId,text]]),guild={id:guildId,members:{me:bot},voiceStates:{cache:new Collection([[ownerId,{channel:vc,channelId:vcId}]])},channels:{fetch:async id=>channels.get(id)||null}};for(const c of channels.values())c.guild=guild;
 const client=new EventEmitter();client.user={id:botId};client.login=async()=>{};client.destroy=()=>{};client.users={fetch:async()=>({send:async()=>{}})};
 const connection=new EventEmitter(),speaking=new EventEmitter();speaking.users=new Set();connection.subscribe=()=>{};connection.destroy=()=>{};connection.receiver={speaking,subscribe:()=>{throw new Error('no audio in UI test');}};let joins=0;
 const runtime=await runBot({client,join:()=>{joins++;return connection;},ready:async()=>{},config:{guildId,server:base,serviceToken:'test-service',token:'mock-only',controlRoleIds:[]}});
 function interaction({action='minutes',customId,values,userId=ownerId,admin=false,strings={},channel,clear=false,kind='command'}={}){return{commandName:kind==='command'?'waigaya':undefined,guildId,user:{id:userId},member,memberPermissions:{has:()=>admin},guild,customId,values,options:{getSubcommand:()=>action,getString:key=>strings[key]||null,getChannel:()=>channel,getBoolean:()=>clear,getFocused:()=>''},isChatInputCommand:()=>kind==='command',isAutocomplete:()=>kind==='autocomplete',isButton:()=>kind==='button',isStringSelectMenu:()=>kind==='select',isChannelSelectMenu:()=>kind==='channel',isModalSubmit:()=>false,deferred:false,replied:false,async deferReply(){this.deferred=true;},async deferUpdate(){this.deferred=true;},async editReply(v){replies.push(v);this.replied=true;},async reply(v){replies.push(v);this.replied=true;},async respond(v){replies.push(v);}};}
 const dispatch=async options=>{const i=interaction(options);if(options?.foreignGuild)i.guildId='999999999999999999';await Promise.all(client.listeners(Events.InteractionCreate).map(h=>h(i)));return replies.at(-1);};
 let state;
 const create=async({outputChannelId=forumId,finish=true}={})=>{
  state=(await api('/api/sessions',{discord:{guildId,voiceChannelId:vcId,ownerId,recordingNoticeSentAt:Date.now(),outputChannelId},mode:'minutes'})).body;
  await api(`/api/sessions/${state.id}/events`,{type:'lifecycle',action:'start'});await api(`/api/sessions/${state.id}/events`,{type:'utterance',utterance:{id:'u',source:'discord',text:'配線図を小規模に試行する案を検討します。',final:true}});
  if(finish){await api(`/api/sessions/${state.id}/finish`,{});for(let i=0;i<100;i++){state=(await api(`/api/sessions/${state.id}`)).body;if(state.status==='completed')break;await new Promise(r=>setTimeout(r,10));}}
  return state;
 };
 const get=async()=> (await api(`/api/sessions/${state.id}`)).body;
 return{store,app,client,guild,member,forum,text,created,sent,replies,dispatch,api,create,get,generated:()=>generated,joins:()=>joins,close:async()=>{await runtime.close();await app.close();if(previous===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=previous;}};
}
test('模擬Discord: 非公開下書きから最終確認・承認・フォーラム投稿・版2追記まで完遂する',async()=>{
 const r=await fixture();try{const state=await r.create();const preview=await r.dispatch();assert.equal(preview.files.length,3);assert.match(preview.content,/正式議事録/);assert.equal(r.created.length,0);
  let review=await r.dispatch({kind:'button',customId:`wg:review:${state.id}:1:${ownerId}`});assert.match(review.content,/親チャンネルを閲覧できる全員/);assert.match(review.content,/版1/);assert.equal((await r.get()).minutesHistory[0].approvedAt,null);
  const confirmation=review.components[0].components[0].data.custom_id;const result=await r.dispatch({kind:'button',customId:confirmation});assert.match(result.content,/投稿しました/);assert.match(result.content,/discord.com\/channels/);assert.equal(r.created.length,1);assert.ok((await r.get()).minutesHistory[0].approvedAt);assert.equal((await r.get()).publications[0].status,'published');await r.dispatch({kind:'button',customId:confirmation});assert.equal(r.created.length,1);
  const latest=await r.get(),document=structuredClone(latest.minutesHistory[0].document);document.overview[0].text='配線図の試行案について本文を訂正した。';await r.api(`/api/sessions/${state.id}/minutes`,{action:'edit',version:1,document,actorId:ownerId});review=await r.dispatch({kind:'button',customId:`wg:review:${state.id}:2:${ownerId}`});await r.dispatch({kind:'button',customId:review.components[0].components[0].data.custom_id});assert.equal(r.created.length,1);assert.equal(r.sent.length,1);assert.equal((await r.get()).publications[1].threadId,threadId);
 }finally{await r.close();}
});
test('模擬Discord: 保存先なしの会議を後から設定でき、確認中の保存先変更で古いボタンは失効する',async()=>{
 const r=await fixture();try{const state=await r.create({outputChannelId:null});let response=await r.dispatch({kind:'button',customId:`wg:review:${state.id}:1:${ownerId}`});assert.match(response.content,/保存先が未設定/);assert.equal(r.created.length,0);
  await r.dispatch({action:'destination',channel:r.forum});response=await r.dispatch({kind:'button',customId:`wg:review:${state.id}:1:${ownerId}`});const old=response.components[0].components[0].data.custom_id;await r.dispatch({action:'destination',channel:r.text});response=await r.dispatch({kind:'button',customId:old});assert.match(response.content,/保存先が変わりました/);assert.equal(r.created.length,0);assert.equal(r.sent.length,0);assert.equal((await r.get()).minutesHistory[0].approvedAt,null);
  response=await r.dispatch({kind:'button',customId:`wg:review:${state.id}:1:${ownerId}`});assert.match(response.content,/テキスト/);await r.dispatch({kind:'button',customId:response.components[0].components[0].data.custom_id});assert.equal(r.sent.length,1);
 }finally{await r.close();}
});
test('模擬Discord: 管理者のみ既定保存先を設定し、会議明示指定が既定より優先する',async()=>{
 const r=await fixture();try{let response=await r.dispatch({action:'setup',channel:r.forum});assert.match(response.content,/管理者/);assert.equal((await r.api(`/api/guilds/${guildId}/settings`)).body.defaultMinutesChannelId,null);await r.dispatch({action:'setup',channel:r.forum,admin:true});assert.equal((await r.api(`/api/guilds/${guildId}/settings`)).body.defaultMinutesChannelId,forumId);
  let state=(await r.api('/api/sessions',{discord:{guildId,voiceChannelId:vcId,ownerId}})).body;assert.equal(state.outputChannelId,forumId);state=(await r.api('/api/sessions',{discord:{guildId,voiceChannelId:vcId,ownerId,outputChannelId:textId}})).body;assert.equal(state.outputChannelId,textId);assert.equal((await r.api(`/api/guilds/${guildId}/settings`,undefined,false)).status,403);
 }finally{await r.close();}
});
test('模擬Discord: 他人・他ギルド・autocomplete・古い確認画面から会議タイトルと添付を漏らさない',async()=>{
 const r=await fixture();try{const state=await r.create();let response=await r.dispatch({userId:'other',strings:{meeting:state.id}});assert.match(response.content,/開始した人か/);assert.equal(response.files,undefined);assert.ok(!response.content.includes(state.topic));response=await r.dispatch({kind:'autocomplete',userId:'other'});assert.deepEqual(response,[]);
  response=await r.dispatch({kind:'button',userId:'other',customId:`wg:review:${state.id}:1:${ownerId}`});assert.equal(response.files,undefined);assert.equal(r.created.length,0);response=await r.dispatch({kind:'button',customId:`wg:review:${state.id}:0:${ownerId}`});assert.match(response.content,/版が変わりました/);
 }finally{await r.close();}
});
test('API: 途中要約は承認拒否、投稿成功後の保存失敗では公開済みと誤表示しない',async()=>{
 const r=await fixture();try{let state=await r.create({finish:false});await r.api(`/api/sessions/${state.id}/summary`,{});for(let i=0;i<100;i++){state=await r.get();if(state.minutesVersion)break;await new Promise(done=>setTimeout(done,10));}assert.equal(state.minutesHistory[0].kind,'summary');assert.equal((await r.api(`/api/sessions/${state.id}/minutes`,{action:'approve',version:1})).status,400);
  await r.api(`/api/sessions/${state.id}/finish`,{});for(let i=0;i<100;i++){state=await r.get();if(state.status==='completed')break;await new Promise(done=>setTimeout(done,10));}let response=await r.dispatch({kind:'button',customId:`wg:review:${state.id}:${state.minutesVersion}:${ownerId}`});const save=r.store.save.bind(r.store);r.store.save=(s,kind,...rest)=>{if(kind==='publication')throw new Error('private DB exception');return save(s,kind,...rest);};response=await r.dispatch({kind:'button',customId:response.components[0].components[0].data.custom_id});assert.match(response.content,/送信は完了.*保存/);assert.equal(r.created.length,1);assert.equal((await r.get()).publications[0].status,'needs_reconciliation');assert.ok((await r.get()).minutesHistory.at(-1).approvedAt);assert.ok(!JSON.stringify(response).includes('private DB'));
 }finally{await r.close();}
});

test('模擬Discord: モード選択は一度だけ開始し、他人・期限切れ・二度目のメニューでは再記録しない',async()=>{
 const r=await fixture();try{
  let response=await r.dispatch({action:'start'});const customId=response.components[0].components[0].data.custom_id;response=await r.dispatch({kind:'select',customId,values:['minutes'],userId:'other'});assert.match(response.content,/失効/);assert.equal(r.joins(),0);
  response=await r.dispatch({kind:'select',customId,values:['minutes']});assert.match(response.content,/記録中/);assert.deepEqual(response.components,[]);assert.equal(r.joins(),1);await r.dispatch({kind:'select',customId,values:['minutes']});assert.equal(r.joins(),1);
 }finally{await r.close();}
});
test('模擬Discord: 結果不明の投稿URLを管理者が検証して復旧し、一般ユーザーは照合できない',async()=>{
 const r=await fixture();try{const state=await r.create();let response=await r.dispatch({kind:'button',customId:`wg:review:${state.id}:1:${ownerId}`});const save=r.store.save.bind(r.store);let fail=true;r.store.save=(s,kind,...rest)=>{if(kind==='publication'&&fail){fail=false;throw new Error('DB failed');}return save(s,kind,...rest);};await r.dispatch({kind:'button',customId:response.components[0].components[0].data.custom_id});
  const thread=await r.guild.channels.fetch(threadId);thread.messages={fetch:async()=>({id:threadId,author:{id:botId},content:r.created[0].message.content,url:`https://discord.com/channels/${guildId}/${threadId}/${threadId}`})};
  response=await r.dispatch({action:'reconcile',strings:{action:'link',url:`https://discord.com/channels/${guildId}/${threadId}/${threadId}`}});assert.match(response.content,/管理者/);
  response=await r.dispatch({action:'reconcile',admin:true,strings:{action:'link',url:`https://discord.com/channels/${guildId}/${threadId}/${threadId}`}});assert.match(response.content,/復旧しました/);assert.equal((await r.get()).publications[0].status,'published');assert.equal(r.created.length,1);
 }finally{await r.close();}
});

test('模擬Discord: 議事録編集は25件以降もページで選べ、他ギルドの操作を拒否する',async()=>{
 const r=await fixture();try{const state=await r.create(),document=structuredClone(state.minutesHistory[0].document);document.ideas=Array.from({length:30},(_,i)=>({text:'試行案'+i,evidence:[{utteranceId:'u',revision:1}]}));await r.api(`/api/sessions/${state.id}/minutes`,{action:'edit',version:1,document});
  let response=await r.dispatch({kind:'button',customId:`wg:edit:${state.id}:2:${ownerId}`});assert.match(response.content,/1\/2ページ/);response=await r.dispatch({kind:'button',customId:`wg:editpage:${state.id}:2:1:${ownerId}`});assert.match(response.content,/2\/2ページ/);assert.ok(response.components[0].components[0].toJSON().options.some(o=>o.value==='ideas:29'));
  response=await r.dispatch({foreignGuild:true,strings:{meeting:state.id}});assert.match(response.content,/設定されたサーバー/);assert.equal(response.files,undefined);
 }finally{await r.close();}
});
