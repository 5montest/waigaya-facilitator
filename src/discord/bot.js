import { Client, GatewayIntentBits, Events, MessageFlags, ChannelType } from 'discord.js';
import { joinVoiceChannel, entersState, VoiceConnectionStatus, EndBehaviorType } from '@discordjs/voice';
import prism from 'prism-media';
import { discordConfig } from './config.js';
import { MeetingBridge } from './bridge.js';
import { DiscordPlayback } from './playback.js';
import { transcribeSpeaker } from './transcription.js';
import { proposal } from './commands.js';
import { loadOpenAIKey } from '../credentials.js';
import { VoiceActivity } from './audio.js';
import { AutonomousFacilitator } from './autonomy.js';

export async function runBot(){
  const config=discordConfig();if(!loadOpenAIKey().configured)throw new Error('OpenAIキーを設定してください。');
  const client=new Client({intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildVoiceStates]});
  let meeting=null,starting=false;
  async function leave({abort=false}={}){
    const current=meeting;if(!current)return;meeting=null;current.closing=true;
    current.facilitator?.close();
    client.off(Events.VoiceStateUpdate,current.onVoiceState);
    for(const item of current.captures.values()){item.activity.end();item.opus.unpipe(item.decoder);item.opus.destroy();item.decoder.end();if(abort)item.stt.abort();else item.stt.end();}
    current.bridge.send({type:'vad',active:false});
    current.playback.close();current.connection.destroy();
    let drainTimer;
    if(!abort)try{await Promise.race([Promise.all([...current.transcriptions].map(stt=>stt.closed)),new Promise(resolve=>{drainTimer=setTimeout(resolve,13000);})]);}finally{clearTimeout(drainTimer);}
    for(const stt of current.transcriptions)stt.abort();
    current.closed=true;await current.bridge.close();
  }
  async function start(channel,topic,{sessionId}={}){
    if(meeting||starting)throw new Error('記録中です。終了する場合は /waigaya leave を使ってください。');
    starting=true;let bridge,connection,playback;
    try{
      bridge=new MeetingBridge(config.server);await bridge.open(topic,{sessionId});
      connection=joinVoiceChannel({guildId:channel.guild.id,channelId:channel.id,adapterCreator:channel.guild.voiceAdapterCreator,selfDeaf:false,selfMute:false});
      await entersState(connection,VoiceConnectionStatus.Ready,20000);
      playback=new DiscordPlayback(bridge,{onFailure:message=>{console.error(message);void leave({abort:true}).catch(()=>{});}});connection.subscribe(playback.player);
      const current={bridge,connection,playback,channelId:channel.id,captures:new Map(),activeSpeakers:new Set(),transcriptions:new Set(),closing:false};meeting=current;
      bridge.on('failure',message=>{console.error(message);void leave({abort:true}).catch(()=>{});});
      connection.on('error',()=>{console.error('Discord音声接続に失敗しました。');void leave().catch(()=>{});});
      connection.on(VoiceConnectionStatus.Disconnected,()=>{console.error('Discord音声接続が切れたため記録を終了します。');void leave().catch(()=>{});});
      current.onVoiceState=(old,next)=>{if(meeting===current&&next.id===client.user.id&&next.channelId!==current.channelId)void leave().catch(()=>{});};
      client.on(Events.VoiceStateUpdate,current.onVoiceState);
      const capture=userId=>{
        if(meeting!==current||current.closing||current.captures.has(userId)||userId===client.user.id)return;
        const member=channel.members.get(userId);if(!member||member.user.bot)return;
        const activity=new VoiceActivity(active=>{
          if(meeting!==current||current.closing)return;
          if(active){current.activeSpeakers.add(userId);playback.speech(true);bridge.send({type:'vad',active:true});}
          else{current.activeSpeakers.delete(userId);if(current.activeSpeakers.size===0){playback.speech(false);bridge.send({type:'vad',active:false});}}
        });
        const startedAt=Date.now(),speaker=`${member.displayName.slice(0,50)} (${userId})`;
        const opus=connection.receiver.subscribe(userId,{end:{behavior:EndBehaviorType.AfterSilence,duration:500}});
        const decoder=new prism.opus.Decoder({rate:48000,channels:2,frameSize:960});
        let stt;
        try{
          stt=transcribeSpeaker({speaker,startedAt,
            emit:u=>{if(!current.closed)void bridge.enqueue({type:'utterance',utterance:u}).catch(()=>{});},
            // 中断後に届く使用量も、その会議へ残す。音声の再生・発言の復活とは分ける。
            onUsage:usage=>{void bridge.enqueue({type:'audio_usage',usage}).catch(()=>{});},
            onClose:()=>current.transcriptions.delete(stt),
            onError:()=>{console.error('Discord音声の文字起こしに失敗しました。');void leave().catch(()=>{});},
          });
          current.transcriptions.add(stt);current.captures.set(userId,{opus,decoder,stt,activity});
          opus.pipe(decoder);
          decoder.on('data',buffer=>{try{activity.write(buffer);stt.write(buffer);}catch{console.error('Discord音声の送信が追いつきません。');void leave().catch(()=>{});}});
          decoder.on('end',()=>{activity.end();current.captures.delete(userId);stt.end();});
          let failedOnce=false;
          const failed=source=>()=>{
            if(failedOnce||current.closing)return;failedOnce=true;
            if(Date.now()-(current.lastReceiveErrorAt||0)>2000){console.error(source==='opus'?'Discord音声パケットの受信に失敗しました。音声を再購読します。':'DiscordのOpus復号に失敗しました。音声を再購読します。');current.lastReceiveErrorAt=Date.now();}
            activity.end();opus.unpipe(decoder);opus.destroy();decoder.destroy();stt.abort();current.captures.delete(userId);
            // 暗号化の切り替え中に一つの受信ストリームが切れても、会議全体を終了しない。
            const retry=setTimeout(()=>{if(meeting===current&&!current.closing&&connection.receiver.speaking.users.has(userId))capture(userId);},100);retry.unref();
          };
          opus.on('error',failed('opus'));decoder.on('error',failed('decoder'));
        }catch{opus.destroy();decoder.destroy();console.error('Discord音声の文字起こしを開始できません。');void leave().catch(()=>{});}
      };
      connection.receiver.speaking.on('start',capture);
      current.facilitator=new AutonomousFacilitator(bridge,{available:()=>!current.asking&&playback.epoch===null&&channel.members.some(member=>!member.user.bot),onFailure:()=>console.error('自律的な検討・返答を完了できませんでした。会議の記録は継続します。')});
      current.facilitator.start();
      return current;
    }catch{playback?.close();connection?.destroy();await bridge?.close().catch(()=>{});throw new Error('ボイスチャンネルに接続できません。権限・音声暗号化・会議サーバーを確認してください。');}
    finally{starting=false;}
  }
  client.on(Events.InteractionCreate,async interaction=>{
    if(!interaction.isChatInputCommand()&&!interaction.isButton())return;
    if(interaction.isChatInputCommand()&&interaction.commandName!=='waigaya')return;
    if(interaction.isButton()&&!interaction.customId.startsWith('wg:'))return;
    try{
      if(interaction.guildId!==config.guildId)throw new Error('指定されたサーバーで利用してください。');
      const channel=interaction.guild?.voiceStates.cache.get(interaction.user.id)?.channel;
      if(!channel||channel.type!==ChannelType.GuildVoice)throw new Error('通常のボイスチャンネルに参加してから操作してください。');
      if(meeting&&meeting.channelId!==channel.id)throw new Error('Botと同じボイスチャンネルで操作してください。');
      if(interaction.isButton()){
        const [,operation,sessionId,candidateId]=interaction.customId.split(':');
        if(!meeting||sessionId!==meeting.bridge.state.id||candidateId!==meeting.bridge.state.candidate?.id)throw new Error('提案が更新・失効しました。もう一度 /waigaya ask を使ってください。');
        if(operation==='speak'){
          meeting.bridge.send({type:'speak',candidateId});
          await interaction.update({content:'読み上げを依頼しました。人が話している場合や、提案が失効した場合は読み上げません。',components:[],allowedMentions:{parse:[]}});
        }else if(operation==='discard'){
          await meeting.bridge.api(meeting.bridge.path+'/events',{type:'discard'});await interaction.update({content:'見送りました。',components:[]});
        }
        return;
      }
      const action=interaction.options.getSubcommand();
      if(action==='start'){
        // 参加者にも記録開始と送信先を見える形で知らせてから受信を始める。
        await interaction.deferReply();
        await interaction.editReply({content:'このボイスチャンネルの記録を開始します。参加者の音声をOpenAIへ送り、文字起こしを会議サーバーへ保存します。AIは会話の区切りで、必要な時に短く発言します。',allowedMentions:{parse:[]}});
        const result=await start(channel,interaction.options.getString('topic')||`Discord：${channel.name}`);
        await interaction.editReply({content:`記録・自律進行中です。AIは会話の区切りで発言します。/waigaya stop で自律発言を止め、/waigaya leave で終了できます。会議ID：${result.bridge.state.id}`,allowedMentions:{parse:[]}});
      }else{
        await interaction.deferReply({flags:MessageFlags.Ephemeral});
        if(!meeting)throw new Error('/waigaya start で記録を始めてください。');
        if(action==='ask'){
          const current=meeting;
          if(current.asking)throw new Error('回答を準備しています。人の発話が終わったら音声で返答するので、そのままお待ちください。');
          current.asking=true;
          try{
            const state=await current.bridge.ask();
            await interaction.editReply(proposal(state));
            if(state.reply&&state.reply.action!=='hold')await current.bridge.speakReply(state.reply.requestId);
          }finally{current.asking=false;}
        }
        else if(action==='stop'){await meeting.bridge.api(meeting.bridge.path+'/events',{type:'configure',autonomous:false});meeting.playback.stop(true);await interaction.editReply('読み上げと自律発言を停止しました。記録は続けます。再開は /waigaya auto enabled:true です。');}
        else if(action==='auto'){const enabled=interaction.options.getBoolean('enabled');await meeting.bridge.api(meeting.bridge.path+'/events',{type:'configure',autonomous:enabled});if(!enabled)meeting.playback.stop(true);await interaction.editReply(enabled?'自律発言を再開しました。会話の区切りで、必要な時に発言します。':'自律発言を停止しました。記録は続けます。');}
        else if(action==='leave'){await leave();await interaction.editReply('記録を終了して退出しました。記録は会議サーバーに残っています。');}
      }
    }catch(e){
      const content=e.message?.includes('token')?'Discordの設定を確認してください。':e.message||'操作に失敗しました。';
      try{if(interaction.deferred||interaction.replied)await interaction.editReply({content,components:[],allowedMentions:{parse:[]}});else await interaction.reply({content,flags:MessageFlags.Ephemeral,allowedMentions:{parse:[]}});}catch{console.error('Discordへの操作結果を送れませんでした。');}
    }
  });
  client.on('error',()=>console.error('Discordへの接続でエラーが発生しました。'));
  client.once(Events.ClientReady,async()=>{
    console.log('Discord Botを起動しました。/waigaya start で参加します。');
    if(process.env.WAIGAYA_DISCORD_RESUME_SESSION){
      try{
        const channel=await client.channels.fetch(process.env.WAIGAYA_DISCORD_RESUME_CHANNEL);
        if(channel?.guildId!==config.guildId||channel.type!==ChannelType.GuildVoice)throw new Error('再開先が不正です。');
        await start(channel,undefined,{sessionId:process.env.WAIGAYA_DISCORD_RESUME_SESSION});
        console.log('既存のDiscord会議へ再接続して記録を再開しました。');
      }catch{console.error('既存の会議を再開できません。/waigaya start で開始してください。');}
    }
  });
  const quit=()=>void leave().finally(()=>{client.destroy();process.exit(0);});process.once('SIGINT',quit);process.once('SIGTERM',quit);
  try{await client.login(config.token);}catch{client.destroy();throw new Error('Discordへログインできません。Botトークンと接続を確認してください。');}
}
if(process.argv[1]?.endsWith('/discord/bot.js'))runBot().catch(()=>{console.error('Discord Botを起動できません。discord-setup.mdに従って設定してください。');process.exitCode=1;});
