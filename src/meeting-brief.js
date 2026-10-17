import { UserError } from './errors.js';

// Only explicit, addressed scope instructions change the meeting brief.
// Keep the user's own wording, including axes and exclusions, without inferred agreement.
export function briefCommand(question) {
  const text=String(question).normalize('NFKC').trim();
  if(/^(?:脱線|本筋から外れた)(?:したら|ら|ときは|時は)[、,\s]*(?:声をかけて|教えて|知らせて|指摘して)[。.!！]*$/.test(text))return {operation:'watch_on'};
  if(/^(?:脱線の(?:声かけ|声掛け|通知|指摘)|本筋への(?:声かけ|声掛け))を(?:止めて|やめて|停止して)[。.!！]*$/.test(text))return {operation:'watch_off'};
  if(/^(?:(?:今日|今回|会議|この会議)の)?(?:目的|本筋|大筋)(?:を(?:教えて|確認して|読み上げて)|は(?:何|なに|どうなってる|どうなっていますか))[。.?？!！]*$/.test(text))return {operation:'read'};
  const match=text.match(/^(?:(?:今日|今回|会議|この会議)の)?(?:目的|本筋|大筋)(?:は|を[、,\s]*)[、,\s]*(.+)$/s);
  if(!match)return null;
  let value=match[1].trim();
  if(/^(?:何|なに|どう|どれ|教えて|確認して|読み上げて)/.test(value)||/[?？]$/.test(value))return null;
  if(/^(?:変更して|設定して|記録して|教えて|確認して)[。.!！]*$/.test(value))return null;
  value=value.replace(/(?:に(?:設定して|設定してください|変更して|変更してください|して|してください)|として(?:記録して|覚えておいて|設定して))[。.!！]*$/,'').trim();
  if(!value||value.length>1000)return null;
  return {operation:'set',text:value};
}

export const currentBrief=state=>state.meetingBrief&&!state.meetingBrief.needsReview?state.meetingBrief:null;
export const automaticSpeechAllowed=state=>state.mode!=='minutes'&&!state.quiet&&(!state.guildId||state.status==='recording')&&
  (state.mode==='facilitator'&&state.autonomous||state.focusGuard===true&&Boolean(currentBrief(state)));

export function updateBrief(controller,{operation,text,actorId,evidence=null}) {
  const s=controller.state;
  if(!['created','recording','paused'].includes(s.status))throw new UserError('会議中だけ本筋を設定できます。');
  if(operation==='read')return;
  if(operation==='set') {
    if(typeof text!=='string'||!text.trim()||text.length>1000)throw new UserError('本筋は1〜1,000文字で指定してください。');
    if(evidence&&!s.utterances.some(u=>u.final&&u.source==='discord'&&u.id===evidence.utteranceId&&u.revision===evidence.revision&&u.userId===actorId))throw new UserError('本筋を指定した確定発言が更新されています。');
    // Repeated delivery of one voice command cannot restore an obsolete brief.
    if(evidence&&s.briefHistory.some(b=>b.evidence?.utteranceId===evidence.utteranceId&&b.evidence.revision===evidence.revision))return;
    controller.invalidate({reason:'brief_changed'});
    s.meetingBrief={text:text.trim(),revision:++s.briefRevision,updatedBy:actorId,updatedAt:controller.clock(),evidence,needsReview:false};
    s.briefHistory.push(structuredClone(s.meetingBrief));
  } else if(['watch_on','watch_off'].includes(operation)) {
    if(operation==='watch_on'&&!currentBrief(s))throw new UserError('先に「ワイガヤ、今日の目的は…」と本筋を指定してください。');
    if(s.focusGuard===(operation==='watch_on'))return;
    controller.invalidate({reason:'focus_guard_changed'});s.focusGuard=operation==='watch_on';
  } else throw new UserError('本筋の操作を確認してください。');
}

export function briefAcknowledgement(state,operation) {
  if(operation==='watch_on')return !state.focusGuard?'脱線の声かけは現在停止しています。':state.mode==='minutes'?'脱線通知を設定しましたが、議事録専用モードでは音声発言しません。':state.quiet?'脱線通知を設定しましたが、AI音声は停止中です。':'本筋から外れた話が続いたときだけ、短く声をかけます。';
  if(operation==='watch_off')return '脱線の声かけを止めました。記録は続け、音声回答の設定は変えません。';
  const brief=currentBrief(state);
  if(!brief)return state.meetingBrief?.needsReview?'本筋を伝えた発言が訂正されています。もう一度、本筋を指定してください。':'まだ本筋が設定されていません。「今日の目的は」と続けて教えてください。';
  let text='';for(const c of brief.text){if(text.length+c.length>170)break;text+=c;}
  return (operation==='set'?'本筋を記録しました。':'現在の本筋は、')+text+(text!==brief.text?'。詳細は会議の記録に残しています。':'');
}
