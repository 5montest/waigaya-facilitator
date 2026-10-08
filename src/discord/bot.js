import { UserError as Error, UserError } from '../errors.js';
import { Client, GatewayIntentBits, Events, MessageFlags, ChannelType, PermissionFlagsBits, AttachmentBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } from 'discord.js';
import { joinVoiceChannel, entersState, VoiceConnectionStatus, EndBehaviorType } from '@discordjs/voice';
import prism from 'prism-media';
import { discordConfig } from './config.js';
import { MeetingBridge } from './bridge.js';
import { DiscordPlayback } from './playback.js';
import { transcribeSpeaker } from './transcription.js';
import { proposal, confirmation, minutesControls, chooseMode, help } from './commands.js';
import { loadOpenAIKey } from '../credentials.js';
import { VoiceActivity } from './audio.js';
import { AutonomousFacilitator } from './autonomy.js';
import { EmptyGrace, modes, canSpeak, statusLabels, minutesLabels, healthLabels } from '../meeting.js';
import { requireAccess, requireOutput, canControl, Confirmations, MinutesPublisher } from './access.js';
import { minutesMarkdown, minutesStale } from '../minutes.js';

export async function runBot({ config = discordConfig(), client = new Client({ intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildVoiceStates] }), join = joinVoiceChannel, ready = entersState, bridgeFactory = (base,options)=>new MeetingBridge(base,options), transcribe = transcribeSpeaker } = {}) {
  if(!loadOpenAIKey().configured) throw new Error('OpenAIキーを設定してください。');
  if(!config.serviceToken) throw new Error('Bot・会議サーバー間の認証ファイルを設定してください。discord-setup.mdを参照してください。');
  const confirmations=new Confirmations(), publisher=new MinutesPublisher(), starts=new Map(), editorForms=new Map();
  const service=bridgeFactory(config.server,{serviceToken:config.serviceToken});
  let meeting=null,starting=false;
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
        while(Date.now()<deadline){
          const saved=await stateFor(sessionId);
          if(['completed','finalize_failed'].includes(saved.status)){
            await notifyOwner(saved,saved.minutesStatus==='failed'?'議事録の生成に失敗しました。/waigaya minutes で文字起こしを確認・再生成できます。':'議事録の下書きができました。/waigaya minutes で確認・Markdown保存できます。本文は自動公開していません。');return;
          }
          await new Promise(resolve=>{const timer=setTimeout(resolve,2000);timer.unref();});
        }
      })().catch(()=>console.error('議事録の完了案内を確認できませんでした。/waigaya minutes で状態を確認できます。'));
  }
  async function finish(current=meeting,{reason='manual',abort=false}={}){
    if(!current)return;
    if(current.finishing)return current.finishing;
    current.closing=true;current.facilitator.close();current.grace.close();current.playback.close();
    current.finishing=(async()=>{
      client.off(Events.VoiceStateUpdate,current.onVoiceState);
      await drain(current,{abort});current.connection.destroy();
      current.closed=true;await current.bridge.close();
      const state=await service.api(`/api/sessions/${current.bridge.state.id}/finish`,{reason});
      if(meeting===current)meeting=null;
      announceMinutes(state.id);
      return state;
    })();
    return current.finishing.finally(()=>{if(current.closed&&meeting===current)meeting=null;});
  }
  async function start(channel,topic,{sessionId,mode='minutes',ownerId,outputChannelId=null,noticeAt}={}){
    if(meeting||starting)throw new Error('別の会議を処理中です。/waigaya status で確認してください。');
    starting=true;let bridge,connection,playback,current;
    try{
      bridge=bridgeFactory(config.server,{serviceToken:config.serviceToken});
      await bridge.open(topic,{sessionId,mode,discord:{guildId:channel.guild.id,voiceChannelId:channel.id,ownerId,outputChannelId,recordingNoticeSentAt:noticeAt,participantIds:[...channel.members.values()].filter(m=>!m.user.bot).map(m=>m.id)}});
      connection=join({guildId:channel.guild.id,channelId:channel.id,adapterCreator:channel.guild.voiceAdapterCreator,selfDeaf:false,selfMute:false});
      await ready(connection,VoiceConnectionStatus.Ready,20000);
      current={bridge,connection,channel,channelId:channel.id,captures:new Map(),sttFailures:new Map(),blockedUntil:new Map(),activeSpeakers:new Set(),transcriptions:new Set(),acceptAudio:true,closing:false,closed:false};
      playback=new DiscordPlayback(bridge,{onFailure:()=>{void fault(current,'tts');console.error('AI音声の再生に失敗しました。文字起こしは継続します。');}});
      current.playback=playback;meeting=current;connection.subscribe(playback.player);
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
          stt=transcribe({speaker,startedAt,emit:u=>{if(!current.closed){current.sttFailures.delete(userId);current.blockedUntil.delete(userId);if(bridge.state.health.stt==='failed')void bridge.enqueue({type:'health',kind:'stt',healthy:true}).catch(()=>{});void bridge.enqueue({type:'utterance',utterance:u}).catch(()=>{});}},
            onUsage:usage=>{if(!current.closed)void bridge.enqueue({type:'audio_usage',usage}).catch(()=>{});},
            onClose:()=>current.transcriptions.delete(stt),onError:()=>failed('stt')});
          current.transcriptions.add(stt);current.captures.set(userId,{opus,decoder,stt,activity});opus.pipe(decoder);
          decoder.on('data',buffer=>{if(!current.acceptAudio)return;try{activity.write(buffer);stt.write(buffer);}catch{failed('stt');}});
          decoder.on('end',()=>{activity.end();current.captures.delete(userId);stt.end();});
          opus.on('error',()=>failed('stt'));decoder.on('error',()=>failed('stt'));
        }catch{failed('stt');}
      };
      connection.receiver.speaking.on('start',capture);
      current.facilitator=new AutonomousFacilitator(bridge,{available:()=>current.acceptAudio&&!current.asking&&playback.epoch===null&&humanCount(channel)>0,onFailure:()=>console.error('自律検討に失敗しました。文字起こしは継続します。')});current.facilitator.start();
      current.grace=new EmptyGrace({
        onEmpty:async()=>{if(!['recording','paused'].includes(current.bridge.state.status))return;current.acceptAudio=false;current.playback.stop(true);await bridge.api(bridge.path+'/events',{type:'lifecycle',action:'empty'});await notifyOwner(bridge.state,'通話の参加者が0人です。新しい音声は記録していません。3分以内に戻れば同じ会議を続けます。');},
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
            void notifyOwner({...bridge.state,ownerId:next.id},'この通話では会議の記録を管理しています。/waigaya status で記録中・一時停止を確認できます。記録中の音声はOpenAIへ送り、文字起こし・議事録はホストへ保存します。元音声は保存しません。');
          }
        }
      };
      client.on(Events.VoiceStateUpdate,current.onVoiceState);await current.grace.members(humanCount(channel));return current;
    }catch{
      current?.grace?.close();current?.facilitator?.close();playback?.close();connection?.destroy();await bridge?.close().catch(()=>{});
      if(bridge?.state?.id)await service.api(bridge.path+'/events',{type:'lifecycle',action:'pause'}).catch(()=>{});
      if(meeting===current)meeting=null;
      throw new Error('通話に接続できません。記録は停止しました。権限・接続を確認し /resume を使ってください。');
    }finally{starting=false;}
  }
  async function begin(interaction,channel,topic,mode,outputChannelId){
    if(!Object.hasOwn(modes,mode))throw new Error('表示された会議モードから選んでください。');
    if(!channel||channel.type!==ChannelType.GuildVoice)throw new Error('通常のボイスチャンネルに入ってから開始してください。');
    if(meeting||starting)throw new Error('会議を処理中です。/waigaya status を使ってください。');
    const permissions=channel.permissionsFor(interaction.member);
    if(!permissions?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.Connect]))throw new Error('会議のチャンネルを閲覧・接続する権限が必要です。');
    if(outputChannelId)requireOutput(await interaction.guild.channels.fetch(outputChannelId),interaction.member,interaction.guild.members.me);
    const notice = `記録を開始します。モード：${modes[mode]}。音声はOpenAIへ送信、文字起こし・下書きはホストに保存。元音声は保存しません。公開先：${outputChannelId?`<#${outputChannelId}>（人が確認・公開操作するまで本文投稿なし）`:'未指定・本文の自動公開なし'}。`;
    await channel.send(safe(notice));
    await interaction.editReply(safe(notice));
    const result=await start(channel,topic,{mode,ownerId:interaction.user.id,outputChannelId,noticeAt:Date.now()});
    await interaction.editReply(safe(`記録中：${modes[mode]}。${mode==='minutes'?'AI音声は常にOFFです。':''}/pause は記録を一時停止、/quiet はAIだけ停止、/finish は会議を終了して議事録を作ります。`));return result;
  }
  async function preview(interaction,state){
    const base=`/api/sessions/${state.id}`;
    const attachments=[];
    if(state.minutesHistory.at(-1))attachments.push(new AttachmentBuilder(Buffer.from(minutesMarkdown(state)),{name:`minutes-v${state.minutesVersion}.md`}),new AttachmentBuilder(Buffer.from(JSON.stringify(state.minutesHistory.at(-1).document,null,2)),{name:`minutes-v${state.minutesVersion}.json`}));
    const bridge=bridgeFactory(config.server,{serviceToken:config.serviceToken});bridge.state=state;
    try{attachments.push(new AttachmentBuilder(Buffer.from(await bridge.artifact('transcript.md')),{name:'transcript.md'}));}catch{await service.api(base+'/events',{type:'health',kind:'file_export',healthy:false}).catch(()=>{});}
    await interaction.editReply({...safe(`会議：${state.topic}\n状態：${statusLabels[state.status]||'状態確認が必要'}／議事録：${minutesLabels[state.minutesStatus]||'未作成'} 版${state.minutesVersion}\n${state.lastError||''}\nファイルは本人だけに表示します。確認済み操作は議事録の確認であり、決定候補を合意として確定する操作ではありません。`),files:attachments,components:minutesControls(state)});
  }
  client.on(Events.InteractionCreate,async interaction=>{
    const supported=interaction.isChatInputCommand?.()||interaction.isAutocomplete?.()||interaction.isButton?.()||interaction.isStringSelectMenu?.()||interaction.isModalSubmit?.();
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
      if(interaction.isStringSelectMenu?.()&&interaction.customId.startsWith('wg:start:')){
        const id=interaction.customId.split(':')[2],request=starts.get(id);
        if(!request||request.ownerId!==interaction.user.id||request.expiresAt<Date.now()||request.channelId!==channel?.id)throw new Error('開始の選択が失効しました。同じ通話で /start を使ってください。');
        starts.delete(id);await interaction.deferUpdate();await begin(interaction,channel,request.topic,interaction.values[0],request.outputChannelId);return;
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
        const sessionId=interaction.customId.split(':')[2],state=await stateFor(sessionId);await access(state,interaction);
        if(state.revision!==Number(interaction.customId.split(':')[3]))throw new Error('原発言が更新されました。/minutes から開き直してください。');
        const [indexString,offsetString]=interaction.values[0].split(':'),u=state.utterances.filter(u=>u.final)[Number(indexString)],offset=Number(offsetString);
        if(!u||!Number.isInteger(offset)||offset<0||offset>=u.text.length)throw new Error('訂正対象が更新されました。/minutes から開き直してください。');
        const id=confirmations.issue('edit',state,interaction.user.id);editorForms.set(id,{kind:'transcript',userId:interaction.user.id,sessionId,utteranceId:u.id,revision:u.revision,offset,end:Math.min(offset+4000,u.text.length),expiresAt:Date.now()+60000});
        const modal=new ModalBuilder().setCustomId(`wg:editform:${id}`).setTitle('原発言を訂正');modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('text').setLabel('原発言の本文（該当部分のみ）').setStyle(TextInputStyle.Paragraph).setMaxLength(4000).setRequired(true).setValue(u.text.slice(offset,offset+4000))));await interaction.showModal(modal);return;
      }
      if(interaction.isStringSelectMenu?.()&&interaction.customId.startsWith('wg:item:')){
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
          if(intent.operation==='publish'){
            if(state.minutesVersion!==intent.version)throw new Error('共有対象の版が変わりました。/publish で確認し直してください。');
            const version=state.minutesHistory.at(-1);
            if(!version?.approvedAt||minutesStale(state,version))throw new Error('最新の議事録を /minutes で確認済みにしてください。');
            const output=await interaction.guild.channels.fetch(state.outputChannelId);requireOutput(output,interaction.member,interaction.guild.members.me);
            const path=`/api/sessions/${state.id}/minutes`;
            const result=await publisher.publish({state,channelId:output.id,reserve:()=>service.api(path,{action:'publication_reserve',version:version.version,channelId:output.id,actorId:interaction.user.id}),
              send:()=>output.send({...safe(`議事録：${state.topic}（版${version.version}・操作担当者が確認）`),files:[new AttachmentBuilder(Buffer.from(minutesMarkdown(state)),{name:`minutes-v${version.version}.md`})]}),
              onFailure:()=>service.api(`/api/sessions/${state.id}/events`,{type:'health',kind:'discord_post',healthy:false}),
              commit:messageId=>service.api(path,{action:'publication',version:version.version,channelId:output.id,messageId,actorId:interaction.user.id})});
            await interaction.editReply({...safe(result.duplicate?'この版は共有済みか送信結果の確認待ちです。二重投稿しません。':`指定先 <#${output.id}> に共有しました。`),components:[]});return;
          }
        }
        const state=await stateFor(id);await access(state,interaction);
        if(Number(versionString)!==state.minutesVersion)throw new Error('議事録の版が変わりました。/minutes を使ってください。');
        if(['transcript','rawpage'].includes(operation)){
          const {StringSelectMenuBuilder}=await import('discord.js');const options=[];
          state.utterances.filter(u=>u.final).forEach((u,index)=>{for(let offset=0;offset<u.text.length;offset+=4000)options.push({label:`${u.speaker||'発言'}: ${u.text.slice(offset,offset+65)}`.slice(0,100),value:`${index}:${offset}`});});
          if(!options.length)throw new Error('確定した原発言がありません。');
          const page=operation==='rawpage'?Number(interaction.customId.split(':')[4]):0;
          if(!Number.isInteger(page)||page<0||page*25>=options.length)throw new Error('表示が失効しました。/minutes を使ってください。');
          const {ButtonBuilder,ButtonStyle}=await import('discord.js');const controls=[new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`wg:rawitem:${id}:${state.revision}`).addOptions(options.slice(page*25,(page+1)*25)))];
          const navigation=[];if(page>0)navigation.push(new ButtonBuilder().setCustomId(`wg:rawpage:${id}:${state.minutesVersion}:${page-1}`).setLabel('前の発言').setStyle(ButtonStyle.Secondary));if((page+1)*25<options.length)navigation.push(new ButtonBuilder().setCustomId(`wg:rawpage:${id}:${state.minutesVersion}:${page+1}`).setLabel('次の発言').setStyle(ButtonStyle.Secondary));if(navigation.length)controls.push(new ActionRowBuilder().addComponents(navigation));
          await interaction.reply({...safe('訂正する原発言を選んでください。訂正履歴を残し、関連する議事録は要再確認にします。'),flags:MessageFlags.Ephemeral,components:controls});return;
        }
        if(operation==='approve'){
          await interaction.deferUpdate();const updated=await service.api(`/api/sessions/${id}/minutes`,{action:'approve',version:Number(versionString),actorId:interaction.user.id});await preview(interaction,updated);return;
        }
        if(operation==='edit'){
          const {StringSelectMenuBuilder}=await import('discord.js');const options=[];
          for(const [section,items] of Object.entries(state.minutesHistory.at(-1).document))items.forEach((item,index)=>options.push({label:item.text.slice(0,90),value:`${section}:${index}`}));
          if(!options.length)throw new Error('訂正する項目がありません。');
          await interaction.reply({...safe('訂正する項目を選んでください。最初の25件を表示します。根拠の訂正は原発言の修正・再生成を使います。'),flags:MessageFlags.Ephemeral,components:[new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`wg:item:${id}:${state.minutesVersion}`).addOptions(options.slice(0,25)))]});return;
        }
        throw new Error('旧候補は使えません。/waigaya ask を使ってください。');
      }
      const action=interaction.options.getSubcommand();
      if(action==='help'){await interaction.reply({...safe(help(interaction.options.getString('detail')==='developer')),flags:MessageFlags.Ephemeral});return;}
      if(action==='start'){
        if(!channel)throw new Error('通話に入ってから /start を使ってください。');
        const topic=interaction.options.getString('topic')||`Discord：${channel.name}`,mode=interaction.options.getString('mode'),outputChannelId=interaction.options.getChannel('output_channel')?.id||null;
        if(!mode){
          const id=confirmations.issue('start',{id:channel.id},interaction.user.id);starts.set(id,{ownerId:interaction.user.id,channelId:channel.id,topic,outputChannelId,expiresAt:Date.now()+60000});
          await interaction.reply({...safe('モードを選んで開始してください。「議事録のみ」はAI音声なしです。選択するまでは記録しません。'),flags:MessageFlags.Ephemeral,components:chooseMode(id)});return;
        }
        await interaction.deferReply();await begin(interaction,channel,topic,mode,outputChannelId);return;
      }
      await interaction.deferReply({flags:MessageFlags.Ephemeral});
      const state=await resolveMeeting(interaction);await access(state,interaction,{live:!['minutes','publish','status'].includes(action)});
      if(action==='minutes'){
        if(interaction.options.getString('action')==='retry'){await service.api(`/api/sessions/${state.id}/minutes`,{action:'retry'});await interaction.editReply(safe('議事録を再生成しています。元の文字起こしは保持しています。/minutes で確認してください。'));}
        else await preview(interaction,state);return;
      }
      if(action==='publish'){
        if(!state.outputChannelId)throw new Error('公開先が未指定です。本文は公開しません。開始時に output_channel を指定してください。');
        const version=state.minutesHistory.at(-1);
        if(!version?.approvedAt||minutesStale(state,version))throw new Error('/minutes で最新の議事録を確認済みにしてから共有してください。');
        const output=await interaction.guild.channels.fetch(state.outputChannelId);requireOutput(output,interaction.member,interaction.guild.members.me);
        const id=confirmations.issue('publish',state,interaction.user.id);await interaction.editReply({...safe(`版${version.version}の本文を <#${output.id}> を閲覧できる人へ共有します。公開先を確認してください（60秒で失効）。`),components:confirmation(id,'この公開先へ共有する')});return;
      }
      if(action==='status'){
        await interaction.editReply(safe(`会議：${state.topic}\n記録：${statusLabels[state.status]||'状態確認が必要'}／モード：${modes[state.mode]}／AI音声：${canSpeak(state)?'利用可':'OFF'}\n経過：約${state.startedAt?Math.floor(((state.endedAt||Date.now())-state.startedAt)/60000):0}分\n保存：ホストSQLite（${state.health.storage==='failed'?'直近の保存を確認できません':'最新保存確認済み'}）／議事録：${minutesLabels[state.minutesStatus]||'未作成'}\n新しい音声の外部送信：${state.status==='recording'?'記録する発話をOpenAIへ送信':'停止'}\n公開先：${state.outputChannelId?`<#${state.outputChannelId}>`:'未指定'}\n${state.lastError||''}\n障害：${Object.entries(state.health).filter(([,v])=>v==='failed').map(([k])=>healthLabels[k]||'状態確認が必要').join('、')||'検出なし'}`));return;
      }
      if(action==='resume'&&!meeting){
        if(state.status!=='paused')throw new Error('再開可能な一時停止会議がありません。/start で新しく始めてください。');
        const vc=await access(state,interaction,{live:true});await interaction.editReply(safe('同じ会議の記録を明示的に再開します。音声をOpenAIへ送り、ホストに保存します。'));
        await vc.send(safe(`会議の記録を再開します。モード：${modes[state.mode]}。音声をOpenAIへ送り、ホストへ保存します。本文の自動公開はしません。`));await start(vc,undefined,{sessionId:state.id});await interaction.editReply(safe('同じ会議IDで記録を再開しました。'));return;
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
  client.once(Events.ClientReady,async()=>{
    try { for(const saved of await list()){ if(['recording','empty_grace','created'].includes(saved.status)){ await service.api(`/api/sessions/${saved.id}/events`,{type:'lifecycle',action:'pause'}); await service.api(`/api/sessions/${saved.id}/events`,{type:'health',kind:'connection',healthy:false,gap:{startedAt:null,endedAt:Date.now()}}); } } } catch { console.error('前回会議の復旧状態を確認できません。新規開始前に会議サーバーを確認してください。'); }
    console.log('Discord Botを起動しました。起動だけでは記録しません。/start または /resume を使ってください。');
  });
  const quit=()=>void (async()=>{if(meeting){const current=meeting;current.closing=true;current.grace.close();current.facilitator.close();current.playback.close();await drain(current);await current.bridge.api(current.bridge.path+'/events',{type:'lifecycle',action:'pause'});current.closed=true;await current.bridge.close();current.connection.destroy();}client.destroy();})().finally(()=>process.exit(0));
  process.once('SIGINT',quit);process.once('SIGTERM',quit);
  try{await client.login(config.token);}catch{client.destroy();throw new Error('Discordへログインできません。トークンと接続を確認してください。');}
  return {client,get meeting(){return meeting;},close:async()=>{process.off('SIGINT',quit);process.off('SIGTERM',quit);if(meeting)await finish(meeting);client.destroy();}};
}
if(process.argv[1]?.endsWith('/discord/bot.js'))runBot().catch(()=>{console.error('Discord Botを起動できません。discord-setup.mdに従って設定してください。');process.exitCode=1;});
