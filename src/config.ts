import path from 'node:path';

export interface Config {
    /** Discord の Bot トークン。 */
    readonly discordToken: string;
    /** 録音と manifest を書き出すディレクトリ。recognizer と共有する。 */
    readonly dataDir: string;
    /** 発言の区切りとみなす無音の長さ(ミリ秒)。 */
    readonly silenceDurationMs: number;
    /** ボイスチャンネルから人がいなくなってから退出するまでの時間(ミリ秒)。0 なら自動では退出しない。 */
    readonly autoLeaveDelayMs: number;
    /** 録音(音声ファイル)を残しておく日数。0 なら消さない。 */
    readonly retentionDays: number;
    /** 音声接続(DAVE を含む)のデバッグログを出すか。 */
    readonly voiceDebug: boolean;
}

export class ConfigError extends Error {
    override name = 'ConfigError';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
    const discordToken = env['DISCORD_TOKEN']?.trim();
    if (!discordToken) {
        throw new ConfigError('DISCORD_TOKEN is not set');
    }
    return {
        discordToken,
        dataDir: path.resolve(env['DATA_DIR']?.trim() || 'data'),
        silenceDurationMs: parseInteger(env, 'SILENCE_DURATION_MS', 1000, 1),
        autoLeaveDelayMs:
            parseInteger(env, 'AUTO_LEAVE_DELAY_SECONDS', 60, 0) * 1000,
        retentionDays: parseInteger(env, 'RECORDING_RETENTION_DAYS', 30, 0),
        voiceDebug: parseBoolean(env, 'VOICE_DEBUG', false),
    };
}

function parseBoolean(
    env: NodeJS.ProcessEnv,
    name: string,
    fallback: boolean
): boolean {
    const raw = env[name]?.trim().toLowerCase();
    if (!raw) return fallback;
    if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
    if (['0', 'false', 'no', 'off'].includes(raw)) return false;
    throw new ConfigError(`${name} must be true or false: ${raw}`);
}

function parseInteger(
    env: NodeJS.ProcessEnv,
    name: string,
    fallback: number,
    minimum: number
): number {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < minimum) {
        throw new ConfigError(
            `${name} must be an integer >= ${minimum}: ${raw}`
        );
    }
    return value;
}
