import {
    MessageFlags,
    type ChatInputCommandInteraction,
    type Client,
    type Guild,
    type Interaction,
} from 'discord.js';
import {
    VoiceConnectionStatus,
    entersState,
    joinVoiceChannel,
    type VoiceConnection,
} from '@discordjs/voice';
import type { Config } from './config.ts';
import type { SessionManifest } from './manifest.ts';
import { RecordingSession, type Logger } from './recording-session.ts';

const READY_TIMEOUT_MS = 20_000;
const RECONNECT_TIMEOUT_MS = 5_000;

interface ActiveSession {
    readonly connection: VoiceConnection;
    readonly recording: RecordingSession;
}

export interface ProceedingsBotOptions {
    readonly client: Client;
    readonly config: Config;
    readonly logger?: Logger;
}

/** /join と /leave を受けて、サーバーごとに 1 つの録音セッションを管理する。 */
export class ProceedingsBot {
    readonly #client: Client;
    readonly #config: Config;
    readonly #logger: Logger;
    readonly #sessions = new Map<string, ActiveSession>();
    /** /join の処理中のサーバー。二重に接続しないために使う。 */
    readonly #joining = new Set<string>();

    constructor(options: ProceedingsBotOptions) {
        this.#client = options.client;
        this.#config = options.config;
        this.#logger = options.logger ?? console;
    }

    async handleInteraction(interaction: Interaction): Promise<void> {
        if (!interaction.isChatInputCommand()) return;
        try {
            switch (interaction.commandName) {
                case 'join':
                    await this.#join(interaction);
                    break;
                case 'leave':
                    await this.#leave(interaction);
                    break;
            }
        } catch (error) {
            this.#logger.error(
                `/${interaction.commandName} failed in guild ${interaction.guildId}`,
                error
            );
            await this.#replyError(interaction).catch(() => {});
        }
    }

    /** 全サーバーの録音を止めて manifest を書く。プロセス終了前に呼ぶ。 */
    async shutdown(): Promise<void> {
        await Promise.allSettled(
            [...this.#sessions.keys()].map((guildId) =>
                this.#finish(guildId, 'shutdown')
            )
        );
    }

    async #join(interaction: ChatInputCommandInteraction): Promise<void> {
        if (!interaction.inCachedGuild()) {
            await interaction.reply({
                content: 'サーバー内で実行してください。',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }
        const { guild, guildId } = interaction;
        const channel = interaction.member.voice.channel;
        if (channel === null) {
            await interaction.reply({
                content:
                    'ボイスチャンネルに参加してから `/join` を実行してください。',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }
        const active = this.#sessions.get(guildId);
        if (active !== undefined || this.#joining.has(guildId)) {
            await interaction.reply({
                content: active
                    ? `すでに <#${active.recording.channelId}> で録音しています。`
                    : 'いま録音の準備をしています。',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }
        if (!channel.joinable) {
            await interaction.reply({
                content: `${channel} に接続できません。Bot の権限を確認してください。`,
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        this.#joining.add(guildId);
        try {
            await interaction.deferReply();
            const connection = joinVoiceChannel({
                channelId: channel.id,
                guildId,
                adapterCreator: guild.voiceAdapterCreator,
                selfDeaf: false,
                selfMute: true,
            });
            let recording: RecordingSession;
            try {
                await entersState(
                    connection,
                    VoiceConnectionStatus.Ready,
                    READY_TIMEOUT_MS
                );
                recording = await RecordingSession.start({
                    receiver: connection.receiver,
                    dataDir: this.#config.dataDir,
                    guildId,
                    channelId: channel.id,
                    silenceDurationMs: this.#config.silenceDurationMs,
                    shouldRecord: (userId) =>
                        this.#client.users.cache.get(userId)?.bot !== true,
                    resolveSpeaker: (userId) =>
                        this.#displayName(guild, userId),
                    logger: this.#logger,
                });
            } catch (error) {
                connection.destroy();
                throw error;
            }
            this.#sessions.set(guildId, { connection, recording });
            this.#watchConnection(guildId, connection);
            this.#logger.info(
                `[${recording.id}] recording started in guild ${guildId} channel ${channel.id}`
            );
            await interaction.editReply(
                `🔴 ${channel} の録音を始めました。終わるときは \`/leave\` を実行してください。`
            );
        } finally {
            this.#joining.delete(guildId);
        }
    }

    async #leave(interaction: ChatInputCommandInteraction): Promise<void> {
        const guildId = interaction.guildId;
        if (guildId === null || !this.#sessions.has(guildId)) {
            await interaction.reply({
                content: '録音していません。',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }
        await interaction.deferReply();
        const manifest = await this.#finish(guildId, '/leave');
        await interaction.editReply(
            manifest
                ? `⏹️ 録音を終えました(発言 ${manifest.utterances.length} 件)。文字起こしは順に行われます。`
                : '録音していません。'
        );
    }

    /**
     * 録音を止めて接続を切る。同じサーバーで二度呼ばれても一度しか処理しない。
     */
    async #finish(
        guildId: string,
        reason: string
    ): Promise<SessionManifest | undefined> {
        const session = this.#sessions.get(guildId);
        if (session === undefined) return undefined;
        this.#sessions.delete(guildId);
        try {
            // 接続を先に切ると受信中のストリームがエラーで閉じるので、録音を止めてから切る。
            const manifest = await session.recording.stop();
            this.#logger.info(
                `[${manifest.sessionId}] recording finished (${reason}): ${manifest.utterances.length} utterance(s) in ${session.recording.directory}`
            );
            return manifest;
        } finally {
            if (
                session.connection.state.status !==
                VoiceConnectionStatus.Destroyed
            ) {
                session.connection.destroy();
            }
        }
    }

    #watchConnection(guildId: string, connection: VoiceConnection): void {
        const isCurrent = () =>
            this.#sessions.get(guildId)?.connection === connection;

        connection.on(VoiceConnectionStatus.Disconnected, async () => {
            if (!isCurrent()) return;
            try {
                // 別のチャンネルへの移動などなら、すぐに再接続が始まる。
                await Promise.race([
                    entersState(
                        connection,
                        VoiceConnectionStatus.Signalling,
                        RECONNECT_TIMEOUT_MS
                    ),
                    entersState(
                        connection,
                        VoiceConnectionStatus.Connecting,
                        RECONNECT_TIMEOUT_MS
                    ),
                ]);
            } catch {
                await this.#finish(guildId, 'disconnected').catch((error) =>
                    this.#logger.error(
                        `failed to finish the session in guild ${guildId}`,
                        error
                    )
                );
            }
        });
        connection.on(VoiceConnectionStatus.Destroyed, () => {
            if (!isCurrent()) return;
            this.#finish(guildId, 'connection destroyed').catch((error) =>
                this.#logger.error(
                    `failed to finish the session in guild ${guildId}`,
                    error
                )
            );
        });
        connection.on('error', (error) => {
            this.#logger.error(
                `voice connection error in guild ${guildId}`,
                error
            );
        });
    }

    async #displayName(guild: Guild, userId: string): Promise<string> {
        const cached = guild.members.cache.get(userId);
        if (cached !== undefined) return cached.displayName;
        const member = await guild.members.fetch(userId);
        return member.displayName;
    }

    async #replyError(interaction: ChatInputCommandInteraction): Promise<void> {
        const content =
            'エラーが起きました。しばらくしてからもう一度試してください。';
        if (interaction.deferred || interaction.replied) {
            await interaction.editReply(content);
        } else {
            await interaction.reply({
                content,
                flags: MessageFlags.Ephemeral,
            });
        }
    }
}
