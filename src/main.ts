import { Client, Events, GatewayIntentBits, type Guild } from 'discord.js';
import { ProceedingsBot } from './bot.ts';
import { commands } from './commands.ts';
import { ConfigError, loadConfig, type Config } from './config.ts';
import { deliverPending } from './delivery.ts';
import { discordPoster } from './discord-poster.ts';
import { runPeriodically } from './periodic.ts';
import { purgeExpiredRecordings } from './retention.ts';

/** 議事録ができたかを見に行く間隔 */
const DELIVERY_INTERVAL_MS = 15_000;
/** 保存期間を過ぎた録音を消す間隔 */
const RETENTION_INTERVAL_MS = 60 * 60 * 1000;

function loadConfigOrExit(): Config {
    try {
        return loadConfig();
    } catch (error) {
        if (error instanceof ConfigError) {
            console.error(`configuration error: ${error.message}`);
            process.exit(1);
        }
        throw error;
    }
}

const config = loadConfigOrExit();

// スラッシュコマンドとボイスチャンネルの状態だけを使うので、特権インテントは要らない。
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});
const poster = discordPoster(client);
const bot = new ProceedingsBot({ client, config, poster });
const stopTasks: Array<() => void> = [];

/**
 * コマンドはサーバーごとに登録する。グローバルの登録と違い、すぐに一覧に反映される。
 */
async function registerCommands(guild: Guild): Promise<void> {
    try {
        await guild.commands.set(commands);
        console.info(
            `registered /${commands.map((c) => c.name).join(', /')} in guild ${guild.id}`
        );
    } catch (error) {
        console.error(
            `failed to register slash commands in guild ${guild.id}`,
            error
        );
    }
}

client.once(Events.ClientReady, async (ready) => {
    console.info(`logged in as ${ready.user.tag}; data dir: ${config.dataDir}`);
    stopTasks.push(
        runPeriodically('posting proceedings', DELIVERY_INTERVAL_MS, () =>
            deliverPending({ dataDir: config.dataDir, poster })
        ),
        runPeriodically(
            'deleting expired recordings',
            RETENTION_INTERVAL_MS,
            () =>
                purgeExpiredRecordings({
                    dataDir: config.dataDir,
                    retentionDays: config.retentionDays,
                })
        )
    );
    try {
        // 以前の版はグローバルに登録していた(/join, /leave)。残っていると一覧に出続けるので消す。
        await ready.application.commands.set([]);
    } catch (error) {
        console.error('failed to clear global slash commands', error);
    }
    await Promise.all(ready.guilds.cache.map(registerCommands));
});
// 新しいサーバーに招待されたら、そのサーバーにもコマンドを登録する。
client.on(Events.GuildCreate, (guild) => void registerCommands(guild));
client.on(Events.InteractionCreate, (interaction) => {
    void bot.handleInteraction(interaction);
});
client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    bot.handleVoiceStateUpdate(oldState, newState);
});
client.on(Events.Error, (error) => {
    console.error('discord client error', error);
});
process.on('unhandledRejection', (reason) => {
    console.error('unhandled rejection', reason);
});

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.info(`received ${signal}; finishing active recordings`);
    for (const stop of stopTasks) stop();
    await bot.shutdown();
    await client.destroy();
    process.exit(0);
}
process.once('SIGINT', (signal) => void shutdown(signal));
process.once('SIGTERM', (signal) => void shutdown(signal));

await client.login(config.discordToken);
