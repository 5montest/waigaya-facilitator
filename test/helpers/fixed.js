import { EventEmitter,once } from 'node:events';
import { PassThrough } from 'node:stream';
import opus from '@discordjs/opus';
import { Collection,ChannelType,Events } from 'discord.js';
import { createApp } from '../../src/server.js';
import { Store } from '../../src/store.js';
import { runBot } from '../../src/discord/bot.js';
import { emptyMinutes } from '../../src/minutes.js';
export const ids={guild:'123456789012345678',vc:'223456789012345678',owner:'323456789012345678',forum:'423456789012345678',thread:'523456789012345678',bot:'623456789012345678',other:'723456789012345678',otherVc:'823456789012345678'};
export async function waitFor(check,timeout=4000){const end=Date.now()+timeout;while(!await check()){if(Date.now()>end)throw new Error('fixed runtime timeout');await new Promise(r=>setTimeout(r,10));}}
export async function fixedFixture(options={}){
  const oldKey=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='mock-only';
  const policy={guildId:ids.guild,voiceChannelId:ids.vc,minutesForumId:ids.forum,responsePolicy:options.responsePolicy||'on_call',emptyGraceMs:1000,autoPublish:options.autoPublish??true};
  const store=options.store||new Store(options.path||':memory:');const requests=[],generated=[],tts=[],created=[],replies=[],dms=[],notices=[],streams=[],captures=[];let joins=0,destroys=0;
  const app=createApp({store,serviceToken:'fixed-test-service',fixed:options.serverFixed===false?null:policy,
    modelAnalyze:options.modelAnalyze|| (async({state})=>{requests.push(state.request);const q=state.request.voiceRequest;return{result:{action:'summary',text:'A案は構成が簡単で、B案は変更しやすい案です。',reason:'直接回答',evidence:[{utteranceId:q.utteranceId,revision:q.revision}],notes:[]},usage:{estimatedUsd:null}};}),
    minutesGenerator:{generateDraft:async state=>{generated.push(structuredClone(state));if(options.minutesFail)throw new Error('private meeting upstream failure');const d=emptyMinutes();const u=state.utterances.find(u=>u.final&&u.source!=='ai');if(u)d.overview=[{text:'二つの配線案を比較した。',evidence:[{utteranceId:u.id,revision:u.revision}]}];return d;}},
    ttsSynthesize:args=>{tts.push(args);if(options.ttsFail){queueMicrotask(()=>args.onError(new Error('private tts failure')));}else if(!options.holdTts)queueMicrotask(()=>{args.onChunk(Buffer.alloc(960));args.onDone();});return{abort(){}};}
  });app.server.listen(0,'127.0.0.1');await once(app.server,'listening');const base=`http://127.0.0.1:${app.server.address().port}`;
  const api=async(path,body,authorized=true)=>{const response=await fetch(base+path,{method:body?'POST':'GET',headers:{origin:base,'content-type':'application/json',...(authorized?{authorization:'Bearer fixed-test-service'}:{})},...(body?{body:JSON.stringify(body)}:{})});const data=await response.json();if(!response.ok)throw new Error(data.error);return data;};
  const all={has:()=>true},member={id:ids.owner,displayName:'参加者A',user:{bot:false}},other={id:ids.other,displayName:'参加者B',user:{bot:false}},bot={id:ids.bot,user:{bot:true}};
  const voice={id:ids.vc,type:ChannelType.GuildVoice,name:'固定会議室',members:new Collection([[ids.owner,member],[ids.bot,bot]]),permissionsFor:()=>all,send:async payload=>{if(options.noticeFail)throw new Error('notification failed');notices.push(payload);return{id:'notice'};}};
  if(options.voiceEmpty)voice.members.delete(ids.owner);
  const otherVc={...voice,id:ids.otherVc,name:'別の会議室',members:new Collection()};
  let next=923456789012345678n;
  const thread={id:ids.thread,parentId:ids.forum,ownerId:ids.bot,permissionsFor:()=>all,send:async payload=>{replies.push(payload);return{id:String(next++),url:`https://discord.com/channels/${ids.guild}/${ids.thread}/${next-1n}`};}};
  const forum={id:ids.forum,type:ChannelType.GuildForum,availableTags:[{id:'tag1',name:'確認済み'},{id:'tag2',name:'議事録'}],flags:{has:()=>false},permissionsFor:()=>all,threads:{create:async payload=>{created.push(payload);if(options.sendUnknown)throw new Error('delivery timeout');return thread;}}};
  const channels=new Collection([[voice.id,voice],[otherVc.id,otherVc],[forum.id,forum],[thread.id,thread]]);
  const guild={id:ids.guild,members:{me:bot},channels:{fetch:async id=>channels.get(id)},voiceStates:{cache:new Collection([[ids.owner,{channel:voice,channelId:voice.id}]])}};
  for(const c of channels.values())c.guild=guild;member.guild=guild;other.guild=guild;bot.guild=guild;
  const client=new EventEmitter();client.user={id:ids.bot};client.guilds={fetch:async()=>guild};client.users={fetch:async()=>({send:async payload=>{dms.push(payload);}})};client.login=async()=>{};client.destroy=()=>{};
  const connection=new EventEmitter(),speaking=new EventEmitter();speaking.users=new Set();connection.subscribe=()=>{};connection.destroy=()=>{destroys++;};connection.receiver={speaking,subscribe:userId=>{const stream=new PassThrough();stream.userId=userId;streams.push(stream);return stream;}};
  const runtime=await runBot({client,config:{guildId:ids.guild,token:'mock-only',server:base,serviceToken:'fixed-test-service',controlRoleIds:[],fixed:policy},join:()=>{joins++;return connection;},ready:async()=>{},transcribe:args=>{captures.push(args);let resolve,done=false;const closed=new Promise(r=>resolve=r);return{closed,write:()=>{},end(){if(done)return;done=true;options.onDrain?.(args);resolve();args.onClose();},abort(){if(done)return;done=true;resolve();args.onClose();}};}});
  await Promise.all(client.listeners(Events.ClientReady).map(h=>h()));clearInterval(runtime.completionWorker?.timer);await runtime.completionWorker?.running;
  const responses=[];
  const action=async(name,{userId=ids.owner,admin=false,strings={}}={})=>{const m=userId===ids.owner?member:other;const interaction={commandName:'waigaya',guildId:ids.guild,user:{id:userId},member:m,memberPermissions:{has:()=>admin},guild,options:{getSubcommand:()=>name,getString:key=>strings[key]??null,getChannel:()=>null,getBoolean:()=>false},isChatInputCommand:()=>true,isAutocomplete:()=>false,isButton:()=>false,isStringSelectMenu:()=>false,isModalSubmit:()=>false,deferred:false,async deferReply(){this.deferred=true;},async editReply(payload){responses.push(payload);},async reply(payload){responses.push(payload);}};await Promise.all(client.listeners(Events.InteractionCreate).map(h=>h(interaction)));return responses.at(-1);};
  const codec=new opus.OpusEncoder(48000,2),pcm=Buffer.alloc(3840);for(let i=0;i<960;i++){const value=Math.round(8000*Math.sin(2*Math.PI*400*i/48000));pcm.writeInt16LE(value,i*4);pcm.writeInt16LE(value,i*4+2);}
  const capture=async(userId=ids.owner)=>{speaking.emit('start',userId);const stream=streams.findLast(s=>s.userId===userId&&!s.writableEnded);if(stream){for(let frame=0;frame<4;frame++)stream.write(codec.encode(pcm));await waitFor(()=>runtime.meeting.activeSpeakers.has(userId));}return captures.findLast(c=>c.speaker.endsWith(`(${userId})`));};
  let utterance=0;
  const emit=async(text,{userId=ids.owner,id='human-'+(++utterance),final=true}={})=>{const args=await capture(userId);args.emit({id,text,speaker:args.speaker,source:'discord',final,startMs:args.startedAt,endMs:Date.now()});await runtime.meeting.bridge.queue;await waitFor(()=>runtime.meeting.bridge.state.utterances.some(u=>u.id===id&&u.text===text));streams.findLast(s=>s.userId===userId&&!s.writableEnded)?.end();await waitFor(()=>!runtime.meeting.captures.has(userId));await runtime.meeting.bridge.queue;return id;};
  const membership=async(present,{user=member,channel=voice}={})=>{const before=guild.voiceStates.cache.get(user.id)?.channelId||null;if(present){channel.members.set(user.id,user);guild.voiceStates.cache.set(user.id,{channel,channelId:channel.id});}else{channel.members.delete(user.id);guild.voiceStates.cache.delete(user.id);}client.emit(Events.VoiceStateUpdate,{channelId:before},{id:user.id,channelId:present?channel.id:null,member:user});await runtime.meeting?.grace.pending;};
  const state=async()=>{const listed=await api('/api/sessions?guildId='+ids.guild);return listed[0]?api('/api/sessions/'+listed[0].id):null;};
  const complete=async()=>{for(let i=0;i<20;i++){await runtime.completionWorker.tick();const s=await state();if(['completed','failed','skipped_empty','needs_reconciliation'].includes(s.completionJob?.status))return s;await new Promise(r=>setTimeout(r,10));}return state();};
  return{runtime,app,store,policy,voice,forum,thread,guild,client,member,other,bot,api,action,capture,emit,membership,state,complete,requests,generated,tts,created,replies,dms,notices,captures,streams,connection,joins:()=>joins,destroys:()=>destroys,close:async()=>{await runtime.close();await runtime.completionWorker?.running;await app.close();if(oldKey===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=oldKey;}};
}
