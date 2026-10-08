import { PassThrough } from 'node:stream';
import { createAudioPlayer, createAudioResource, StreamType, AudioPlayerStatus, NoSubscriberBehavior } from '@discordjs/voice';
import { upsample } from './audio.js';

export class DiscordPlayback {
  constructor(bridge,{onFailure=()=>{}}={}){
    this.bridge=bridge;this.onFailure=onFailure;this.epoch=null;this.startedAt=null;this.finished=false;this.minimumEpoch=0;this.speaking=false;
    this.player=createAudioPlayer({behaviors:{noSubscriber:NoSubscriberBehavior.Stop}});
    this.player.on(AudioPlayerStatus.Playing,()=>{
      if(this.epoch===null)return;this.startedAt??=Date.now();this.progress();
      clearInterval(this.timer);this.timer=setInterval(()=>this.progress(),300);this.timer.unref();
    });
    this.player.on(AudioPlayerStatus.Idle,()=>{if(this.epoch!==null&&this.finished){this.progress();this.bridge.send({type:'playback_done',epoch:this.epoch});this.stop();}});
    this.player.on('error',()=>{this.stop(true);this.onFailure('Discordへの音声再生に失敗しました。');});
    this.onAudio=event=>this.consume(event);
    this.onState=state=>{if(this.epoch!==null&&state.outputEpoch!==this.epoch)this.stop();};
    bridge.on('audio',this.onAudio);bridge.on('state',this.onState);
  }
  progress(){if(this.epoch!==null&&this.startedAt!==null)this.bridge.send({type:'playback',epoch:this.epoch,heardMs:Date.now()-this.startedAt});}
  consume(event){
    try{
      if(event.type==='tts_start'){
        if(this.speaking||this.bridge.state?.speaking||event.epoch<this.minimumEpoch||this.bridge.state?.playback?.epoch!==event.epoch||this.bridge.state?.outputEpoch!==event.epoch)return;
        this.stop();this.epoch=event.epoch;this.stream=new PassThrough();this.stream.on('error',()=>{});this.totalBytes=0;
        this.player.play(createAudioResource(this.stream,{inputType:StreamType.Raw}));
      }else if(event.type==='tts_chunk'&&event.epoch===this.epoch){
        const pcm=Buffer.from(event.audio,'base64');this.totalBytes+=pcm.length;
        if(event.sampleRate!==24000||this.totalBytes>48000*60)throw new Error('生成音声の形式又は長さが不正です。');
        this.stream.write(upsample(pcm));
      }else if(event.type==='tts_done'&&event.epoch===this.epoch){this.finished=true;this.stream.end();}
    }catch{this.stop(true);this.onFailure('Discordへの音声再生に失敗しました。');}
  }
  stop(notify=false,reason='manual'){
    if(notify){this.minimumEpoch=Math.max(this.minimumEpoch,(this.bridge.state?.outputEpoch??0)+2);this.bridge.send({type:'stop',reason});}
    this.epoch=null;this.startedAt=null;this.finished=false;clearInterval(this.timer);this.stream?.destroy();this.stream=null;this.player.stop(true);
  }
  speech(active){this.speaking=active;if(active)this.stop(true,'human_speaking');}
  close(){this.stop(true);this.bridge.off('audio',this.onAudio);this.bridge.off('state',this.onState);}
}
