import { connectStt } from '../openai-audio.js';
import { Downsample } from './audio.js';

export function transcribeSpeaker({speaker,startedAt=Date.now(),emit,onError,onUsage,onClose=()=>{},connect=connectStt}){
  const convert=new Downsample();let ready=false,ended=false,aborted=false,settled=false,cancelled=false,queued=[],bytes=0,resolveClosed;
  const closed=new Promise(resolve=>{resolveClosed=resolve;});
  const finish=()=>{if(settled)return;settled=true;queued=[];bytes=0;resolveClosed();onClose();};
  const failed=e=>{if(aborted||settled)return;aborted=true;try{onError(e);}finally{finish();}};
  const stt=connect({model:'gpt-transcribe',prompt:'日本語の技術会議。記録係の名前はワイガヤ（我ヶ谷）。呼びかけ例：ワイガヤ、今の話をまとめて。',emit:u=>{if(!aborted&&!settled)emit({...u,speaker,source:'discord',startMs:u.startMs==null?null:startedAt+u.startMs,endMs:u.endMs==null?null:startedAt+u.endMs});},onUsage,onError:failed,onClose:()=>{if(!ended&&!aborted&&!settled)failed(new Error('音声認識の接続が予期せず終了しました。'));else finish();},
    onReady:()=>{if(aborted)return;ready=true;stt.voice(true);for(const b of queued)stt.send(b);queued=[];bytes=0;if(ended){stt.voice(false);stt.end();}},
  });
  return {
    closed,
    write(chunk){if(ended||aborted)return;const pcm=convert.convert(chunk);if(!pcm.length)return;if(ready)stt.send(pcm);else{bytes+=pcm.length;if(bytes>48000*15)throw new Error('文字起こしへの送信準備が追いついていません。');queued.push(pcm);}},
    end(){if(ended||aborted)return;ended=true;if(ready){stt.voice(false);stt.end();}},
    abort(){if(cancelled)return;cancelled=true;aborted=true;try{stt.abort();}finally{finish();}},
  };
}
