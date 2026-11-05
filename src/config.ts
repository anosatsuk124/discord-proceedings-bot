import path from 'node:path';

export interface Config {
    /** Discord の Bot トークン。 */
    readonly discordToken: string;
    /** 録音と manifest を書き出すディレクトリ。recognizer と共有する。 */
    readonly dataDir: string;
    /** 発言の区切りとみなす無音の長さ(ミリ秒)。 */
    readonly silenceDurationMs: number;
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
        silenceDurationMs: parsePositiveInteger(
            env,
            'SILENCE_DURATION_MS',
            1000
        ),
    };
}

function parsePositiveInteger(
    env: NodeJS.ProcessEnv,
    name: string,
    fallback: number
): number {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new ConfigError(`${name} must be a positive integer: ${raw}`);
    }
    return value;
}
