import { automaticPublicationAllowed,unresolved } from '../publication.js';
import { minutesStale } from '../minutes.js';
// Durable state is in SQLite through the meeting API; this worker never joins voice.
export class FixedCompletionWorker {
  constructor({service,client,policy,publisher,notify,hasActiveSession=()=>false,clock=Date.now,intervalMs=2000}) {Object.assign(this,{service,client,policy,publisher,notify,hasActiveSession,clock,intervalMs});this.closed=false;}
  start(){this.timer=setInterval(()=>void this.tick().catch(()=>{}),this.intervalMs);this.timer.unref();void this.tick().catch(()=>{});}
  close(){this.closed=true;clearInterval(this.timer);}
  async tick(){if(this.closed)return;if(this.running)return this.running;this.running=this.scan().finally(()=>{this.running=null;});return this.running;}
  async scan(){
    const guild=await this.client.guilds.fetch(this.policy.guildId);
    const listed=await this.service.api('/api/sessions?guildId='+this.policy.guildId);
    for(const row of listed){
      if(this.closed)return;
      if(!row.fixedOperation)continue;
      try{await this.process(await this.service.api('/api/sessions/'+row.id),guild);}catch{
        // API/storage failure is retried without guessing whether a Discord send succeeded.
      }
    }
  }
  async process(state,guild){
    const path='/api/sessions/'+state.id,api=body=>this.service.api(path+'/minutes',body),job=body=>api({action:'completion',job:body});
    if(state.voiceChannelId!==this.policy.voiceChannelId||state.outputChannelId!==this.policy.minutesForumId||!state.fixedOperation)return;
    if(state.status==='recording'&&!this.hasActiveSession(state.id)){await this.service.api(path+'/events',{type:'lifecycle',action:'pause'});return;}
    if(['empty_grace','paused'].includes(state.status)&&!this.hasActiveSession(state.id)){
      const vc=await guild.channels.fetch(this.policy.voiceChannelId),humans=[...vc.members.values()].filter(m=>!m.user.bot).length;
      if(humans>0){if(state.status==='empty_grace'){await this.service.api(path+'/events',{type:'lifecycle',action:'returned',forcePaused:true});}return;}
      if(state.status==='paused'){await this.service.api(path+'/events',{type:'lifecycle',action:'empty'});return;}
      if(this.clock()-state.emptySince<(state.autoFinishAfterMs||this.policy.emptyGraceMs))return;
      // Only a recovered session has no active Bot connection to drain.
      if(this.hasActiveSession(state.id))return;
      await this.service.api(path+'/finish',{reason:'empty_timeout_recovered'});return;
    }
    if(!state.completionJob||!['finalizing','finalize_failed','completed'].includes(state.status))return;
    const version=state.minutesHistory.at(-1),existing=state.publications.find(p=>p.version===version?.version&&p.channelId===this.policy.minutesForumId);
    if(existing?.status==='published') {if(state.completionJob.status!=='completed')await job({status:'completed',phase:'published',version:version.version});return;}
    if(state.publications.some(unresolved)){
      if(state.completionJob.status!=='needs_reconciliation'){await job({status:'needs_reconciliation',phase:'publication',errorCategory:'delivery_unknown'});await this.notify(state,`会議ID：${state.id}\n障害：Discord送信結果要照合。原本と議事録を保持しています。管理者が /waigaya reconcile で照合してください。`);}return;
    }
    if(['failed','skipped_empty','completed'].includes(state.completionJob.status))return;
    if(state.completionJob.nextAttemptAt>this.clock())return;
    if(state.minutesStatus==='failed'&&state.completionJob.generationAttempts>=2){await job({status:'failed',phase:'generation',errorCategory:'minutes_generation'});await this.notify(state,`会議ID：${state.id}\n障害：議事録生成。原本は保持しています。管理者が /waigaya minutes から再生成してください。`);return;}
    if(state.status==='finalize_failed'||state.status==='finalizing'&&state.minutesStatus!=='generating'||state.completionJob.phase==='regeneration'||state.status==='finalizing'&&!state.completionJob.generationAttempts){
      await job({status:'pending',phase:'generation',generationAttempts:(state.completionJob.generationAttempts||0)+1});
      await api({action:'retry'});return;
    }
    if(state.status!=='completed'||state.minutesStatus==='generating')return;
    const count=state.utterances.filter(u=>u.final&&u.source!=='ai').length;
    if(!count){const broken=state.gaps?.some(g=>g.kind==='stt'||g.kind==='connection')||state.health.stt==='failed';await job({status:broken?'failed':'skipped_empty',phase:'empty',errorCategory:broken?'recording_missing':null});await this.notify(state,`会議ID：${state.id}\n${broken?'障害：音声記録の欠損。正常な議事録として投稿しません。':'無発言のため終了のみ記録し、フォーラム投稿は省略しました。'}`);return;}
    if(version?.kind!=='minutes'||minutesStale(state,version)){await job({status:'pending',phase:'regeneration'});return;}
    if(!automaticPublicationAllowed(state)){await job({status:'completed',phase:'private'});return;}
    if(state.health.storage==='failed')return;
    let channel;const bot=guild.members.me;
    try{
      channel=await guild.channels.fetch(this.policy.minutesForumId);
      if(!channel)throw new Error('destination_missing');
      await this.publisher.publish({state,channel,actor:bot,bot,api});await job({status:'completed',phase:'published',version:version.version});
    }catch{
      const latest=await this.service.api(path),p=latest.publications.find(p=>p.version===version.version&&p.channelId===this.policy.minutesForumId);
      if(p&&unresolved(p)){await job({status:'needs_reconciliation',phase:'publication',errorCategory:'delivery_unknown'});await this.notify(state,`会議ID：${state.id}\n障害：Discord送信結果要照合。管理者が /waigaya reconcile で照合してください。`);return;}
      const attempts=(state.completionJob.publicationAttempts||0)+1;
      await job({status:attempts>=3?'failed':'pending',phase:'publication',publicationAttempts:attempts,nextAttemptAt:this.clock()+30000,errorCategory:'discord_rejected'});
      if(attempts===1||attempts===3)await this.notify(state,`会議ID：${state.id}\n障害：Discord投稿（権限・タグ・容量・接続）。原本と議事録は保持しています。Botは退出済みです。`);
    }
  }
}
