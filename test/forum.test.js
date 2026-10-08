import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType,Collection,PermissionFlagsBits,ChannelFlagsBitField } from 'discord.js';
import { Controller } from '../src/controller.js';
import { emptyMinutes,minutesMarkdown } from '../src/minutes.js';
import { approveVersion,applyPublication,changeDestination,normalizePublications,publicationState } from '../src/publication.js';
import { DiscordMinutesPublisher,splitAttachments,forumTitle,resolveTags,requireThread,shortMinutes,marker } from '../src/discord/minutes-publication.js';
import { inspectPublication,verifyMessageLink,requireAdministrator } from '../src/discord/reconcile.js';
import { requireOutput } from '../src/discord/access.js';
const guildId='123456789012345678',channelId='223456789012345678',ownerId='323456789012345678',threadId='423456789012345678',botId='523456789012345678';
const all={has:()=>true},actor={id:ownerId},bot={id:botId};
function fixture({type=ChannelType.GuildForum,approved=true}={}) {
 const state=new Controller({guildId,voiceChannelId:'623456789012345678',ownerId,outputChannelId:channelId,status:'completed',topic:'ロボット開発 @everyone'}).state;
 state.utterances=[{id:'u',revision:1,text:'配線図の試行を提案しました。',final:true,source:'discord'}];
 const document=emptyMinutes();document.overview=[{text:'配線図の案を検討。 <@&123456789012345678> **強調**',evidence:[{utteranceId:'u',revision:1}]}];
 const version={version:1,kind:'minutes',document,metadata:{topic:state.topic,startedAt:Date.UTC(2026,9,8,17),endedAt:Date.UTC(2026,9,8,18),participantNames:['A']},confirmedDecisions:[],transcriptRefs:[{utteranceId:'u',revision:1}],approvedAt:null};state.minutesHistory=[version];state.minutesVersion=1;if(approved)approveVersion(state,version,ownerId);
 const sent=[],created=[],messages=new Collection();let next=723456789012345678n;
 const channel={id:channelId,type,availableTags:[],flags:new ChannelFlagsBitField(),permissionsFor:m=>m===actor?{has:bits=>(Array.isArray(bits)?bits:[bits]).every(b=>b===PermissionFlagsBits.ViewChannel)}:all};
 const thread={id:threadId,parentId:channelId,ownerId:botId,archived:false,locked:false,permissionsFor:()=>all,messages:{fetch:async()=>messages},send:async payload=>{sent.push(payload);return{id:String(next++),url:'https://discord.com/channels/'+guildId+'/'+threadId+'/'+String(next-1n)};},setArchived:async value=>{thread.archived=value;}};
 channel.guild={channels:{fetch:async id=>id===threadId?thread:null}};
 channel.threads={create:async payload=>{created.push(payload);return thread;},fetchActive:async()=>({threads:new Collection([[threadId,thread]])}),fetchArchived:async()=>({threads:new Collection(),hasMore:false})};
 channel.messages={fetch:async()=>messages};channel.send=async payload=>{sent.push(payload);return{id:String(next++),url:'https://discord.com/channels/'+guildId+'/'+channelId+'/'+String(next-1n)};};
 const api=async body=>{applyPublication(state,body);return structuredClone(state);};
 return {state,version,channel,thread,sent,created,messages,api};
}
const send=(r,publisher=new DiscordMinutesPublisher())=>publisher.publish({state:r.state,channel:r.channel,actor,bot,api:r.api});
test('フォーラムは確認済みMarkdownと短い本文を1回だけ作り、版2は同じ投稿へ追記する',async()=>{
 const r=fixture(),publisher=new DiscordMinutesPublisher();const original=r.version.approvedMarkdown;
 await Promise.all([send(r,publisher),send(r,publisher)]);assert.equal(r.created.length,1);assert.equal(r.created[0].name,'2026-10-09｜ロボット開発 ＠everyone');assert.equal(r.created[0].message.files[0].name,'minutes-v1.md');assert.equal(r.created[0].message.files[0].attachment.toString(),original);assert.deepEqual(r.created[0].message.allowedMentions,{parse:[]});assert.ok(!r.created[0].message.content.includes('@everyone'));assert.ok(!r.created[0].message.content.includes('<@&'));
 const version={...structuredClone(r.version),version:2,approvedAt:null,approvedMarkdown:null};r.state.minutesHistory.push(version);r.state.minutesVersion=2;approveVersion(r.state,version,ownerId);await send(r,publisher);
 assert.equal(r.created.length,1);assert.equal(r.sent.length,1);assert.equal(r.sent[0].files[0].name,'minutes-v2.md');assert.equal(r.state.publications[1].threadId,threadId);assert.equal(r.state.minutesHistory[0].approvedMarkdown,original);assert.match(r.state.publications[1].url,/discord.com\/channels/);
});
test('テキスト保存先は操作者に閲覧だけを要求し、旧設定と同じ親チャンネルに投稿する',async()=>{
 const r=fixture({type:ChannelType.GuildText});await send(r);assert.equal(r.created.length,0);assert.equal(r.sent.length,1);assert.equal(r.state.publications[0].destinationType,'text');assert.equal(publicationState(r.state),'published');requireOutput(r.channel,actor,bot);
 assert.throws(()=>requireOutput({...r.channel,type:ChannelType.GuildVoice},actor,bot));assert.throws(()=>requireOutput({...r.channel,permissionsFor:()=>({has:()=>false})},actor,bot));
});
test('途中要約は承認・投稿できず、未承認下書きを送信しない',async()=>{
 const r=fixture({approved:false});await assert.rejects(()=>send(r));assert.equal(r.created.length,0);r.version.kind='summary';assert.throws(()=>approveVersion(r.state,r.version,ownerId),/途中要約/);await assert.rejects(()=>send(r),/途中要約/);assert.equal(r.state.publications.length,0);
});
test('必須タグは適用可能な既存タグのみ使い、設定は勝手に変更しない',()=>{
 const r=fixture();assert.deepEqual(resolveTags(r.channel,bot),[]);r.channel.flags.add(ChannelFlagsBitField.Flags.RequireTag);assert.throws(()=>resolveTags(r.channel,bot),/必須タグ/);
 r.channel.availableTags=[{id:'tag1',name:'議事録',moderated:false},{id:'tag2',name:'確認済み',moderated:false}];assert.equal(resolveTags(r.channel,bot).length,2);
 r.channel.permissionsFor=()=>({has:()=>false});r.channel.availableTags=[{id:'tag3',name:'管理用',moderated:true}];assert.throws(()=>resolveTags(r.channel,bot));
});
test('アーカイブは権限下で再開し、ロック・削除・スレッド送信権限不足では別投稿を作らない',async()=>{
 const r=fixture();await send(r);const v={...r.version,version:2,approvedAt:null,approvedMarkdown:null};r.state.minutesHistory.push(v);r.state.minutesVersion=2;approveVersion(r.state,v,ownerId);
 r.thread.archived=true;await send(r);assert.equal(r.thread.archived,false);assert.equal(r.created.length,1);
 assert.throws(()=>requireThread({...r.thread,locked:true,permissionsFor:()=>({has:b=>b!==PermissionFlagsBits.ManageThreads})},actor,bot,channelId),/ロック/);
 assert.throws(()=>requireThread(null,actor,bot,channelId),/削除/);assert.throws(()=>requireThread({...r.thread,permissionsFor:()=>({has:()=>false})},actor,bot,channelId));
});
test('大きい添付はUTF-8境界で分割して全バイトを保ち、上限超過は投稿前に失敗する',()=>{
 const text='議事録の本文。'.repeat(100),parts=splitAttachments(text,'minutes-v1.md',256);assert.deepEqual(Buffer.concat(parts.map(p=>p.attachment)),Buffer.from(text));assert.ok(parts.every(p=>p.attachment.length<=256));assert.ok(parts.every(p=>!p.attachment.toString().includes('\ufffd')));
 assert.throws(()=>splitAttachments(text.repeat(100),'minutes-v1.md',256),/容量/);const r=fixture();r.version.document.overview[0].text='x'.repeat(6000);assert.ok(shortMinutes(r.state,r.version).length<1800);assert.ok(forumTitle({...r.state,topic:'x'.repeat(200)},{metadata:{topic:'x'.repeat(200)}}).length<=100);
});
test('Discordが未送信と明確に拒否した場合だけ再試行し、タイムアウトは結果不明として保持する',async()=>{
 const r=fixture();r.channel.threads.create=async()=>{const e=new Error('private upstream text');e.status=403;throw e;};await assert.rejects(()=>send(r),/受け付けません/);assert.equal(r.state.publications[0].status,'failed_confirmed');assert.ok(r.version.approvedAt);
 r.channel.threads.create=async()=>{throw new Error('timeout secret');};await assert.rejects(()=>send(r),/結果が不明/);assert.equal(r.state.publications[0].status,'needs_reconciliation');await assert.rejects(()=>send(r),/照合/);assert.equal(r.state.publications[0].attempts.length,1);
});
test('投稿成功後に結果保存が失敗すると照合待ちとなり、再起動しても自動再送しない',async()=>{
 const r=fixture(),api=r.api;r.api=async body=>{if(body.action==='publication')throw new Error('DB sensitive');return api(body);};await assert.rejects(()=>send(r),/送信は完了.*保存/);assert.equal(r.created.length,1);assert.equal(r.state.publications[0].status,'needs_reconciliation');await assert.rejects(()=>send(r),/照合/);assert.equal(r.created.length,1);
});
test('同じ会議・版のBot自身の投稿を照合して、既存スレッドへ復旧する',async()=>{
 const r=fixture();applyPublication(r.state,{action:'publication_reserve',version:1,channelId,destinationType:'forum',actorId:ownerId});const p=r.state.publications[0];p.status='needs_reconciliation';
 const message={id:threadId,author:{id:botId},content:marker(r.state,r.version,p),createdTimestamp:Date.now(),url:`https://discord.com/channels/${guildId}/${threadId}/${threadId}`};r.messages.set(message.id,message);
 const result=await inspectPublication({state:r.state,publication:p,channel:r.channel,bot});assert.equal(result.matches.length,1);assert.equal(result.complete,true);applyPublication(r.state,{action:'publication_link',version:1,channelId,reservationId:p.reservationId,...result.matches[0]});assert.equal(p.status,'published');assert.equal(p.threadId,threadId);
});
test('未投稿の完全照合・10分待機・管理者確認なしに再試行を許可しない',()=>{
 const r=fixture();applyPublication(r.state,{action:'publication_reserve',version:1,channelId,destinationType:'forum',actorId:ownerId},1000);const p=r.state.publications[0];p.status='needs_reconciliation';
 const body={version:1,channelId,reservationId:p.reservationId,actorId:ownerId};assert.throws(()=>applyPublication(r.state,{...body,action:'publication_absence',complete:true},1001));assert.throws(()=>applyPublication(r.state,{...body,action:'publication_retry'},700000));
 applyPublication(r.state,{...body,action:'publication_absence',complete:true},700000);const token=p.absenceToken;assert.throws(()=>applyPublication(r.state,{...body,action:'publication_retry',absenceToken:token,actorId:'other'},700001));applyPublication(r.state,{...body,action:'publication_retry',absenceToken:token},700001);assert.equal(p.status,'failed_confirmed');
 assert.throws(()=>requireAdministrator({memberPermissions:{has:()=>false}}),/管理者/);
});
test('保存先変更は監査して古い確認を失効させ、結果不明がある間は変更しない',()=>{
 const r=fixture();changeDestination(r.state,{channelId:null,actorId:ownerId});assert.equal(r.state.outputRevision,1);assert.equal(r.state.destinationHistory.length,1);changeDestination(r.state,{channelId,actorId:ownerId});applyPublication(r.state,{action:'publication_reserve',version:1,channelId,destinationType:'forum'});assert.throws(()=>changeDestination(r.state,{channelId:null,actorId:ownerId}),/照合/);
});
test('旧テキスト投稿を移行して版と本文を保ち、旧予約を照合待ちにする',()=>{
 const r=fixture();r.state.publications=[{version:1,channelId,messageId:threadId,status:'published',at:1000},{version:2,channelId,status:'pending',at:2000}];normalizePublications(r.state);assert.equal(r.state.publications[0].starterMessageId,threadId);assert.equal(r.state.publications[0].approvedMarkdown,r.version.approvedMarkdown);assert.equal(r.state.publications[1].status,'needs_reconciliation');assert.equal(r.state.publications[1].attemptedAt,2000);
});

test('照合のページ上限・権限不足・別会議の識別子では未送信と判断しない',async()=>{
 const r=fixture();applyPublication(r.state,{action:'publication_reserve',version:1,channelId,destinationType:'forum'});const p=r.state.publications[0];
 const messages=new Collection(Array.from({length:100},(_,i)=>[String(i),{id:String(i),author:{id:botId},createdTimestamp:Date.now(),content:'別会議の投稿'}]));r.thread.messages.fetch=async()=>messages;
 let result=await inspectPublication({state:r.state,publication:p,channel:r.channel,bot,maxPages:1});assert.equal(result.complete,false);assert.equal(result.matches.length,0);
 r.channel.permissionsFor=()=>({has:()=>false});await assert.rejects(()=>inspectPublication({state:r.state,publication:p,channel:r.channel,bot}),/履歴権限/);
});
test('投稿URL照合はギルド・投稿先・Bot作者・識別子をすべて検証する',async()=>{
 const r=fixture();applyPublication(r.state,{action:'publication_reserve',version:1,channelId,destinationType:'forum'});const p=r.state.publications[0],url=`https://discord.com/channels/${guildId}/${threadId}/${threadId}`;
 r.thread.messages.fetch=async()=>({id:threadId,author:{id:'other'},content:marker(r.state,r.version,p)});await assert.rejects(()=>verifyMessageLink({state:r.state,publication:p,guild:r.channel.guild,bot,url}),/このBot/);
 r.thread.messages.fetch=async()=>({id:threadId,author:{id:botId},content:'別会議の投稿'});await assert.rejects(()=>verifyMessageLink({state:r.state,publication:p,guild:r.channel.guild,bot,url}),/識別/);
 await assert.rejects(()=>verifyMessageLink({state:r.state,publication:p,guild:r.channel.guild,bot,url:url.replace(guildId,'999999999999999999')}),/同じサーバー/);
});
