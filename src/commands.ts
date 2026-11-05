import { InteractionContextType, SlashCommandBuilder } from 'discord.js';

/** Bot が登録するスラッシュコマンド。起動時に毎回この内容で上書き登録する。 */
export const commands = [
    new SlashCommandBuilder()
        .setName('join')
        .setDescription('あなたがいるボイスチャンネルの録音を始めます')
        .setContexts(InteractionContextType.Guild),
    new SlashCommandBuilder()
        .setName('leave')
        .setDescription('録音を終えてボイスチャンネルから退出します')
        .setContexts(InteractionContextType.Guild),
].map((command) => command.toJSON());
