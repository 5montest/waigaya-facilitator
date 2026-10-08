import { UserError as Error, UserError } from '../errors.js';
import { PermissionFlagsBits, ChannelType } from 'discord.js';
import { randomUUID } from 'node:crypto';

export function canControl(state, interaction, roles = []) {
  if (state.guildId !== interaction.guildId) return false;
  return state.ownerId === interaction.user.id || interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) || roles.some(id => interaction.member?.roles?.cache?.has(id));
}
export function requireAccess(state, interaction, channel, { live = false, roles = [] } = {}) {
  if (!canControl(state, interaction, roles)) throw new Error('この会議の操作・閲覧は開始した人か管理担当者に限られます。');
  const permissions = channel?.permissionsFor(interaction.member);
  if (!permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect])) throw new Error('会議のボイスチャンネルを閲覧・接続できる権限が必要です。');
  if (live && interaction.guild?.voiceStates.cache.get(interaction.user.id)?.channelId !== state.voiceChannelId) throw new Error('Botと同じボイスチャンネルに参加して操作してください。');
}
export function requireOutput(channel, actor, bot) {
  if (!channel || channel.type !== ChannelType.GuildText) throw new Error('公開先には通常のテキストチャンネルを選んでください。');
  if (!channel.permissionsFor(actor)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) throw new Error('公開先を閲覧・投稿できる権限が必要です。');
  if (!channel.permissionsFor(bot)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles])) throw new Error('公開先でBotの閲覧・送信・ファイル添付権限を確認してください。');
}
export class Confirmations {
  constructor({ clock = Date.now, ttl = 60000 } = {}) { this.clock = clock; this.ttl = ttl; this.items = new Map(); }
  issue(operation, state, userId) {
    this.sweep(); const id = randomUUID();
    this.items.set(id, { operation, sessionId: state.id, version: state.minutesVersion, userId, expiresAt: this.clock() + this.ttl }); return id;
  }
  take(id, userId) {
    const item = this.items.get(id);
    if (!item || item.userId !== userId || item.expiresAt <= this.clock()) throw new Error('確認が失効したか、実行者が異なります。コマンドをもう一度使ってください。');
    this.items.delete(id); return item;
  }
  sweep() { for (const [id,item] of this.items) if (item.expiresAt <= this.clock()) this.items.delete(id); }
}

// Persist a reservation before sending. On an ambiguous send result never send again automatically.
export class MinutesPublisher {
  constructor() { this.pending = new Map(); }
  async publish({ state, channelId, reserve, send, commit, onFailure = async () => {} }) {
    const version = state.minutesHistory.at(-1);
    const key = `${state.id}:${version.version}:${channelId}`;
    const existing = state.publications.find(p => p.version === version.version && p.channelId === channelId);
    if (existing) return { duplicate: true, publication: existing };
    if (this.pending.has(key)) return this.pending.get(key);
    const job = (async () => {
      await reserve();
      let message;
      try { message = await send(); }
      catch { await onFailure().catch(() => {}); throw new Error('Discordへの共有送信に失敗しました。送信結果が不明なため予約を保持し、二重投稿しません。原本は削除していません。'); }
      try { await commit(message.id); }
      catch { throw new Error('Discordへの送信は完了しましたが、公開結果の保存を確認できません。予約を保持し、二重投稿しません。保存状態は /status で確認してください。'); }
      return { duplicate: false, messageId: message.id };
    })();
    this.pending.set(key, job);
    try { return await job; } finally { this.pending.delete(key); }
  }
}
