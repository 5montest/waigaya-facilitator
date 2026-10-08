import { EventEmitter } from 'node:events';
import { once } from 'node:events';
import WebSocket from 'ws';

export class MeetingBridge extends EventEmitter {
  constructor(base,{fetchImpl=fetch}={}){super();this.base=base;this.fetch=fetchImpl;this.state=null;this.queue=Promise.resolve();this.closing=false;}
  async api(path,body){
    const response=await this.fetch(this.base+path,{headers:{origin:this.base,'content-type':'application/json'},method:body===undefined?'GET':'POST',...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(10000)});
    const data=await response.json();if(!response.ok)throw new Error(data.error||'会議サーバーに接続できません。');return data;
  }
  get path(){return `/api/sessions/${this.state.id}`;}
  async open(topic,{sessionId}={}){
    this.config=await this.api('/api/config');if(!this.config.audio.configured)throw new Error('会議サーバーのOpenAIキーが未設定です。');
    if(sessionId){
      if(!/^[0-9a-f-]{36}$/.test(sessionId))throw new Error('再開する会議IDが不正です。');
      this.state=await this.api('/api/sessions/'+sessionId);
    }else{
      this.state=await this.api('/api/sessions',{});
      this.state=await this.api(this.path+'/events',{type:'configure',topic,phase:'organize',autonomous:true});
    }
    this.ws=new WebSocket(this.base.replace('http','ws')+'/live?session='+this.state.id,{origin:this.base,handshakeTimeout:10000});
    this.ws.on('error',()=>this.emit('failure','会議サーバーとの音声接続が切れました。'));
    this.ws.on('close',()=>{clearInterval(this.heartbeat);if(!this.closing)this.emit('failure','会議サーバーとの音声接続が切れました。');});
    this.ws.on('message',raw=>{
      try{const event=JSON.parse(raw);if(event.type==='state'){if((event.state.sequence??0)>=(this.state.sequence??0))this.state=event.state;this.emit('state',this.state);}else if(event.type==='error')this.emit('failure',event.error);else if(event.type==='action_error')this.emit('action_error',event);else this.emit('audio',event);}
      catch{this.emit('failure','会議サーバーの応答を処理できません。');}
    });
    await Promise.race([once(this.ws,'open'),new Promise((_,reject)=>{const t=setTimeout(()=>reject(new Error('会議サーバーへの接続がタイムアウトしました。')),10000);t.unref();})]);
    this.send({type:'mic_start',transcribe:false});
    await this.waitFor(s=>s.inputHealthy,10000);
    this.heartbeat=setInterval(()=>this.send({type:'heartbeat'}),500);this.heartbeat.unref();return this.state;
  }
  send(event){if(this.ws?.readyState===WebSocket.OPEN)this.ws.send(JSON.stringify(event));}
  waitFor(predicate,timeout=30000,{signal}={}){
    if(predicate(this.state))return Promise.resolve(this.state);
    return new Promise((resolve,reject)=>{
      const done=state=>{if(predicate(state)){clean();resolve(state);}},fail=message=>{clean();reject(new Error(message));};
      const timer=setTimeout(()=>fail('会議サーバーの応答が時間内に届きませんでした。'),timeout);
      const poll=setInterval(()=>done(this.state),100);
      const cancelled=()=>fail('待機を取り消しました。');
      const clean=()=>{clearTimeout(timer);clearInterval(poll);this.off('state',done);this.off('failure',fail);signal?.removeEventListener('abort',cancelled);};this.on('state',done);this.on('failure',fail);signal?.addEventListener('abort',cancelled,{once:true});if(signal?.aborted)cancelled();
    });
  }
  enqueue(event){
    const work=this.queue.then(()=>this.api(this.path+'/events',event));
    this.queue=work.catch(()=>{});work.catch(()=>this.emit('failure','文字起こし・使用量を会議へ保存できません。'));return work;
  }
  async ask({automatic=false,signal}={}){
    await this.queue;
    if(signal?.aborted)throw new Error('検討を取り消しました。');
    const response=await this.api(this.path+'/analyze',{provider:'openai',model:this.config.defaultModel,mode:'reply',...(automatic?{trigger:'auto'}:{})});
    const state=await this.waitFor(s=>s.request?.id!==response.request.id||s.request.status!=='thinking',35000,{signal});
    if(state.request?.id!==response.request.id)throw new Error('新しい依頼に切り替わりました。');
    return state;
  }
  async speakReply(requestId,{quietMs=1000,signal}={}){
    const deadline=Date.now()+60000;
    while(Date.now()<deadline){
      const state=await this.waitFor(s=>s.request?.id!==requestId||!s.reply||!s.inputHealthy||(!s.speaking&&Date.now()-s.lastVoiceAt>=quietMs),Math.max(1,deadline-Date.now()),{signal});
      if(state.request?.id!==requestId||state.reply?.requestId!==requestId||!state.inputHealthy)throw new Error('返答が取り消し・失効しました。もう一度 /waigaya ask を使ってください。');
      let rejectAction;
      const action=new Promise((_,reject)=>{rejectAction=event=>{const e=new Error(event.error);e.code=event.code;reject(e);};this.once('action_error',rejectAction);});
      const abort=new AbortController();
      const started=this.waitFor(s=>Boolean(s.playback)||!s.reply||s.request?.id!==requestId,10000,{signal:signal?AbortSignal.any([signal,abort.signal]):abort.signal});
      this.send({type:'speak_reply',requestId});
      try{
        const next=await Promise.race([started,action]);
        if(!next.playback)throw new Error('返答が取り消し・失効しました。もう一度 /waigaya ask を使ってください。');
        return next;
      }catch(e){if(e.code!=='busy')throw e;}
      finally{abort.abort();this.off('action_error',rejectAction);}
    }
    throw new Error('会話が続いているため、返答の待ち時間を超えました。');
  }
  async close(){this.closing=true;clearInterval(this.heartbeat);this.send({type:'stop'});this.send({type:'mic_stop'});await this.queue;this.ws?.close();}
}
