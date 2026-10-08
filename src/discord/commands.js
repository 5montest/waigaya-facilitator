import { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

export const command=new SlashCommandBuilder().setName('waigaya').setDescription('話し合いを記録・整理します')
  .addSubcommand(s=>s.setName('start').setDescription('参加中のボイスチャンネルで記録を始める').addStringOption(o=>o.setName('topic').setDescription('議題（省略可）').setMaxLength(160)))
  .addSubcommand(s=>s.setName('ask').setDescription('会話をもとにAIへ整理を頼む'))
  .addSubcommand(s=>s.setName('stop').setDescription('AIの読み上げを止める'))
  .addSubcommand(s=>s.setName('auto').setDescription('自律発言をオン・オフにする').addBooleanOption(o=>o.setName('enabled').setDescription('オンにする場合はtrue、オフはfalse').setRequired(true)))
  .addSubcommand(s=>s.setName('leave').setDescription('記録を終えて退出する')).toJSON();
export function proposal(state){
  if(state.reply){
    const reply=state.reply;
    return {content:reply.action==='hold'?`今回の返答：${reply.reason}`:`${reply.text}\n\n音声で返答します。人が話している間は待ちます。依頼時点までの会話をもとにした回答です。`,components:[],allowedMentions:{parse:[]}};
  }
  const candidate=state.candidate;
  if(!candidate)return {content:state.request?.status==='failed'?`AIの返答に失敗しました。${state.error||'接続・モデル設定を確認してください。'}`:state.request?.status==='ready'?'いまは発言を見送ります。':'回答の前提が訂正されたか、依頼が取り消されました。もう一度 /waigaya ask で依頼できます。',components:[],allowedMentions:{parse:[]}};
  const evidence=candidate.evidence.slice(0,3).map(ref=>{const u=state.utterances.find(u=>u.id===ref.utteranceId&&u.revision===ref.revision);return u?`${u.speaker||'発言'}：${u.text.slice(0,160)}`:'';}).filter(Boolean).join('\n');
  return {content:`${candidate.text}\n\n根拠：\n${evidence}\n\n読み上げはAIの生成音声です。候補は15秒で失効します。`,allowedMentions:{parse:[]},components:[new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`wg:speak:${state.id}:${candidate.id}`).setLabel('読み上げる').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`wg:discard:${state.id}:${candidate.id}`).setLabel('見送る').setStyle(ButtonStyle.Secondary),
  )]};
}
