import { canSpeak } from '../meeting.js';
const compact=text=>String(text).normalize('NFKC').replace(/[\s、。！？!?…・「」『』"']/g,'').toLowerCase();
export const defaultAddressNames=['ワイガヤ','わいがや','我ヶ谷','我が谷','Yガヤ','yガヤ','ワイダヤ','わいだや'];
export function detectAddress(text,names=defaultAddressNames) {
  if(!names.length)return {addressed:false,reason:'no_names'};
  const value=String(text).normalize('NFKC').trim().replace(/^[「『]/,'');
  const escape=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const namePattern=name=>[...name.normalize('NFKC')].map(c=>{const n=c.codePointAt(0);return n>=0x3041&&n<=0x3096?`[${c}${String.fromCodePoint(n+0x60)}]`:n>=0x30a1&&n<=0x30f6?`[${String.fromCodePoint(n-0x60)}${c}]`:escape(c);}).join('');
  const match=value.match(new RegExp(`^(?:(?:ねえ|ねぇ|おーい|あの)[\\s、,]*)?(${names.slice().sort((a,b)=>b.length-a.length).map(namePattern).join('|')})(?:さん|くん)?(.*)$`,'iu'));
  if(!match)return {addressed:false,reason:'not_initial_address'};
  const tail=match[2];
  const question=tail.replace(/^[\s、,。！？!?：:「『]+/,'').replace(/[」』]$/,'').trim();
  if(/^(?:って|という|と呼|が|を|の|は|さんが)/.test(question))return {addressed:false,alias:match[1],reason:'mention'};
  if(!question)return {addressed:true,alias:match[1],question:'',clarification:true};
  if(!/^[\s、,。！？!?：:]/.test(tail)&&!/^(?:今|いま|これ|それ|さっき|まとめ|教え|どう|どちら|どっち|何|なに|ここ|懸念|お願い|聞い|答え)/.test(question))return {addressed:false,alias:match[1],reason:'ambiguous'};
  return {addressed:true,alias:match[1],question,clarification:false};
}
export function voiceEligible(current,userId) {
  const s=current.bridge.state,member=current.channel.members.get(userId);
  return !current.closing&&!current.closed&&current.acceptAudio&&s.status==='recording'&&canSpeak(s)&&s.inputHealthy&&
    !['stt','storage','connection'].some(k=>s.health?.[k]==='failed')&&Boolean(member&&!member.user.bot);
}
// One executing request plus one replacement. A newer call cancels the old generation/wait.
export class VoiceAddressing {
  constructor(current,{names,onFailure=()=>{},clock=Date.now}={}){Object.assign(this,{current,names,onFailure,clock});this.seen=new Map();this.pending=null;this.closed=false;this.lastClarification=null;this.lastErrorAt=null;}
  observe(utterance,userId){
    if(!utterance.final||utterance.source==='ai'||!voiceEligible(this.current,userId))return;
    const detected=detectAddress(utterance.text,this.names);
    const previous=this.seen.get(utterance.id);
    if(previous?.revision===utterance.revision)return;
    if(previous?.started){if(previous.revision!==utterance.revision&&this.activeRequest?.utteranceId===utterance.id)this.active?.abort();return;}
    const echo=compact(utterance.text);
    if(echo.length>=12&&this.current.bridge.state.aiTurns.some(t=>compact(t.text)===echo))return;
    if(!detected.addressed)return;
    if(detected.clarification&&this.lastClarification!==null&&this.clock()-this.lastClarification<30000)return;
    if(detected.clarification)this.lastClarification=this.clock();
    const request={utteranceId:utterance.id,revision:utterance.revision,userId,question:detected.question,alias:detected.alias,at:this.clock()};
    this.seen.set(utterance.id,{revision:utterance.revision,started:false});
    this.pending=request;this.active?.abort();
    if(!this.running)this.running=this.run().finally(()=>{this.running=null;});
  }
  async run(){
    while(this.pending&&!this.closed){
      const request=this.pending;this.pending=null;
      if(!voiceEligible(this.current,request.userId))continue;
      const abort=new AbortController();this.active=abort;this.activeRequest=request;this.seen.get(request.utteranceId).started=true;
      this.current.voiceAsking=true;
      try{
        if(this.current.bridge.state.request?.status==='thinking'||this.current.bridge.state.reply)await this.current.bridge.api(this.current.bridge.path+'/events',{type:'discard'});
        if(abort.signal.aborted)continue;
        for(let attempt=0;attempt<2;attempt++){
          if(abort.signal.aborted||!voiceEligible(this.current,request.userId))break;
          const canRefresh=()=>{const s=this.current.bridge.state,u=s.utterances?.find(u=>u.id===request.utteranceId);return attempt===0&&!abort.signal.aborted&&!this.pending&&voiceEligible(this.current,request.userId)&&s.request?.status==='needs_refresh'&&s.request.invalidatedBy==='new_utterance'&&u?.revision===request.revision;};
          const answer=await this.current.bridge.ask({voiceRequest:request,signal:abort.signal});
          if(canRefresh())continue;
          if(abort.signal.aborted||!voiceEligible(this.current,request.userId))break;
          if(answer.request?.status==='failed')throw new Error('voice_generation_failed');
          if(answer.reply?.action!=='hold'&&answer.reply){try{await this.current.bridge.speakReply(answer.reply.requestId,{signal:abort.signal});}catch(e){if(canRefresh())continue;throw e;}}
          break;
        }
      }catch{
        const s=this.current.bridge.state;
        if(!abort.signal.aborted&&voiceEligible(this.current,request.userId)&&!['needs_refresh','dismissed'].includes(s.request?.status)&& (this.lastErrorAt===null||this.clock()-this.lastErrorAt>=60000)){
          this.lastErrorAt=this.clock();await this.onFailure().catch(()=>{});
        }
      }finally{this.current.voiceAsking=false;if(this.active===abort){this.active=null;this.activeRequest=null;}}
    }
  }
  cancel(){this.pending=null;this.active?.abort();}
  close(){this.closed=true;this.cancel();}
}
