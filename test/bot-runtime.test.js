import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Events } from 'discord.js';
import { runBot } from '../src/discord/bot.js';

test('T01/T18 Bot起動・復旧・参加イベントだけでは音声接続とSTTを始めない',async()=>{
 const old=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='mock-only';
 const client=new EventEmitter();client.user={id:'bot'};client.login=async()=>{client.emit(Events.ClientReady);};client.destroy=()=>{};
 let joins=0,stt=0;const events=[];
 const bridgeFactory=()=>({api:async(path,body)=>{if(path.startsWith('/api/sessions?'))return[{id:'old',status:'recording',guildId:'g'}];events.push(body);return{};}});
 const runtime=await runBot({config:{guildId:'g',server:'http://127.0.0.1',serviceToken:'local-test-token',token:'mock-only',controlRoleIds:[]},client,bridgeFactory,join:()=>{joins++;},transcribe:()=>{stt++;}});
 try{
  await new Promise(r=>setTimeout(r,10));client.emit(Events.VoiceStateUpdate,{channelId:null},{id:'human',channelId:'vc'});
  assert.equal(joins,0);assert.equal(stt,0);assert.equal(runtime.meeting,null);assert.ok(events.some(e=>e.type==='lifecycle'&&e.action==='pause'));
 }finally{await runtime.close();if(old===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=old;}
});

test('T15 通常利用者への権限エラーは理由を返し、議事録を含めない',async()=>{
 const old=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='mock-only';const client=new EventEmitter();client.login=async()=>{};client.destroy=()=>{};
 const state={id:'s',guildId:'g',ownerId:'owner',voiceChannelId:'vc',status:'completed',topic:'private meeting'};
 const bridgeFactory=()=>({api:async(path)=>path.startsWith('/api/sessions?')?[state]:state});
 const runtime=await runBot({config:{guildId:'g',server:'http://127.0.0.1',serviceToken:'local-test-token',token:'mock-only',controlRoleIds:[]},client,bridgeFactory});
 const replies=[];const interaction={commandName:'waigaya',guildId:'g',user:{id:'other'},member:{},memberPermissions:{has:()=>false},guild:{voiceStates:{cache:new Map()},channels:{fetch:async()=>({permissionsFor:()=>({has:()=>true})})}},options:{getSubcommand:()=> 'minutes',getString:name=>name==='meeting'?'s':null},isChatInputCommand:()=>true,isAutocomplete:()=>false,isButton:()=>false,isStringSelectMenu:()=>false,isModalSubmit:()=>false,deferred:false,async deferReply(){this.deferred=true;},async editReply(value){replies.push(value);},async reply(value){replies.push(value);}};
 try{await Promise.all(client.listeners(Events.InteractionCreate).map(handler=>handler(interaction)));assert.equal(replies.length,1);assert.match(replies[0].content,/開始した人か管理担当者/);assert.ok(!JSON.stringify(replies).includes('private meeting'));}
 finally{await runtime.close();if(old===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=old;}
});

test('T02/T06/T07 明示開始の通知後にだけ記録し、pause中の音声を送らずresumeで再開',async()=>{
 const {Store}=await import('../src/store.js');const {createApp}=await import('../src/server.js');const {once}=await import('node:events');const {PassThrough}=await import('node:stream');const {default:opus}=await import('@discordjs/opus');const {ChannelType}=await import('discord.js');const {emptyMinutes}=await import('../src/minutes.js');
 const old=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='mock-only';let tts=0,writes=0,captures=0,notices=0;
 const app=createApp({store:new Store(':memory:'),serviceToken:'local-test-token',minutesGenerator:{generateDraft:async()=>emptyMinutes()},modelAnalyze:async({state})=>({result:{action:'summary',text:'設定を検討しました。',reason:'整理',evidence:[{utteranceId:state.utterances[0].id,revision:1}],notes:[]},usage:{estimatedUsd:null}}),ttsSynthesize:()=>{tts++;return{abort(){}};}});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
 const guildId='123456789012345678',channelId='223456789012345678',ownerId='323456789012345678';
 const member={id:ownerId,displayName:'参加者',user:{bot:false}};
 const channel={id:channelId,name:'試験会議室',type:ChannelType.GuildVoice,members:new Map([[ownerId,member]]),permissionsFor:()=>({has:()=>true}),send:async()=>{notices++;return{id:'notice'};}};
 const guild={id:guildId,voiceAdapterCreator:{},voiceStates:{cache:new Map([[ownerId,{channel,channelId}]])},channels:{fetch:async()=>channel},members:{me:{}}};channel.guild=guild;
 const client=new EventEmitter();client.user={id:'bot'};client.login=async()=>{};client.destroy=()=>{};client.users={fetch:async()=>({send:async()=>{}})};
 const connection=new EventEmitter(),speaking=new EventEmitter();speaking.users=new Set([ownerId]);const streams=[];connection.subscribe=()=>{};connection.destroy=()=>{};connection.receiver={speaking,subscribe:()=>{const s=new PassThrough();streams.push(s);return s;}};
 const runtime=await runBot({config:{guildId,server:`http://127.0.0.1:${app.server.address().port}`,serviceToken:'local-test-token',token:'mock-only',controlRoleIds:[]},client,join:()=>connection,ready:async()=>{},transcribe:args=>{
  assert.ok(notices>0);captures++;let resolve,closed=new Promise(done=>{resolve=done;}),emitted=false;
  return{closed,write:()=>{writes++;if(!emitted){emitted=true;args.emit({id:'capture-'+captures,text:'設定の分かりにくさを比較します。',source:'discord',speaker:args.speaker,startMs:args.startedAt,endMs:args.startedAt+20,final:true});}},end:()=>{resolve();args.onClose();},abort:()=>{resolve();args.onClose();}};
 }});
 const replies=[];
 const action=async name=>{
  const interaction={commandName:'waigaya',guildId,user:{id:ownerId},member,memberPermissions:{has:()=>false},guild,options:{getSubcommand:()=>name,getString:key=>key==='mode'?'minutes':null,getChannel:()=>null,getBoolean:()=>true},isChatInputCommand:()=>true,isAutocomplete:()=>false,isButton:()=>false,isStringSelectMenu:()=>false,isModalSubmit:()=>false,deferred:false,async deferReply(){this.deferred=true;},async editReply(value){replies.push(value);},async reply(value){replies.push(value);}};
  await Promise.all(client.listeners(Events.InteractionCreate).map(handler=>handler(interaction)));
 };
 const wait=async condition=>{const end=Date.now()+2000;while(!condition()){if(Date.now()>end)throw new Error('runtime test timeout');await new Promise(r=>setTimeout(r,10));}};
 const codec=new opus.OpusEncoder(48000,2),pcm=Buffer.alloc(3840);for(let i=0;i<1920;i++)pcm.writeInt16LE(2000,i*2);
 try{
  assert.equal(runtime.meeting,null);await action('start');assert.ok(runtime.meeting);const id=runtime.meeting.bridge.state.id;
  speaking.emit('start',ownerId);streams.at(-1).write(codec.encode(pcm));await wait(()=>writes>0);await runtime.meeting.bridge.queue;
  await action('ask');assert.equal(tts,0);assert.ok(replies.some(r=>r.content.includes('文字回答のみ')));
  await action('pause');assert.equal(runtime.meeting.bridge.state.status,'paused');const before=captures;speaking.emit('start',ownerId);assert.equal(captures,before);
  await action('resume');assert.equal(runtime.meeting.bridge.state.id,id);speaking.emit('start',ownerId);streams.at(-1).write(codec.encode(pcm));await wait(()=>captures===before+1);assert.equal(tts,0);
 }finally{await runtime.close();await app.close();if(old===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=old;}
});

test('再起動後の一時停止会議は録音を再開せず、確認ボタンで一度だけ終了できる',async()=>{
 const old=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='mock-only';const client=new EventEmitter();client.user={id:'bot'};client.login=async()=>{};client.destroy=()=>{};
 let joins=0,finished=0;const state={id:'saved',guildId:'g',ownerId:'owner',voiceChannelId:'vc',status:'paused',topic:'保存済み会議',minutesVersion:0};
 const channel={permissionsFor:()=>({has:()=>true})},guild={voiceStates:{cache:new Map([['owner',{channelId:'vc',channel}]])},channels:{fetch:async()=>channel}};
 const bridgeFactory=()=>({api:async(path)=>{if(path.endsWith('/finish')){finished++;state.status='finalizing';}return path.startsWith('/api/sessions?')?[state]:state;}});
 const runtime=await runBot({config:{guildId:'g',server:'http://127.0.0.1',serviceToken:'local-test-token',token:'mock-only',controlRoleIds:[]},client,bridgeFactory,join:()=>{joins++;}});
 const replies=[];const interaction=button=>({commandName:button?undefined:'waigaya',customId:button,guildId:'g',user:{id:'owner'},member:{},memberPermissions:{has:()=>false},guild,options:{getSubcommand:()=> 'finish',getString:()=>null},isChatInputCommand:()=>!button,isAutocomplete:()=>false,isButton:()=>Boolean(button),isStringSelectMenu:()=>false,isModalSubmit:()=>false,deferred:false,async deferReply(){this.deferred=true;},async deferUpdate(){this.deferred=true;},async editReply(value){replies.push(value);},async reply(value){replies.push(value);}});
 const dispatch=async value=>Promise.all(client.listeners(Events.InteractionCreate).map(handler=>handler(value)));
 try{await dispatch(interaction());const customId=replies.at(-1).components[0].components[0].data.custom_id;await dispatch(interaction(customId));await dispatch(interaction(customId));assert.equal(joins,0);assert.equal(finished,1);assert.equal(runtime.meeting,null);assert.match(replies.at(-1).content,/失効/);}
 finally{await runtime.close();if(old===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=old;}
});
