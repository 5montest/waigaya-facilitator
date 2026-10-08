import { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, StringSelectMenuBuilder } from 'discord.js';
import { modes, canSpeak } from '../meeting.js';
const modeOption = o => o.setName('mode').setDescription('AIの関わり方（省略時は議事録のみ）').addChoices(...Object.entries(modes).map(([value,name])=>({name,value})));
const meetingOption = o => o.setName('meeting').setDescription('最近の会議から選ぶ（省略時は現在・直近）').setAutocomplete(true);
export const command = new SlashCommandBuilder().setName('waigaya').setDescription('会議を記録し、議事録を作ります')
  .addSubcommand(s => s.setName('start').setDescription('会議を開始。省略時は議事録のみ・AI音声なし').addStringOption(o=>o.setName('topic').setDescription('会議名・議題').setMaxLength(160)).addStringOption(modeOption).addChannelOption(o=>o.setName('output_channel').setDescription('確認後に共有する先（省略時は非公開）').addChannelTypes(ChannelType.GuildText)))
  .addSubcommand(s=>s.setName('status').setDescription('記録状態・モード・保存状態を確認'))
  .addSubcommand(s=>s.setName('mode').setDescription('記録を続けたままAIの関わり方を変更').addStringOption(o=>modeOption(o).setRequired(true)))
  .addSubcommand(s=>s.setName('ask').setDescription('AIに整理を頼む。議事録のみでは文字回答').addBooleanOption(o=>o.setName('voice').setDescription('明示的に音声回答を依頼（議事録のみでは無効）')))
  .addSubcommand(s=>s.setName('summary').setDescription('会議を続けたまま、ここまでの要約を文字で取得'))
  .addSubcommand(s=>s.setName('quiet').setDescription('AIの音声だけ止める。文字起こしは継続'))
  .addSubcommand(s=>s.setName('pause').setDescription('記録を一時停止。新しい音声をAIへ送らない'))
  .addSubcommand(s=>s.setName('resume').setDescription('明示的に記録を再開。新しい発言から記録'))
  .addSubcommand(s=>s.setName('finish').setDescription('確認後に会議を終了し、議事録の下書きを生成'))
  .addSubcommand(s=>s.setName('minutes').setDescription('現在・過去の議事録を非公開で確認・保存').addStringOption(meetingOption).addStringOption(o=>o.setName('action').setDescription('操作（省略時は閲覧）').addChoices({name:'閲覧・保存',value:'view'},{name:'再生成',value:'retry'})))
  .addSubcommand(s=>s.setName('publish').setDescription('確認済み議事録を、指定した公開先へ共有').addStringOption(meetingOption))
  .addSubcommand(s=>s.setName('help').setDescription('使い方と記録・公開範囲を確認').addStringOption(o=>o.setName('detail').setDescription('ヘルプの種類').addChoices({name:'使い方',value:'user'},{name:'開発・運用',value:'developer'})))
  .addSubcommand(s=>s.setName('stop').setDescription('旧操作：AI音声・自律発言を停止。記録は継続'))
  .addSubcommand(s=>s.setName('auto').setDescription('旧操作：自律発言の切替。新操作はmode').addBooleanOption(o=>o.setName('enabled').setDescription('trueでAIワイガヤ、falseでAI音声停止').setRequired(true)))
  .addSubcommand(s=>s.setName('leave').setDescription('旧操作：会議を終了。確認後に議事録を生成')).toJSON();
export function proposal(state, { voice = true } = {}) {
  if (state.reply) {
    const r=state.reply, spoken = voice && canSpeak(state);
    return { content:r.action==='hold'?`今回の返答：${r.reason}`:`${r.text}\n\n${spoken?'通話全員へ音声で返答します。人の発話終了を待ちます。':'文字回答のみです。音声は再生しません。'}依頼時点までの会話に基づく回答です。会話が進んだ場合は再依頼してください。`, components:[], allowedMentions:{parse:[]} };
  }
  const c=state.candidate;
  if(!c)return { content:state.request?.status==='failed'?`AIの回答だけに失敗しました。${state.error||'再依頼してください。'}`:state.request?.status==='ready'?'いまは発言を見送ります。':'候補の前提が変わりました。もう一度 /waigaya ask を使えます。',components:[],allowedMentions:{parse:[]} };
  const evidence=c.evidence.slice(0,3).map(r=>state.utterances.find(u=>u.id===r.utteranceId)?.text.slice(0,160)).filter(Boolean).join('\n');
  return { content:`${c.text}\n\n根拠：\n${evidence}`, allowedMentions:{parse:[]}, components:canSpeak(state)?[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`wg:speak:${state.id}:${c.id}`).setLabel('読み上げる').setStyle(ButtonStyle.Primary),new ButtonBuilder().setCustomId(`wg:discard:${state.id}:${c.id}`).setLabel('見送る').setStyle(ButtonStyle.Secondary))]:[] };
}
export function confirmation(id, label) { return [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`wg:confirm:${id}`).setLabel(label).setStyle(ButtonStyle.Danger))]; }
export function minutesControls(state) {
  const version=state.minutesHistory.at(-1); if(!version)return [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`wg:transcript:${state.id}:${state.minutesVersion}`).setLabel('原発言を訂正').setStyle(ButtonStyle.Secondary))];
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`wg:approve:${state.id}:${version.version}`).setLabel('この版を確認済みにする').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`wg:edit:${state.id}:${version.version}`).setLabel('項目を訂正').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`wg:transcript:${state.id}:${version.version}`).setLabel('原発言を訂正').setStyle(ButtonStyle.Secondary))];
}
export function chooseMode(id) { return [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`wg:start:${id}`).setPlaceholder('会議のモードを選んで開始').addOptions(Object.entries(modes).map(([value,label])=>({value,label}))))]; }
export function help(developer = false) {
  return developer ? '運用：Node.jsの会議サーバー→Botの順に起動。再起動後は自動記録せず /resume を使用。原本はSQLite、AI処理はOpenAI、承認後の共有だけDiscordへ送信。設定・失敗分類・保存期限はリポジトリの操作ガイド参照。' :
    '開始：/start → モード選択（省略時は議事録のみ）。\n記録を止める：/pause、再開：/resume。AIだけ黙らせる：/quiet。\n終了：/finish → 確認 → 議事録の下書き。\n確認・Markdown保存：/minutes、訂正・確認済み操作もここから。共有：/publish → 指定先を確認。\n記録：音声はOpenAIへ送信、文字起こし・下書きはホストのSQLiteに保存。元音声は保存しません。全文の自動投稿はしません。\nこの操作画面とファイルは本人だけに表示。AI音声は通話全員、共有投稿は公開先を見られる人に届きます。';
}
