import { UserError as Error, UserError } from '../errors.js';
import { Client, GatewayIntentBits, Events, MessageFlags, ChannelType, PermissionFlagsBits, AttachmentBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder,ChannelSelectMenuBuilder } from 'discord.js';
import { joinVoiceChannel, entersState, VoiceConnectionStatus, EndBehaviorType } from '@discordjs/voice';
import prism from 'prism-media';
import { validateChannels,automaticTitle,policyMode } from './fixed-policy.js';
import { VoiceAddressing } from './addressing.js';
import { FixedCompletionWorker } from './completion.js';
import { discordConfig } from './config.js';
import { MeetingBridge } from './bridge.js';
import { DiscordPlayback } from './playback.js';
import { transcribeSpeaker } from './transcription.js';
import { proposal, confirmation, minutesControls, chooseMode, help } from './commands.js';
import { loadOpenAIKey } from '../credentials.js';
import { VoiceActivity } from './audio.js';
import { AutonomousFacilitator } from './autonomy.js';
import { EmptyGrace, modes, canSpeak, statusLabels, minutesLabels, healthLabels } from '../meeting.js';
import { requireAccess, requireOutput, requireDestinationView, canControl, Confirmations } from './access.js';
import { DiscordMinutesPublisher,preparePublication,splitAttachments,safeText } from './minutes-publication.js';
import { inspectPublication,verifyMessageLink,requireAdministrator } from './reconcile.js';
import { requireFormal,publicationState,publicationLabels,unresolved } from '../publication.js';
import { minutesMarkdown, minutesStale } from '../minutes.js';

export async function runBot({ config = discordConfig(), client = new Client({ intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildVoiceStates] }), join = joinVoiceChannel, ready = entersState, bridgeFactory = (base,options)=>new MeetingBridge(base,options), transcribe = transcribeSpeaker } = {}) {
  if(!loadOpenAIKey().configured) throw new Error('OpenAIキーを設定してください。');
  if(!config.serviceToken) throw new Error('Bot・会議サーバー間の認証ファイルを設定してください。discord-setup.mdを参照してください。');
  const confirmations=new Confirmations(), publisher=new DiscordMinutesPublisher(), starts=new Map(), editorForms=new Map();
  const service=bridgeFactory(config.server,{serviceToken:config.serviceToken});
  let meeting=null,starting=false,disposed=false,completionWorker=null,policyReady=false,beginning=false;
  const safe = content => ({content,allowedMentions:{parse:[]}});
  const humanCount=channel=>[...channel.members.values()].filter(m=>!m.user.bot).length;
  async function stateFor(id){return service.api('/api/sessions/'+id);}
  async function list(){return service.api('/api/sessions?guildId='+config.guildId);}
  async function access(state,interaction,{live=false}={}){
    const channel=await interaction.guild.channels.fetch(state.voiceChannelId);
    requireAccess(state,interaction,channel,{live,roles:config.controlRoleIds}); return channel;
  }
  async function resolveMeeting(interaction){
    const id=interaction.options?.getString('meeting');
    if(id)return stateFor(id);
    if(meeting)return meeting.bridge.state;
    const recent=(await list()).find(s=>canControl(s,interaction,config.controlRoleIds));
    if(!recent)throw new Error('閲覧できる会議がありません。/waigaya start で会議を開始してください。');
    return stateFor(recent.id);
  }
  async function notifyOwner(state,content){
    if(!state.ownerId)return;
    try{const user=await client.users.fetch(state.ownerId);await user.send(safe(content));}
    catch{await service.api(`/api/sessions/${state.id}/events`,{type:'health',kind:'discord_post',healthy:false}).catch(()=>{});console.error('会議の開始者へ案内を送れませんでした。/waigaya minutes から確認できます。');}
  }
  async function fault(current,kind,{gap=false,startedAt}={}){
    if(current.closed)return;
    await current.bridge.enqueue({type:'health',kind,healthy:false,...(gap?{gap:{startedAt:startedAt??current.lastCaptureAt??null,endedAt:Date.now()}}:{})}).catch(()=>{});
  }
  function stopCapture(current,{abort=false}={}){
    current.acceptAudio=false;
    for(const item of current.captures.values()){
      item.activity.end();item.opus.unpipe(item.decoder);item.opus.destroy();item.decoder.destroy();
      if(abort)item.stt.abort();else item.stt.end();
    }
    current.captures.clear();current.activeSpeakers.clear();current.bridge.send({type:'vad',active:false});
  }
  async function drain(current,{abort=false}={}){
    stopCapture(current,{abort});let timer,timedOut=false;
    if(!abort)await Promise.race([Promise.all([...current.transcriptions].map(s=>s.closed)),new Promise(resolve=>{timer=setTimeout(()=>{timedOut=true;resolve();},13000);})]).finally(()=>clearTimeout(timer));
    if(abort||timedOut)await fault(current,'stt',{gap:true});
    for(const stt of current.transcriptions)stt.abort();current.transcriptions.clear();
    await current.bridge.queue;
    return !abort&&!timedOut;
  }
  function announceMinutes(sessionId){
      // Completion is polled using the saved session, not a new voice connection.
      void (async()=>{
        const deadline=Date.now()+600000;
        while(!disposed&&Date.now()<deadline){
          const saved=await stateFor(sessionId);
          if(['completed','finalize_failed'].includes(saved.status)){
            await notifyOwner(saved,saved.minutesStatus==='failed'?'議事録の生成に失敗しました。/waigaya minutes で文字起こしを確認・再生成できます。':'議事録の下書きができました。/waigaya minutes で確認・Markdown保存できます。本文は自動公開していません。');return;
          }
          await new Promise(resolve=>{const timer=setTimeout(resolve,2000);timer.unref();});
        }
      })().catch(()=>{if(!disposed)console.error('議事録の完了案内を確認できませんでした。/waigaya minutes で状態を確認できます。');});
  }
  async function finish(current=meeting,{reason='manual',abort=false}={}){
    if(!current)return;
    if(current.finishing)return current.finishing;
    current.closing=true;current.addressing?.close();current.facilitator.close();current.grace.close();current.playback.close();
    current.finishing=(async()=>{
      client.off(Events.VoiceStateUpdate,current.onVoiceState);
      let state;
      try{
        await drain(current,{abort});
        if(config.fixed)state=await service.api(`/api/sessions/${current.bridge.state.id}/finish`,{reason,deferGeneration:true});
      }finally{
        current.connection.destroy();current.closed=true;await current.bridge.close();if(meeting===current)meeting=null;
      }
      if(!config.fixed){state=await service.api(`/api/sessions/${current.bridge.state.id}/finish`,{reason});announceMinutes(state.id);}
      else void completionWorker?.tick().catch(()=>{});
      return state;
    })();
    return current.finishing.finally(()=>{if(current.closed&&meeting===current)meeting=null;});
  }
  async function start(channel,topic,{sessionId,mode='minutes',ownerId,outputChannelId=null,noticeAt}={}){
    if(config.fixed&&channel.id!==config.fixed.voiceChannelId)throw new Error('固定ボイスチャンネルから開始してください。');
    if(meeting||starting)throw new Error('別の会議を処理中です。/waigaya status で確認してください。');
    starting=true;let bridge,connection,playback,current;
    try{
      bridge=bridgeFactory(config.server,{serviceToken:config.serviceToken});
      await bridge.open(topic,{sessionId,mode,discord:{guildId:channel.guild.id,voiceChannelId:channel.id,ownerId,outputChannelId,recordingNoticeSentAt:noticeAt,...(config.fixed?{autoPublicationNoticeAt:noticeAt}:{}),participantIds:[...channel.members.values()].filter(m=>!m.user.bot).map(m=>m.id)}});
      connection=join({guildId:channel.guild.id,channelId:channel.id,adapterCreator:channel.guild.voiceAdapterCreator,selfDeaf:false,selfMute:false});
      await ready(connection,VoiceConnectionStatus.Ready,20000);
      current={bridge,connection,channel,channelId:channel.id,captures:new Map(),sttFailures:new Map(),blockedUntil:new Map(),activeSpeakers:new Set(),transcriptions:new Set(),acceptAudio:true,closing:false,closed:false};
      playback=new DiscordPlayback(bridge,{onFailure:()=>{void fault(current,'tts');console.error('AI音声の再生に失敗しました。文字起こしは継続します。');}});
      current.playback=playback;current.addressing=config.fixed?new VoiceAddressing(current,{names:config.addressNames,onFailure:async()=>channel.send(safe('AIの音声回答だけに失敗しました。文字起こしは継続します。'))}):null;meeting=current;connection.subscribe(playback.player);
      bridge.on('failure',()=>{void fault(current,'connection',{gap:true}).finally(()=>finish(current,{reason:'connection_lost',abort:true})).catch(()=>{});});
      connection.on('error',()=>void finish(current,{reason:'connection_lost',abort:true}).catch(()=>{}));
      connection.on(VoiceConnectionStatus.Disconnected,()=>void finish(current,{reason:'connection_lost',abort:true}).catch(()=>{}));
      const capture=userId=>{
        if(meeting!==current||current.closing||!current.acceptAudio||current.bridge.state.status!=='recording'||current.captures.has(userId)||Date.now()<(current.blockedUntil.get(userId)||0))return;
        const member=channel.members.get(userId);if(!member||member.user.bot)return;
        const activity=new VoiceActivity(active=>{
          if(meeting!==current||current.closing)return;
          if(active){current.activeSpeakers.add(userId);playback.speech(true);bridge.send({type:'vad',active:true});}
          else{current.activeSpeakers.delete(userId);if(current.activeSpeakers.size===0){playback.speech(false);bridge.send({type:'vad',active:false});}}
        });
        const startedAt=Date.now(),speaker=`${member.displayName.slice(0,50)} (${userId})`;current.lastCaptureAt=startedAt;
        const opus=connection.receiver.subscribe(userId,{end:{behavior:EndBehaviorType.AfterSilence,duration:500}});
        const decoder=new prism.opus.Decoder({rate:48000,channels:2,frameSize:960});let stt,failedOnce=false;
        const failed=kind=>{
          if(failedOnce||current.closed)return;failedOnce=true;
          activity.end();opus.unpipe(decoder);opus.destroy();decoder.destroy();stt?.abort();current.captures.delete(userId);
          const failures=(current.sttFailures.get(userId)||0)+1;current.sttFailures.set(userId,failures);if(failures>=3)current.blockedUntil.set(userId,Date.now()+60000);
          void fault(current,kind,{gap:true,startedAt});
          // Only this stream fails; a future speaking event can reconnect it.
          const timer=setTimeout(()=>{if(meeting===current&&current.acceptAudio&&connection.receiver.speaking.users.has(userId))capture(userId);},failures>=3?60000:Math.min(30000,1000*2**(failures-1)));timer.unref();
        };
        try{
          stt=transcribe({speaker,startedAt,emit:u=>{if(!current.closed){current.sttFailures.delete(userId);current.blockedUntil.delete(userId);if(bridge.state.health.stt==='failed')void bridge.enqueue({type:'health',kind:'stt',healthy:true}).catch(()=>{});void bridge.enqueue({type:'utterance',utterance:{...u,userId}}).then(()=>{const saved=bridge.state.utterances.find(v=>v.id===u.id);if(saved)current.addressing?.observe(saved,userId);}).catch(()=>{});}},
            onUsage:usage=>{if(!current.closed)void bridge.enqueue({type:'audio_usage',usage}).catch(()=>{});},
            onClose:()=>current.transcriptions.delete(stt),onError:()=>failed('stt')});
          current.transcriptions.add(stt);current.captures.set(userId,{opus,decoder,stt,activity});opus.pipe(decoder);
          decoder.on('data',buffer=>{if(!current.acceptAudio)return;try{activity.write(buffer);stt.write(buffer);}catch{failed('stt');}});
          decoder.on('end',()=>{activity.end();current.captures.delete(userId);stt.end();});
          opus.on('error',()=>failed('stt'));decoder.on('error',()=>failed('stt'));
        }catch{failed('stt');}
      };
      connection.receiver.speaking.on('start',capture);
      current.facilitator=new AutonomousFacilitator(bridge,{available:()=>current.acceptAudio&&!current.asking&&!current.voiceAsking&&playback.epoch===null&&humanCount(channel)>0,onFailure:()=>console.error('自律検討に失敗しました。文字起こしは継続します。')});current.facilitator.start();
      current.grace=new EmptyGrace({graceMs:config.fixed?.emptyGraceMs||180000,
        onEmpty:async()=>{if(!['recording','paused'].includes(current.bridge.state.status))return;current.acceptAudio=false;current.addressing?.cancel();stopCapture(current);current.playback.stop(true);await bridge.api(bridge.path+'/events',{type:'lifecycle',action:'empty'});if(!config.fixed)await notifyOwner(bridge.state,'通話の参加者が0人です。新しい音声は記録していません。3分以内に戻れば同じ会議を続けます。');},
        onReturn:async()=>{if(current.closing||current.bridge.state.status!=='empty_grace')return;const returned=await bridge.api(bridge.path+'/events',{type:'lifecycle',action:'returned'});if(returned.status==='recording'){await bridge.recording(true);current.acceptAudio=true;}},
        onFinish:()=>finish(current,{reason:'empty_timeout'}),onError:()=>console.error('退出猶予の処理に失敗しました。/waigaya status を確認してください。')});
      current.grace.start();
      current.onVoiceState=(old,next)=>{
        if(meeting!==current||current.closing)return;
        if(next.id===client.user.id&&next.channelId!==current.channelId){void finish(current,{reason:'bot_moved',abort:true}).catch(()=>{});return;}
        if(old.channelId===current.channelId||next.channelId===current.channelId){
          void current.grace.members(humanCount(channel));
          if(next.channelId===current.channelId&&old.channelId!==next.channelId&&!next.member?.user.bot){
            void bridge.enqueue({type:'participant',userId:next.id}).catch(()=>{});
            void notifyOwner({...bridge.state,ownerId:next.id},'この通話では会議の記録を管理しています。/waigaya status で記録中・一時停止を確認できます。記録中の音声はOpenAIへ送り、文字起こし・議事録はホストへ保存します。元音声は保存しません。'+(config.fixed?`終了後は <#${config.fixed.minutesForumId}> の閲覧者へAI生成・未確認の議事録を自動公開します。`:''));
          }
        }
      };
      client.on(Events.VoiceStateUpdate,current.onVoiceState);await current.grace.members(humanCount(channel));return current;
    }catch{
      current?.addressing?.close();current?.grace?.close();current?.facilitator?.close();playback?.close();connection?.destroy();await bridge?.close().catch(()=>{});
      if(bridge?.state?.id)await service.api(bridge.path+'/events',{type:'lifecycle',action:'pause'}).catch(()=>{});
      if(meeting===current)meeting=null;
      throw new Error('通話に接続できません。記録は停止しました。権限・接続を確認し /resume を使ってください。');
    }finally{starting=false;}
  }
  async function begin(interaction,channel,topic,mode,outputChannelId){
    if(beginning)throw new Error('開始処理中です。');beginning=true;try{
    if(config.fixed){
      if(!policyReady)await initializePolicy(interaction.guild);else await validateChannels(interaction.guild,config.fixed);
      if(channel?.id!==config.fixed.voiceChannelId||humanCount(channel)===0)throw new Error('固定VCに参加してから開始してください。');
      if(outputChannelId&&outputChannelId!==config.fixed.minutesForumId)throw new Error('公開先は固定フォーラムです。');
      mode=policyMode(config.fixed);outputChannelId=config.fixed.minutesForumId;topic=topic||automaticTitle(channel);
    }
    if(!Object.hasOwn(modes,mode))throw new Error('表示された会議モードから選んでください。');
    if(!channel||channel.type!==ChannelType.GuildVoice)throw new Error('通常のボイスチャンネルに入ってから開始してください。');
    if(meeting||starting)throw new Error('会議を処理中です。/waigaya status を使ってください。');
    const permissions=channel.permissionsFor(interaction.member);
    if(!permissions?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.Connect]))throw new Error('会議のチャンネルを閲覧・接続する権限が必要です。');
    if(outputChannelId===undefined)outputChannelId=(await service.api(`/api/guilds/${config.guildId}/settings`)).defaultMinutesChannelId;
    if(outputChannelId){let target;try{target=await interaction.guild.channels.fetch(outputChannelId);}catch{throw new Error('保存先を取得できません。管理者が導入設定とチャンネル権限を確認してください。');}requireOutput(target,interaction.member,interaction.guild.members.me);}
    const notice = config.fixed?`会議を記録します。${mode==='minutes'?'AI音声は停止しています。':'ワイガヤと呼びかけると音声で返答します。'}音声をOpenAIのSTT・AIへ送り、原音声は保存せず文字起こしを保持します。全員退出後に自動終了し、${config.fixed.autoPublish?`<#${outputChannelId}> を閲覧できる全員へAI生成・未確認の議事録を自動公開します。`:'議事録を非公開保存します。'}`:`記録を開始します。モード：${modes[mode]}。音声はOpenAIへ送信、文字起こし・下書きはホストに保存。元音声は保存しません。公開先：${outputChannelId?`<#${outputChannelId}>（人が確認・公開操作するまで本文投稿なし）`:'未指定・本文の自動公開なし'}。`;
    await channel.send(safe(notice));
    await interaction.editReply(safe(notice));
    const result=await start(channel,topic,{mode,ownerId:interaction.user.id,outputChannelId:outputChannelId||null,noticeAt:Date.now()});
    await interaction.editReply({...safe((config.fixed?`会議を記録しています。${mode==='minutes'?'AI音声は停止しています。':'ワイガヤと呼びかけると返答します。'}退出後は自動終了${config.fixed.autoPublish?`・議事録を <#${outputChannelId}> に投稿`:''}します。`:`記録中：${modes[mode]}。${mode==='minutes'?'AI音声は常にOFFです。':''}/pause は記録を一時停止、/quiet はAIだけ停止、/finish は会議を終了して議事録を作ります。`)),components:[]});return result;
    }finally{beginning=false;}
  }
  async function preview(interaction,state){
    const base=`/api/sessions/${state.id}`;
    const attachments=[];
    if(state.minutesHistory.at(-1))attachments.push(...splitAttachments(minutesMarkdown(state),`minutes-v${state.minutesVersion}.md`,interaction.attachmentSizeLimit||8*1024*1024),...splitAttachments(JSON.stringify(state.minutesHistory.at(-1).document,null,2),`minutes-v${state.minutesVersion}.json`,interaction.attachmentSizeLimit||8*1024*1024));
    const bridge=bridgeFactory(config.server,{serviceToken:config.serviceToken});bridge.state=state;
    try{attachments.push(...splitAttachments(await bridge.artifact('transcript.md'),'transcript.md',interaction.attachmentSizeLimit||8*1024*1024));}catch{await service.api(base+'/events',{type:'health',kind:'file_export',healthy:false}).catch(()=>{});}
    if(attachments.length>10)throw new Error('添付が10個を超えています。容量の大きい成果物を個別取得できるよう管理者へ相談してください。原本は保持しています。');
    await interaction.editReply({...safe(`会議：${state.topic}\n状態：${statusLabels[state.status]||'状態確認が必要'}／議事録：${minutesLabels[state.minutesStatus]||'未作成'} 版${state.minutesVersion}\n${state.minutesHistory.at(-1)?.kind==='summary'?'途中要約（正式議事録ではありません）':'正式議事録'}／公開：${publicationLabels[publicationState(state)]}${state.fixedOperation&&state.minutesHistory.at(-1)?(state.minutesHistory.at(-1).approvedAt?'／人が確認済み':'／AI生成・未確認'):''}\n保存先：${state.outputChannelId?`<#${state.outputChannelId}>`:'未設定・非公開'}\n${state.lastError||''}\nファイルは本人だけに表示します。確認済み操作は議事録の確認であり、決定候補を合意として確定する操作ではありません。`),files:attachments,components:minutesControls(state,interaction.user.id)});
  }
  async function outputFor(state,interaction){
    if(!state.outputChannelId)throw new Error('保存先が未設定です。議事録画面の「保存先を選ぶ」か /destination を使い、確認して投稿をやり直してください。');
    let output;try{output=await interaction.guild.channels.fetch(state.outputChannelId);}catch{throw new Error('保存先を取得できません。削除・権限を確認し /destination で選び直してください。');}
    requireOutput(output,interaction.member,interaction.guild.members.me);return output;
  }
  async function showReview(interaction,state,{alreadyApproved=false}={}){
    const version=state.minutesHistory.at(-1);requireFormal(state,version);
    if(alreadyApproved&&!version.approvedAt)throw new Error('/minutes の「確認して投稿」を使ってください。');
    const output=await outputFor(state,interaction),prepared=await preparePublication({state,channel:output,actor:interaction.member,bot:interaction.guild.members.me,attachmentLimit:interaction.attachmentSizeLimit});
    const id=confirmations.issue(alreadyApproved?'publish':'reviewpublish',state,interaction.user.id);
    await interaction.editReply({...safe(`保存先：${output.type===ChannelType.GuildForum?'フォーラム':'テキスト'} <#${output.id}>\n公開範囲：この親チャンネルを閲覧できる全員。会議だけの非公開投稿ではありません。\n対象：正式議事録 版${version.version}${state.fixedOperation&&state.publications.some(p=>p.version===version.version&&p.status==='published')&&!version.approvedAt?`（人の確認は版${version.version+1}として追記）`:''}\nタグ：${prepared.tags.map(t=>safeText(t.name)).join('、')||'なし'}${prepared.thread?.archived?'（投稿を再開して追記します）':''}\n${prepared.content.slice(0,1100)}\n（短いプレビューです。全文は議事録の添付で確認してください。）\n\n確認は操作担当者によるものです。最終確認後に承認を保存して直ちに投稿します（60秒で失効）。`),components:confirmation(id,'確認してこの先へ投稿する')});
  }
  async function showDestination(interaction,state){
    const id=confirmations.issue('destination',state,interaction.user.id);
    await interaction.reply({...safe('この会議の保存先を選び直します。設定だけでは投稿しません。投稿前に版と公開範囲を再確認します。'),flags:MessageFlags.Ephemeral,components:[new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId(`wg:destinationselect:${id}`).setChannelTypes(ChannelType.GuildForum,ChannelType.GuildText).setMinValues(1).setMaxValues(1))]});
  }
  client.on(Events.InteractionCreate,async interaction=>{
    const supported=interaction.isChatInputCommand?.()||interaction.isAutocomplete?.()||interaction.isButton?.()||interaction.isStringSelectMenu?.()||interaction.isModalSubmit?.()||interaction.isChannelSelectMenu?.();
    if(!supported)return;
    if(interaction.commandName&&interaction.commandName!=='waigaya')return;
    if(interaction.customId&&!interaction.customId.startsWith('wg:'))return;
    try{
      if(interaction.guildId!==config.guildId)throw new Error('設定されたサーバーで使ってください。');
      if(interaction.isAutocomplete?.()){
        const candidates=[];
        for(const state of (await list()).filter(s=>canControl(s,interaction,config.controlRoleIds)).slice(0,50)){
          try{await access(state,interaction);candidates.push({name:`${state.topic} (${statusLabels[state.status]||'状態確認が必要'})`.slice(0,100),value:state.id});}catch{}
        }
        const query=interaction.options.getFocused();await interaction.respond(candidates.filter(s=>s.name.includes(query)).slice(0,25));return;
      }
      const channel=interaction.guild?.voiceStates.cache.get(interaction.user.id)?.channel;
      if(interaction.isChannelSelectMenu?.()&&interaction.customId.startsWith('wg:destinationselect:')){const intent=confirmations.take(interaction.customId.split(':')[2],interaction.user.id);await interaction.deferUpdate();const state=await stateFor(intent.sessionId);await access(state,interaction);if(state.minutesVersion!==intent.version)throw new Error('版が変わりました。/minutes から選び直してください。');const target=await interaction.guild.channels.fetch(interaction.values[0]);requireOutput(target,interaction.member,interaction.guild.members.me);const updated=await service.api(`/api/sessions/${state.id}/minutes`,{action:'destination',channelId:target.id,actorId:interaction.user.id});await preview(interaction,updated);return;}
      if(interaction.isStringSelectMenu?.()&&interaction.customId.startsWith('wg:start:')){
        const id=interaction.customId.split(':')[2],request=starts.get(id);
        if(!request||request.ownerId!==interaction.user.id||request.expiresAt<Date.now()||request.channelId!==channel?.id)throw new Error('開始の選択が失効しました。同じ通話で /start を使ってください。');
        starts.delete(id);await interaction.deferUpdate();await interaction.editReply({...safe('開始処理中です。'),components:[]});await begin(interaction,channel,request.topic,interaction.values[0],request.outputChannelId);return;
      }
      if(interaction.isModalSubmit?.()){
        const id=interaction.customId.split(':')[2],form=editorForms.get(id);
        if(!form||form.userId!==interaction.user.id||form.expiresAt<Date.now())throw new Error('訂正の画面が失効しました。/minutes から開き直してください。');
        editorForms.delete(id);await interaction.deferReply({flags:MessageFlags.Ephemeral});
        const state=await stateFor(form.sessionId);await access(state,interaction);
        if(form.kind==='transcript'){
          const u=state.utterances.find(u=>u.id===form.utteranceId);
          if(!u||u.revision!==form.revision)throw new Error('原発言が更新されました。/minutes から開き直してください。');
          const text=u.text.slice(0,form.offset)+interaction.fields.getTextInputValue('text')+u.text.slice(form.end);
          const updated=await service.api(`/api/sessions/${state.id}/events`,{type:'utterance',actorId:interaction.user.id,utterance:{id:u.id,text,speaker:u.speaker,source:'manual',final:true,expectedRevision:u.revision}});
          await preview(interaction,updated);return;
        }
        if(state.minutesVersion!==form.version)throw new Error('議事録の版が変わりました。/minutes で確認してください。');
        const document=structuredClone(state.minutesHistory.at(-1).document);
        document[form.section][form.index].text=interaction.fields.getTextInputValue('text');
        const updated=await service.api(`/api/sessions/${state.id}/minutes`,{action:'edit',version:form.version,actorId:interaction.user.id,document});await preview(interaction,updated);return;
      }
      if(interaction.isStringSelectMenu?.()&&interaction.customId.startsWith('wg:rawitem:')){
        if(interaction.customId.split(':').at(-1)!==interaction.user.id)throw new Error('訂正画面の実行者が異なります。/minutes から開き直してください。');
        const sessionId=interaction.customId.split(':')[2],state=await stateFor(sessionId);await access(state,interaction);
        if(state.revision!==Number(interaction.customId.split(':')[3]))throw new Error('原発言が更新されました。/minutes から開き直してください。');
        const [indexString,offsetString]=interaction.values[0].split(':'),u=state.utterances.filter(u=>u.final)[Number(indexString)],offset=Number(offsetString);
        if(!u||!Number.isInteger(offset)||offset<0||offset>=u.text.length)throw new Error('訂正対象が更新されました。/minutes から開き直してください。');
        const id=confirmations.issue('edit',state,interaction.user.id);editorForms.set(id,{kind:'transcript',userId:interaction.user.id,sessionId,utteranceId:u.id,revision:u.revision,offset,end:Math.min(offset+4000,u.text.length),expiresAt:Date.now()+60000});
        const modal=new ModalBuilder().setCustomId(`wg:editform:${id}`).setTitle('原発言を訂正');modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('text').setLabel('原発言の本文（該当部分のみ）').setStyle(TextInputStyle.Paragraph).setMaxLength(4000).setRequired(true).setValue(u.text.slice(offset,offset+4000))));await interaction.showModal(modal);return;
      }
      if(interaction.isStringSelectMenu?.()&&interaction.customId.startsWith('wg:item:')){
        if(interaction.customId.split(':').at(-1)!==interaction.user.id)throw new Error('訂正画面の実行者が異なります。');
        const [, ,sessionId,versionString]=interaction.customId.split(':'),state=await stateFor(sessionId);await access(state,interaction);
        if(state.minutesVersion!==Number(versionString))throw new Error('版が更新されました。/minutes からやり直してください。');
        const [section,indexString]=interaction.values[0].split(':'),index=Number(indexString),item=state.minutesHistory.at(-1).document[section]?.[index];
        if(!item)throw new Error('訂正対象がありません。');
        const id=confirmations.issue('edit',state,interaction.user.id);editorForms.set(id,{userId:interaction.user.id,sessionId,version:state.minutesVersion,section,index,expiresAt:Date.now()+60000});
        const modal=new ModalBuilder().setCustomId(`wg:editform:${id}`).setTitle('議事録の項目を訂正');
        modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('text').setLabel('本文（根拠は維持します）').setStyle(TextInputStyle.Paragraph).setMaxLength(2000).setRequired(true).setValue(item.text)));
        await interaction.showModal(modal);return;
      }
      if(interaction.isButton?.()){
        const [,operation,id,versionString]=interaction.customId.split(':');
        if(operation==='confirm'){
          const intent=confirmations.take(id,interaction.user.id),state=await stateFor(intent.sessionId);await access(state,interaction,{live:intent.operation==='finish'});
          await interaction.deferUpdate();
          if(intent.operation==='finish'){
            if(meeting?.bridge.state.id===state.id)await finish(meeting);
            else if(!meeting&&['recording','empty_grace','paused'].includes(state.status)){await service.api(`/api/sessions/${state.id}/finish`,{});announceMinutes(state.id);}
            else throw new Error('対象の会議は終了・切替済みです。/minutes を使ってください。');
            await interaction.editReply({...safe('記録を終了しました。議事録を生成中です。/minutes で確認できます。'),components:[]});return;
          }
          if(intent.operation==='retry'){
            requireAdministrator(interaction);if(publisher.busy(state.id))throw new Error('送信処理中です。完了後に照合してください。');
            await service.api(`/api/sessions/${state.id}/minutes`,{action:'publication_retry',version:intent.version,channelId:intent.channelId,reservationId:intent.reservationId,absenceToken:intent.absenceToken,actorId:interaction.user.id});
            await interaction.editReply({...safe('未投稿の管理確認を記録しました。固定運用は自動投稿を再試行します。旧会議はminutesから確認して投稿できます。'),components:[]});return;
          }
          if(['publish','reviewpublish'].includes(intent.operation)){
            if(state.minutesVersion!==intent.version||state.outputChannelId!==intent.channelId||(state.outputRevision||0)!==intent.outputRevision)throw new Error('版または保存先が変わりました。/minutes で確認し直してください。');
            const output=await outputFor(state,interaction);requireFormal(state,state.minutesHistory.at(-1));
            const approved=intent.operation==='reviewpublish'?await service.api(`/api/sessions/${state.id}/minutes`,{action:'approve',version:intent.version,actorId:interaction.user.id}):state;
            const result=await publisher.publish({state:approved,channel:output,actor:interaction.member,bot:interaction.guild.members.me,attachmentLimit:interaction.attachmentSizeLimit,api:body=>service.api(`/api/sessions/${state.id}/minutes`,body)});
            await interaction.editReply({...safe(`確認済み議事録を${result.duplicate?'取得しました（投稿済み・二重投稿なし）':'投稿しました'}。\n${result.url||`https://discord.com/channels/${state.guildId}/${result.threadId||output.id}/${result.messageId}`}\n${result.warning||''}`),components:[],files:[]});return;
          }
        }
        const state=await stateFor(id);await access(state,interaction);
        if(interaction.customId.split(':').at(-1)!==interaction.user.id)throw new Error('操作画面の実行者が異なるか旧画面です。/minutes から開き直してください。');
        if(Number(versionString)!==state.minutesVersion)throw new Error('議事録の版が変わりました。/minutes を使ってください。');
        if(operation==='destination'&&config.fixed)throw new Error('保存先は固定フォーラムです。');
        if(operation==='destination'){await showDestination(interaction,state);return;}
        if(operation==='review'){await interaction.deferUpdate();await showReview(interaction,state);return;}
        if(['transcript','rawpage'].includes(operation)){
          const {StringSelectMenuBuilder}=await import('discord.js');const options=[];
          state.utterances.filter(u=>u.final).forEach((u,index)=>{for(let offset=0;offset<u.text.length;offset+=4000)options.push({label:`${u.speaker||'発言'}: ${u.text.slice(offset,offset+65)}`.slice(0,100),value:`${index}:${offset}`});});
          if(!options.length)throw new Error('確定した原発言がありません。');
          const page=operation==='rawpage'?Number(interaction.customId.split(':')[4]):0;
          if(!Number.isInteger(page)||page<0||page*25>=options.length)throw new Error('表示が失効しました。/minutes を使ってください。');
          const {ButtonBuilder,ButtonStyle}=await import('discord.js');const controls=[new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`wg:rawitem:${id}:${state.revision}:${interaction.user.id}`).addOptions(options.slice(page*25,(page+1)*25)))];
          const navigation=[];if(page>0)navigation.push(new ButtonBuilder().setCustomId(`wg:rawpage:${id}:${state.minutesVersion}:${page-1}:${interaction.user.id}`).setLabel('前の発言').setStyle(ButtonStyle.Secondary));if((page+1)*25<options.length)navigation.push(new ButtonBuilder().setCustomId(`wg:rawpage:${id}:${state.minutesVersion}:${page+1}:${interaction.user.id}`).setLabel('次の発言').setStyle(ButtonStyle.Secondary));if(navigation.length)controls.push(new ActionRowBuilder().addComponents(navigation));
          await interaction.reply({...safe('訂正する原発言を選んでください。訂正履歴を残し、関連する議事録は要再確認にします。'),flags:MessageFlags.Ephemeral,components:controls});return;
        }
        if(operation==='approve'){
          await interaction.deferUpdate();const updated=await service.api(`/api/sessions/${id}/minutes`,{action:'approve',version:Number(versionString),actorId:interaction.user.id});await preview(interaction,updated);return;
        }
        if(['edit','editpage'].includes(operation)){
          const {StringSelectMenuBuilder,ButtonBuilder,ButtonStyle}=await import('discord.js');const options=[];
          for(const [section,items] of Object.entries(state.minutesHistory.at(-1).document))items.forEach((item,index)=>options.push({label:item.text.slice(0,90),value:`${section}:${index}`}));
          if(!options.length)throw new Error('訂正する項目がありません。');
          const page=operation==='editpage'?Number(interaction.customId.split(':')[4]):0;
          if(!Number.isInteger(page)||page<0||page*25>=options.length)throw new Error('表示が失効しました。/minutes から開き直してください。');
          const controls=[new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`wg:item:${id}:${state.minutesVersion}:${interaction.user.id}`).addOptions(options.slice(page*25,(page+1)*25)))],navigation=[];
          if(page>0)navigation.push(new ButtonBuilder().setCustomId(`wg:editpage:${id}:${state.minutesVersion}:${page-1}:${interaction.user.id}`).setLabel('前の項目').setStyle(ButtonStyle.Secondary));
          if((page+1)*25<options.length)navigation.push(new ButtonBuilder().setCustomId(`wg:editpage:${id}:${state.minutesVersion}:${page+1}:${interaction.user.id}`).setLabel('次の項目').setStyle(ButtonStyle.Secondary));
          if(navigation.length)controls.push(new ActionRowBuilder().addComponents(navigation));
          await interaction.reply({...safe(`訂正する項目を選んでください（${page+1}/${Math.ceil(options.length/25)}ページ）。根拠の変更は原発言の修正・再生成を使います。`),flags:MessageFlags.Ephemeral,components:controls});return;
        }
        throw new Error('旧候補は使えません。/waigaya ask を使ってください。');
      }
      const action=interaction.options.getSubcommand();
      if(config.fixed&&['setup','destination'].includes(action))throw new Error('保存先は導入時の固定設定です。この操作では変更しません。');
      if(config.fixed&&['mode','auto'].includes(action)&&!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild))throw new Error('応答方針の変更は管理者だけが操作できます。');
      if(action==='help'){await interaction.reply({...safe(help(interaction.options.getString('detail')==='developer',Boolean(config.fixed))),flags:MessageFlags.Ephemeral});return;}
      if(action==='setup'){requireAdministrator(interaction);const target=interaction.options.getChannel('channel'),clear=interaction.options.getBoolean('clear')===true;if(!target&&!clear)throw new Error('議事録の保存先を選ぶか clear で解除してください。');if(target&&clear)throw new Error('保存先指定と解除はどちらか一つを選んでください。');if(target)requireOutput(target,interaction.member,interaction.guild.members.me);await interaction.deferReply({flags:MessageFlags.Ephemeral});await service.api(`/api/guilds/${config.guildId}/settings`,{channelId:target?.id||null,actorId:interaction.user.id});await interaction.editReply(safe(target?`既定の保存先を <#${target.id}> に登録しました。新しい会議に適用し、確認するまで投稿しません。`:'既定の保存先を解除しました。新しい会議は非公開です。'));return;}
      if(action==='start'){
        if(!channel)throw new Error('通話に入ってから /start を使ってください。');
        const topic=interaction.options.getString('topic')||`Discord：${channel.name}`,mode=interaction.options.getString('mode'),outputChannelId=interaction.options.getChannel('output_channel')?.id;
        if(config.fixed){await interaction.deferReply({flags:MessageFlags.Ephemeral});await begin(interaction,channel,interaction.options.getString('topic')||undefined,policyMode(config.fixed),outputChannelId);return;}
        if(!mode){
          const id=confirmations.issue('start',{id:channel.id},interaction.user.id);starts.set(id,{ownerId:interaction.user.id,channelId:channel.id,topic,outputChannelId,expiresAt:Date.now()+60000});
          await interaction.reply({...safe('モードを選んで開始してください。「議事録のみ」はAI音声なしです。選択するまでは記録しません。'),flags:MessageFlags.Ephemeral,components:chooseMode(id)});return;
        }
        await interaction.deferReply();await begin(interaction,channel,topic,mode,outputChannelId);return;
      }
      await interaction.deferReply({flags:MessageFlags.Ephemeral});
      const state=await resolveMeeting(interaction);await access(state,interaction,{live:!['minutes','publish','status','destination','reconcile'].includes(action)});
      if(action==='minutes'){
        if(interaction.options.getString('action')==='retry'){await service.api(`/api/sessions/${state.id}/minutes`,{action:'retry'});await interaction.editReply(safe('議事録を再生成しています。元の文字起こしは保持しています。/minutes で確認してください。'));}
        else await preview(interaction,state);return;
      }
      if(action==='destination'){
        const target=interaction.options.getChannel('channel'),clear=interaction.options.getBoolean('clear')===true;
        if((!target&&!clear)||(target&&clear))throw new Error('保存先または解除のどちらかを選んでください。');
        if(target)requireOutput(target,interaction.member,interaction.guild.members.me);
        await preview(interaction,await service.api(`/api/sessions/${state.id}/minutes`,{action:'destination',channelId:target?.id||null,actorId:interaction.user.id}));return;
      }
      if(action==='reconcile'){
        requireAdministrator(interaction);if(publisher.busy(state.id))throw new Error('投稿処理中です。完了後に照合してください。');
        const p=state.publications.findLast(p=>unresolved(p)||p.status==='failed_confirmed');if(!p)throw new Error('照合が必要な送信予約はありません。/minutes で確認してください。');
        const output=await interaction.guild.channels.fetch(p.channelId);requireDestinationView(output,interaction.member);
        const operation=interaction.options.getString('action')||'inspect',api=body=>service.api(`/api/sessions/${state.id}/minutes`,{version:p.version,channelId:p.channelId,reservationId:p.reservationId,actorId:interaction.user.id,...body});
        if(operation==='link'){const delivery=await verifyMessageLink({state,publication:p,guild:interaction.guild,bot:interaction.guild.members.me,url:interaction.options.getString('url')});await api({action:'publication_link',...delivery});await interaction.editReply(safe(`投稿を照合して復旧しました。二重投稿していません。\n${delivery.url}`));return;}
        if(p.status==='failed_confirmed'){await interaction.editReply(safe('未送信が確認済みです。権限・タグ・容量を修正し、/minutes で確認して投稿をやり直せます。'));return;}
        const result=await inspectPublication({state,publication:p,channel:output,bot:interaction.guild.members.me});
        if(result.matches.length===1){await api({action:'publication_link',...result.matches[0]});await interaction.editReply(safe(`投稿を照合して復旧しました。\n${result.matches[0].url}`));return;}
        if(result.matches.length>1)throw new Error('一致する投稿が複数あります。管理者が投稿URLを選んで照合してください。自動再送しません。');
        if(operation!=='retry'){await interaction.editReply(safe(result.complete?'一致する投稿がありませんでした。旧送信プロセスの停止と削除の有無を管理者が確認し、送信から10分後に /reconcile action:未送信を確認して再試行を許可 を使ってください。':'照合範囲の上限を超えました。投稿URLでの照合を使ってください。未送信と判断していません。'));return;}
        if(!result.complete)throw new Error('全範囲の照合が終わっていません。再試行を許可できません。');
        const updated=await api({action:'publication_absence',complete:true}),checked=updated.publications.find(item=>item.reservationId===p.reservationId);
        const id=confirmations.issue('retry',{...state,minutesVersion:p.version,outputChannelId:p.channelId},interaction.user.id,{reservationId:p.reservationId,absenceToken:checked.absenceToken});
        await interaction.editReply({...safe(`保存先 <#${p.channelId}> の版${p.version}について一致投稿は見つかりませんでした。旧送信プロセスが停止し、投稿を削除していないこと、未投稿であることを管理者が確認してください。60秒以内の明示確認だけで再試行を許可します。`),components:confirmation(id,'未投稿を確認し、再試行を許可する')});return;
      }
      if(action==='publish'){await showReview(interaction,state,{alreadyApproved:true});return;}
      if(action==='status'){
        await interaction.editReply(safe(`会議：${state.topic}\n記録：${statusLabels[state.status]||'状態確認が必要'}／モード：${modes[state.mode]}／AI音声：${canSpeak(state)?'利用可':'OFF'}\n経過：約${state.startedAt?Math.floor(((state.endedAt||Date.now())-state.startedAt)/60000):0}分\n公開：${publicationLabels[publicationState(state)]}${state.fixedOperation&&state.minutesHistory.at(-1)?(state.minutesHistory.at(-1).approvedAt?'／人が確認済み':'／AI生成・未確認'):''}\n保存：ホストSQLite（${state.health.storage==='failed'?'直近の保存を確認できません':'最新保存確認済み'}）／議事録：${minutesLabels[state.minutesStatus]||'未作成'}\n新しい音声の外部送信：${state.status==='recording'?'記録する発話をOpenAIへ送信':'停止'}\n公開先：${state.outputChannelId?`<#${state.outputChannelId}>`:'未指定'}\n${state.lastError||''}\n障害：${Object.entries(state.health).filter(([,v])=>v==='failed').map(([k])=>healthLabels[k]||'状態確認が必要').join('、')||'検出なし'}`));return;
      }
      if(action==='end'){if(meeting?.bridge.state.id!==state.id)throw new Error('記録中の会議がありません。');await finish(meeting);await interaction.editReply(safe('記録を終了しました。Botは退出し、議事録の処理を続けます。'));return;}
      if(action==='resume'&&!meeting){
        if(state.status!=='paused')throw new Error('再開可能な一時停止会議がありません。/start で新しく始めてください。');
        const vc=await access(state,interaction,{live:true});await interaction.editReply(safe('同じ会議の記録を明示的に再開します。音声をOpenAIへ送り、ホストに保存します。'));
        await vc.send(safe(`会議の記録を再開します。モード：${modes[state.mode]}。音声をOpenAIへ送り、ホストへ保存します。${config.fixed&&config.fixed.autoPublish?`終了後は固定フォーラム <#${config.fixed.minutesForumId}> の閲覧者にAI生成・未確認の議事録を自動公開します。`:'本文の自動公開はしません。'}`));await start(vc,undefined,{sessionId:state.id});await interaction.editReply(safe('同じ会議IDで記録を再開しました。'));return;
      }
      if(['finish','leave'].includes(action)){
        if(!['recording','empty_grace','paused'].includes(state.status))throw new Error('会議は終了済みです。/minutes で議事録を確認してください。');
        const id=confirmations.issue('finish',state,interaction.user.id);await interaction.editReply({...safe('この会議の記録を終了し、議事録の下書きを生成します。終了しますか（60秒で失効）？'),components:confirmation(id,'会議を終了する')});return;
      }
      if(!meeting||meeting.bridge.state.id!==state.id)throw new Error('会議は記録中ではありません。/minutes で記録を確認してください。');
      const current=meeting;
      if(action==='pause'){
        current.playback.stop(true);await drain(current);await current.bridge.api(current.bridge.path+'/events',{type:'lifecycle',action:'pause'});await current.bridge.recording(false);if(humanCount(current.channel)===0)await current.grace.members(0);await interaction.editReply(safe('記録を一時停止しました。新しい音声はOpenAIへ送っていません。/resume で再開します。'));return;
      }
      if(action==='resume'){
        await current.channel.send(safe(`会議の記録を再開します。モード：${modes[state.mode]}。音声をOpenAIへ送り、ホストへ保存します。`));await current.bridge.api(current.bridge.path+'/events',{type:'lifecycle',action:'resume',actorId:interaction.user.id});await current.bridge.recording(true);current.acceptAudio=true;await interaction.editReply(safe('記録を再開しました。再開後の新しい発言だけ記録します。'));return;
      }
      if(action==='mode'||action==='auto'){
        const mode=action==='mode'?interaction.options.getString('mode'):interaction.options.getBoolean('enabled')?'facilitator':null;
        current.playback.stop(true);
        await current.bridge.api(current.bridge.path+'/events',mode?{type:'configure',mode,actorId:interaction.user.id}:{type:'configure',quiet:true,actorId:interaction.user.id});
        await interaction.editReply(safe(mode?`モードを「${modes[mode]}」に変更しました。記録と会議IDは継続します。`:'AI音声・自律発言を停止しました。記録は続けます。/mode で再開します。'));return;
      }
      if(['quiet','stop'].includes(action)){
        current.playback.stop(true);await current.bridge.api(current.bridge.path+'/events',{type:'configure',quiet:true,actorId:interaction.user.id});await interaction.editReply(safe('AI音声と自律発言を止めました。記録は続けます。再開は /mode、記録停止は /pause です。'));return;
      }
      if(action==='summary'){
        await current.bridge.api(current.bridge.path+'/summary',{});await interaction.editReply(safe('ここまでの要約を生成しています。会議は続けます。/minutes で文字とMarkdownを確認してください。'));return;
      }
      if(action==='ask'){
        current.addressing?.cancel();
        if(current.asking)throw new Error('回答を準備中です。完了後に /ask を使ってください。');current.asking=true;
        try{const answer=await current.bridge.ask();const voice=interaction.options.getBoolean('voice')===true&&canSpeak(answer);
          await interaction.editReply(proposal(answer,{voice}));if(voice&&answer.reply?.action!=='hold')await current.bridge.speakReply(answer.reply.requestId);
          else if(answer.reply)await current.bridge.api(current.bridge.path+'/events',{type:'discard'});
        }finally{current.asking=false;}return;
      }
    }catch(e){
      if(interaction.isAutocomplete?.()){await interaction.respond([]).catch(()=>{});return;}
      // Operation errors may contain user data; use bounded messages produced by the application only.
      const content=e instanceof UserError?e.message:'操作を完了できませんでした。状態・権限・版・接続を確認し、/waigaya status または /waigaya help を使ってください。記録の削除は行っていません。';
      try{if(interaction.deferred||interaction.replied)await interaction.editReply({...safe(content),components:[]});else await interaction.reply({...safe(content),flags:MessageFlags.Ephemeral});}catch{console.error('Discordへ操作結果を送れませんでした。記録状態はstatusで確認してください。');}
    }
  });
  client.on('error',()=>console.error('Discord接続に失敗しました。'));
  async function initializePolicy(guild){
    if(!config.fixed)return;
    await validateChannels(guild,config.fixed);await service.api(`/api/guilds/${config.guildId}/fixed-policy`,config.fixed);policyReady=true;
    if(!completionWorker){completionWorker=new FixedCompletionWorker({service,client,policy:config.fixed,publisher,notify:notifyOwner,hasActiveSession:id=>meeting?.bridge.state.id===id});completionWorker.start();}
  }
  client.once(Events.ClientReady,async()=>{
    try {
      if(config.fixed)await initializePolicy(await client.guilds.fetch(config.guildId));
      for(const saved of await list()){
        await service.api(`/api/sessions/${saved.id}/minutes`,{action:'publication_recover'});
        if(['recording','created'].includes(saved.status)||!saved.fixedOperation&&saved.status==='empty_grace'){
          await service.api(`/api/sessions/${saved.id}/events`,{type:'lifecycle',action:'pause'});
          await service.api(`/api/sessions/${saved.id}/events`,{type:'health',kind:'connection',healthy:false,gap:{startedAt:null,endedAt:Date.now()}});
        }
      }
      if(config.fixed)await completionWorker.tick();
    }catch{policyReady=false;console.error('固定設定・前回会議の復旧を確認できません。記録は開始しません。管理者が設定を確認してください。');}
    console.log('Discord Botを起動しました。起動だけでは記録しません。固定VCで /start を使ってください。');
  });
  const quit=()=>void (async()=>{completionWorker?.close();if(meeting){const current=meeting;current.closing=true;current.addressing?.close();current.grace.close();current.facilitator.close();current.playback.close();await drain(current);await current.bridge.api(current.bridge.path+'/events',{type:'lifecycle',action:'pause'});current.closed=true;await current.bridge.close();current.connection.destroy();}client.destroy();})().finally(()=>process.exit(0));
  process.once('SIGINT',quit);process.once('SIGTERM',quit);
  try{await client.login(config.token);}catch{client.destroy();throw new Error('Discordへログインできません。トークンと接続を確認してください。');}
  return {client,get meeting(){return meeting;},get completionWorker(){return completionWorker;},close:async()=>{disposed=true;completionWorker?.close();process.off('SIGINT',quit);process.off('SIGTERM',quit);if(meeting)await finish(meeting);client.destroy();}};
}
if(process.argv[1]?.endsWith('/discord/bot.js'))runBot().catch(()=>{console.error('Discord Botを起動できません。discord-setup.mdに従って設定してください。');process.exitCode=1;});
