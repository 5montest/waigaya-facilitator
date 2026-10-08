import { connectStt } from '../openai-audio.js';
import { Downsample } from './audio.js';

export function transcribeSpeaker({speaker,startedAt=Date.now(),emit,onError,onUsage,onClose=()=>{},connect=connectStt}){
  const convert=new Downsample();let ready=false,ended=false,aborted=false,queued=[],bytes=0,resolveClosed;
  const closed=new Promise(resolve=>{resolveClosed=resolve;});
  const stt=connect({model:'gpt-transcribe',emit:u=>{if(!aborted)emit({...u,speaker,source:'discord',startMs:u.startMs==null?null:startedAt+u.startMs,endMs:u.endMs==null?null:startedAt+u.endMs});},onUsage,onError:e=>{aborted=true;onError(e);},onClose:()=>{resolveClosed();onClose();},
    onReady:()=>{if(aborted)return;ready=true;stt.voice(true);for(const b of queued)stt.send(b);queued=[];bytes=0;if(ended){stt.voice(false);stt.end();}},
  });
  return {
    closed,
    write(chunk){if(ended||aborted)return;const pcm=convert.convert(chunk);if(!pcm.length)return;if(ready)stt.send(pcm);else{bytes+=pcm.length;if(bytes>48000*15)throw new Error('文字起こしへの送信準備が追いついていません。');queued.push(pcm);}},
    end(){if(ended||aborted)return;ended=true;if(ready){stt.voice(false);stt.end();}},
    abort(){aborted=true;queued=[];stt.abort();resolveClosed();onClose();},
  };
}
