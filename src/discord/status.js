import { statusLabels,minutesLabels,healthLabels } from '../meeting.js';
import { publicationLabels } from '../publication.js';
export function fixedStatus(state,now=Date.now()) {
 const version=state.minutesHistory.at(-1),publication=state.publications.findLast(p=>p.version===version?.version&&p.channelId===state.outputChannelId);
 const lines=[`会議：${state.topic}`,`状態：${statusLabels[state.status]||'状態を確認してください'}（約${Math.max(0,Math.floor(((state.endedAt||now)-(state.startedAt||now))/60000))}分）`];
 if(state.meetingBrief)lines.push(`本筋：${state.meetingBrief.text.slice(0,300)}${state.meetingBrief.text.length>300?'…':''}${state.meetingBrief.needsReview?'（原発言が訂正されています。再指定してください）':''}`,`脱線の声かけ：${state.focusGuard&&!state.meetingBrief.needsReview&&state.mode!=='minutes'&&!state.quiet?'有効':'停止'}`);
 if(state.status==='recording')lines.push(state.mode==='minutes'||state.quiet?'AI音声は停止中です。記録は続けています。':state.request?.status==='thinking'?'音声回答を考えています。':state.request?.status==='ready'&&state.reply?.action!=='hold'?'人の発話が終わるのを待っています。':'ワイガヤと呼ぶと音声で答えます。');
 if(state.status==='paused')lines.push('記録を止めています。再開は /waigaya resume。');
 if(state.status==='empty_grace')lines.push('新しい音声は送信していません。3分以内の復帰を待っています。');
 lines.push(`議事録：${minutesLabels[state.minutesStatus]||'未作成'}${version?`／版${version.version}（${version.approvedAt?'人が確認済み':'AI生成・未確認'}）`:''}`);
 if(publication){lines.push(`投稿：${publicationLabels[publication.status]||'確認が必要'}`);if(publication.url)lines.push(`<${publication.url}>`);}
 else if(state.completionJob?.status==='failed')lines.push('自動処理に失敗しました。原本の状態を /waigaya minutes で確認してください。');
 else if(state.completionJob?.status==='skipped_empty')lines.push('発言がないため投稿を省略しました。');
 else lines.push(state.publicationPolicy==='auto_publish_ai_draft'?`終了後、<#${state.outputChannelId}> へ自動投稿します。`:'議事録は非公開保存します。');
 const failures=Object.entries(state.health).filter(([,v])=>v==='failed').map(([k])=>healthLabels[k]||'接続');
 if(failures.length)lines.push(`障害：${failures.join('、')}`);
 if(state.health.storage==='failed')lines.push('直近の記録が保存されたとは確認できません。');
 if(state.lastError)lines.push(state.lastError);
 return lines.join('\n');
}
