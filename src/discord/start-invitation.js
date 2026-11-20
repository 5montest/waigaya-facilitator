import { randomUUID } from 'node:crypto';

// One invitation per gathering. Reset only after fewer than two humans remain
// for five minutes. Buttons expire and are single-use, including concurrent clicks.
export class StartInvitation {
  constructor({channel,busy,forumId,autoPublish=true,clock=Date.now}){Object.assign(this,{channel,busy,forumId,autoPublish,clock});this.offered=false;this.emptyAt=null;this.pending=null;this.running=false;this.closed=false;}
  async tick(){
    if(this.closed||this.running)return;this.running=true;
    try{
      const now=this.clock(),channel=await this.channel(),count=[...channel.members.values()].filter(m=>!m.user.bot).length;
      if(count<2){this.emptyAt??=now;if(now-this.emptyAt>=300000){await this.invalidate();this.offered=false;}return;}
      this.emptyAt=null;
      if(await this.busy()){this.offered=true;await this.invalidate();return;}
      if(this.pending&&now>=this.pending.expires)await this.invalidate();
      if(this.offered)return;
      const token=randomUUID();this.offered=true;
      try{
        const message=await channel.send({content:`2人以上が参加しています。ワイガヤで議事録を作りますか？\nボタンを押すとBotが入室して記録します（AI音声なし）。音声は外部AIへ送信し、原音声は保存せず文字起こしを保持します。${this.autoPublish?`終了後、<#${this.forumId}> の閲覧者へAI生成・未確認の議事録を自動公開します。`:'議事録は非公開保存します。'}\n開始しない場合は操作不要です。ボタンは10分で失効します。`,allowedMentions:{parse:[]},components:[{type:1,components:[{type:2,style:1,label:'議事録のみで開始',custom_id:`wg:invite:${token}`}]}]});
        this.pending={token,message,expires:now+600000};
      }catch{throw new Error('invite_send_failed');}
    }finally{this.running=false;}
  }
  async take(token,userId){
    if(this.closed)return false;
    const channel=await this.channel();
    if(!channel.members.get(userId)||channel.members.get(userId).user.bot||[...channel.members.values()].filter(m=>!m.user.bot).length<2)return false;
    if(!this.pending||this.pending.token!==token||this.clock()>=this.pending.expires||await this.busy())return false;
    // Recheck after asynchronous busy(): another click may already have consumed it.
    if(!this.pending||this.pending.token!==token)return false;
    await this.invalidate();return true;
  }
  async invalidate(){const pending=this.pending;this.pending=null;if(pending?.message?.edit)await pending.message.edit({components:[]}).catch(()=>{});}
  close(){this.closed=true;clearInterval(this.timer);void this.invalidate();}
  start(){this.timer=setInterval(()=>void this.tick().catch(()=>console.error('会議開始の案内を送信できませんでした。/waigaya start は利用できます。')),60000);this.timer.unref();}
}
