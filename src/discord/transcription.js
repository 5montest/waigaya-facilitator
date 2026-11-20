import { connectStt } from '../openai-audio.js';
import { Downsample } from './audio.js';

// Keep one connection across Discord's short AfterSilence streams. Audio offsets
// exclude silence, so map each turn back to its actual wall-clock start.
export function transcribeSpeaker({speaker,startedAt=Date.now(),emit,onError,onUsage,onClose=()=>{},connect=connectStt}){
  let convert=new Downsample(),ready=false,ended=false,aborted=false,settled=false,cancelled=false,queued=[],bytes=0,resolveClosed,frames=0,turn=null;
  const spans=[];
  const closed=new Promise(resolve=>{resolveClosed=resolve;});
  const finish=()=>{if(settled)return;settled=true;queued=[];bytes=0;resolveClosed();onClose();};
  const failed=e=>{if(aborted||settled)return;aborted=true;try{onError(e);}finally{finish();}};
  const at=(ms,end=false)=>{if(ms==null)return null;const span=spans.findLast(s=>end?ms>s.offset:ms>=s.offset)||spans[0];return span?span.wall+ms-span.offset:startedAt+ms;};
  const dispatch=operation=>{if(aborted)return;if(ready){try{operation();}catch(e){failed(e);stt.abort();}}else queued.push(operation);};
  const stt=connect({model:'gpt-transcribe',prompt:'日本語の技術会議。固有名詞：ワイガヤ、我ヶ谷。',emit:u=>{if(!aborted&&!settled)emit({...u,speaker,source:'discord',startMs:at(u.startMs),endMs:at(u.endMs,true)});},onUsage,onError:failed,onClose:()=>{if(!ended&&!aborted&&!settled)failed(new Error('音声認識の接続が予期せず終了しました。'));else finish();},
    onReady:()=>{if(aborted)return;ready=true;const operations=queued;queued=[];bytes=0;try{for(const op of operations)op();}catch(e){failed(e);stt.abort();}},
  });
  function beginTurn(wall=Date.now()){
    if(ended||aborted||turn)return;
    convert=new Downsample();turn={offset:frames/24,wall};spans.push(turn);dispatch(()=>stt.voice(true));
  }
  function write(chunk){
    if(ended||aborted)return;if(!turn)beginTurn();
    const pcm=convert.convert(chunk);if(!pcm.length)return;
    if(!ready){bytes+=pcm.length;if(bytes>48000*15)throw new Error('文字起こしへの送信準備が追いついていません。');}
    // Align the adapter with connectStt's 12-second automatic commits. A
    // trailing fragment then receives its own >=100ms commit, not the next turn.
    let offset=0;
    while(offset<pcm.length){
      const turnBytes=Math.round((frames/24-turn.offset)*48);
      const length=Math.min(pcm.length-offset,576000-turnBytes%576000);
      const part=pcm.subarray(offset,offset+length);frames+=length/2;offset+=length;
      dispatch(()=>stt.send(part));
    }
  }
  function endTurn(){
    if(!turn||ended||aborted)return;
    // Manual commits require >=100ms. Pad only an actual, shorter audio turn.
    const length=(frames/24-turn.offset)%12000;
    if(length>0&&length<100){const padding=Buffer.alloc(Math.round((100-length)*48));frames+=padding.length/2;dispatch(()=>stt.send(padding));}
    turn=null;dispatch(()=>stt.voice(false));
  }
  beginTurn(startedAt);
  return {closed,createdAt:startedAt,beginTurn,endTurn,write,
    end(){if(ended||aborted)return;endTurn();ended=true;dispatch(()=>stt.end());},
    abort(){if(cancelled)return;cancelled=true;aborted=true;try{stt.abort();}finally{finish();}},
  };
}
