// Explicit opt-in: real API costs and test posts. Never captures human voice or joins a VC.
import { Readable } from 'node:stream';
import {joinVoiceChannel,entersState,VoiceConnectionStatus,createAudioPlayer,createAudioResource,StreamType,AudioPlayerStatus} from '@discordjs/voice';
import { parseArgs } from 'node:util';
import { existsSync,mkdirSync,writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client,GatewayIntentBits } from 'discord.js';
import opus from '@discordjs/opus';
import { discordConfig } from '../src/discord/config.js';
import { validateChannels } from '../src/discord/fixed-policy.js';
import { detectAddress } from '../src/discord/addressing.js';
import { transcribeSpeaker } from '../src/discord/transcription.js';
import { upsample } from '../src/discord/audio.js';
import { loadOpenAIKey } from '../src/credentials.js';
import { synthesize } from '../src/openai-audio.js';
import { analyze } from '../src/models.js';
import { Controller } from '../src/controller.js';
import { Store } from '../src/store.js';
const {values}=parseArgs({options:{profile:{type:'string'},'play-voice':{type:'boolean',default:false},speech:{type:'boolean',default:false},publish:{type:'boolean',default:false},server:{type:'string'},database:{type:'string'}}});
if(values.publish&&(!values.speech||!values.database))throw new Error('--publishには--speechと、起動中サーバーの--databaseが必要です。');
const profile=resolve(values.profile||'.');for(const filename of ['.env.local','.env.discord']){const path=resolve(profile,filename);if(existsSync(path))process.loadEnvFile(path);}
const config=discordConfig({workspace:profile,env:{...process.env,...(values.server?{WAIGAYA_DISCORD_SERVER:values.server}:{})}});
if(values.publish&&(!config.fixed.autoPublish||!config.serviceToken))throw new Error('通知済みの自動公開ポリシーとBot接続認証が必要です。');
const report={at:new Date().toISOString(),synthetic:true,humanAudioReceived:false,discordVoiceJoined:false},client=new Client({intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildVoiceStates]});
const directory=resolve('results/live-discord-'+report.at.replace(/[:.]/g,'-'));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function save(){mkdirSync(directory,{recursive:true,mode:0o700});writeFileSync(resolve(directory,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});}
function speech(text){const start=performance.now();let firstChunkMs=null;return new Promise((resolve,reject)=>{const chunks=[];synthesize({text,onChunk:b=>{firstChunkMs??=Math.round(performance.now()-start);chunks.push(b);},onDone:()=>resolve({pcm:Buffer.concat(chunks),firstChunkMs}),onError:reject});});}
async function api(path,body){const r=await fetch(config.server+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+config.serviceToken,origin:config.server,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});if(!r.ok)throw new Error('会議サーバー HTTP '+r.status);return r.json();}
async function waitPublished(id,version){const deadline=Date.now()+120000;while(Date.now()<deadline){const s=await api('/api/sessions/'+id),p=s.publications.find(p=>p.version===version);if(p?.status==='published')return s;if(['needs_reconciliation','failed'].includes(s.completionJob?.status))throw new Error('終了ジョブ '+s.completionJob.errorCategory);await sleep(500);}throw new Error('公開結果未確定。再送せずstatus/reconcileで確認してください。');}
try {
 await client.login(config.token);await new Promise(r=>client.isReady()?r():client.once('clientReady',r));const guild=await client.guilds.fetch(config.guildId),channels=await validateChannels(guild,config.fixed);
 report.preflight={voiceChannelId:channels.voice.id,forumId:channels.forum.id,humans:[...channels.voice.members.values()].filter(m=>!m.user.bot).length,permissionsValid:true};console.log('Discord接続・固定先・権限を確認しました。');
 if(values['play-voice']){
  loadOpenAIKey({workspace:profile});if(!process.env.OPENAI_API_KEY)throw new Error('既存のOpenAIキーを設定してください。');
  if(channels.voice.members.some(m=>!m.user.bot)||guild.voiceStates.cache.get(client.user.id)?.channelId)throw new Error('音声送信テストは無人・Bot未接続のVCだけで実行します。');
  report.phase='voice_output';await channels.voice.send({content:'【音声送信テスト】短い合成音声を再生し、すぐ退出します。受信・録音は行いません。',allowedMentions:{parse:[]}});
  const sample=await speech('これは音声テストです。ワイガヤと呼ぶと、音声で返答します。');
  const player=createAudioPlayer(),connection=joinVoiceChannel({guildId:guild.id,channelId:channels.voice.id,adapterCreator:guild.voiceAdapterCreator,selfDeaf:true,selfMute:false});report.discordVoiceJoined=true;let failed=false;
  const onHuman=(_,next)=>{if(next.channelId===channels.voice.id&&!next.member?.user.bot){failed=true;player.stop(true);connection.destroy();}};client.on('voiceStateUpdate',onHuman);connection.on('error',()=>{failed=true;player.stop(true);});player.on('error',()=>{failed=true;player.stop(true);});
  try{
   await entersState(connection,VoiceConnectionStatus.Ready,20000);connection.subscribe(player);player.play(createAudioResource(Readable.from([upsample(sample.pcm)]),{inputType:StreamType.Raw}));await entersState(player,AudioPlayerStatus.Playing,10000);await entersState(player,AudioPlayerStatus.Idle,15000);
   const packets=connection.state.networking?.state.connectionData?.packetsPlayed;if(failed||!packets)throw new Error('Discord音声送信を確認できません。');report.voiceOutput={packetsPlayed:packets,audioSeconds:sample.pcm.length/48000,humanListeningVerified:false};console.log('Discordボイス接続・音声パケット送信を確認しました（人による聴取は未確認）。');
  }finally{client.off('voiceStateUpdate',onHuman);player.stop(true);if(connection.state.status!==VoiceConnectionStatus.Destroyed)connection.destroy();report.voiceDisconnected=true;}
 }
 if(values.speech){
  loadOpenAIKey({workspace:profile});if(!process.env.OPENAI_API_KEY)throw new Error('既存のOpenAIキーを設定してください。');
  report.phase='tts_input';const input=await speech('ワイガヤ、手動で配線を確認するA案と、コネクタで取り違えを防ぐB案を短く比較してください。');report.inputAudioSeconds=input.pcm.length/48000;
  report.phase='stt';const utterance=await new Promise((resolve,reject)=>{
   let final;const capture=transcribeSpeaker({speaker:'合成音声（自動テスト・人間ではありません）',emit:u=>{if(u.final)final=u;},onError:reject,onUsage:u=>{report.sttUsage=u;},onClose:()=>{clearTimeout(timer);final?resolve(final):reject(new Error('STT確定結果なし'));}});
   const timer=setTimeout(()=>{capture.abort();reject(new Error('STT timeout'));},45000),codec=new opus.OpusEncoder(48000,2);
   void(async()=>{try{for(let i=0;i<input.pcm.length;i+=960){const frame=Buffer.alloc(960);input.pcm.copy(frame,0,i,Math.min(i+960,input.pcm.length));capture.write(codec.decode(codec.encode(upsample(frame))));await sleep(20);}capture.end();}catch(e){clearTimeout(timer);capture.abort();reject(e);}})();
  });
  report.phase='addressing';report.transcript=utterance.text;report.address=detectAddress(utterance.text);if(!report.address.addressed)throw new Error('合成音声の呼称を検出できませんでした。');
  const state={topic:'合成音声による動作確認',phase:'organize',decisions:[],aiTurns:[],utterances:[{...utterance,revision:1,source:'sample'}],request:{mode:'voice_request',voiceRequest:{utteranceId:utterance.id,revision:1,question:report.address.question}}};
  report.phase='llm';const answer=await analyze({provider:'openai',model:'gpt-6.1-sol',state});if(answer.result.action==='hold')throw new Error('直接依頼への回答がholdでした。');report.phase='tts_reply';const output=await speech(answer.result.text);
  report.reply={result:answer.result,usage:answer.usage,audioSeconds:output.pcm.length/48000,firstChunkMs:output.firstChunkMs};console.log('実Opus→Discord用STT→呼びかけ→実LLM→実TTSを確認しました（VC受信・聴取は対象外）。');save();
  if(values.publish){
   if(!config.serviceToken)throw new Error('Bot接続認証が必要です。');
   await channels.voice.send({content:'【自動動作テスト】合成音声からAI議事録を作り、固定フォーラムへ投稿します。人の音声は記録していません。投稿はAI生成・未確認です。',allowedMentions:{parse:[]}});
   const now=Date.now(),c=new Controller({topic:'自動テスト｜合成音声（実会議ではありません）',mode:'minutes',guildId:config.guildId,ownerId:client.user.id,voiceChannelId:config.fixed.voiceChannelId,fixedVoiceChannelId:config.fixed.voiceChannelId,fixedMinutesForumId:config.fixed.minutesForumId,outputChannelId:config.fixed.minutesForumId,fixedOperation:true,publicationPolicy:'auto_publish_ai_draft',recordingNoticeSentAt:now,autoPublicationNoticeAt:now,startedAt:Date.parse(report.at),endedAt:now,endReason:'synthetic_validation',participantIds:[]});
   c.upsert({...utterance,revision:undefined,source:'sample'});c.state.status='finalizing';c.state.minutesStatus='none';c.state.completionJob={status:'pending',phase:'generation',generationAttempts:0};const store=new Store(resolve(values.database));try{store.save(c.state,'synthetic_validation_started',{synthetic:true});}finally{store.close();}report.sessionId=c.state.id;save();
   const first=await waitPublished(c.state.id,1),p=first.publications[0],thread=await guild.channels.fetch(p.threadId),message=await thread.messages.fetch(p.messageId);
   if(first.minutesHistory[0].approvedAt||p.reviewStatus!=='ai_unreviewed'||!message.content.includes('AI生成・未確認')||!message.attachments.some(a=>a.name==='minutes-v1.md')||message.author.id!==client.user.id)throw new Error('初回投稿の検証不一致');
   report.publication={url:p.url,threadId:p.threadId,markdownAttached:true,unreviewed:true};report.minutesUsage=first.usage.filter(u=>u.kind==='minutes');save();
   const document=structuredClone(first.minutesHistory[0].document);if(!document.overview.length)throw new Error('合成会話の概要なし');document.overview[0].text+='（表示訂正の自動テスト）';await api('/api/sessions/'+first.id+'/minutes',{action:'edit',version:1,document,actorId:client.user.id});
   const second=await waitPublished(first.id,2),update=second.publications.find(p=>p.version===2),reply=await thread.messages.fetch(update.messageId);
   if(update.threadId!==p.threadId||second.minutesHistory[1].approvedAt||!reply.attachments.some(a=>a.name==='minutes-v2.md'))throw new Error('訂正版の検証不一致');report.revision={url:update.url,sameThread:true};console.log('固定フォーラムの初回投稿・添付・未確認表示・同じ投稿への版更新を確認しました。');
  }
 }
 report.ok=true;report.phase='completed';
} catch(e){report.ok=false;report.error={category:e.name,code:e.code??null,status:e.status??(Number(e.message?.match(/HTTP (\d{3})/)?.[1])||null)};console.error('実API検証に失敗しました。秘密値を含む生のエラーは表示しません。');process.exitCode=1;}
finally{client.destroy();save();console.log('検証記録：'+directory);}
