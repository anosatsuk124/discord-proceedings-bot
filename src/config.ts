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
    /** 議事録ページの生成の設定。使えないときは null。 */
    readonly report: ReportConfig | null;
    /** report が null である理由。コマンドの返答に使う。 */
    readonly reportDisabledReason: string | null;
}

export interface PagerPublisherConfig {
    readonly kind: 'simple-static-pager';
    /** owner/name */
    readonly repo: string;
    readonly branch: string;
    readonly token: string;
}

export interface ReportConfig {
    /** 最後の録音が終わってから自動で生成するまでの時間(ミリ秒)。0 なら自動では生成しない。 */
    readonly autoDelayMs: number;
    /** report-worker の結果を待つ時間の上限(ミリ秒)。 */
    readonly jobTimeoutMs: number;
    /** report-worker と共有するディレクトリ。 */
    readonly jobsDir: string;
    readonly timeZone: string;
    readonly publisher: PagerPublisherConfig;
}

export class ConfigError extends Error {
    override name = 'ConfigError';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
    const discordToken = env['DISCORD_TOKEN']?.trim();
    if (!discordToken) {
        throw new ConfigError('DISCORD_TOKEN is not set');
    }
    const dataDir = path.resolve(env['DATA_DIR']?.trim() || 'data');
    return {
        discordToken,
        dataDir,
        silenceDurationMs: parseInteger(env, 'SILENCE_DURATION_MS', 1000, 1),
        autoLeaveDelayMs:
            parseInteger(env, 'AUTO_LEAVE_DELAY_SECONDS', 60, 0) * 1000,
        retentionDays: parseInteger(env, 'RECORDING_RETENTION_DAYS', 30, 0),
        voiceDebug: parseBoolean(env, 'VOICE_DEBUG', false),
        ...loadReportConfig(env, dataDir),
    };
}

const REPORT_AGENTS = ['off', 'claude', 'codex', 'opencode'];

function loadReportConfig(
    env: NodeJS.ProcessEnv,
    dataDir: string
): Pick<Config, 'report' | 'reportDisabledReason'> {
    const agent = env['REPORT_AGENT']?.trim().toLowerCase() || 'off';
    if (!REPORT_AGENTS.includes(agent)) {
        throw new ConfigError(
            `REPORT_AGENT must be one of ${REPORT_AGENTS.join(', ')}: ${agent}`
        );
    }
    if (agent === 'off') {
        return {
            report: null,
            reportDisabledReason:
                '議事録ページの生成は無効です(REPORT_AGENT=off)。',
        };
    }
    const publisher =
        env['REPORT_PUBLISHER']?.trim().toLowerCase() || 'simple-static-pager';
    if (publisher !== 'simple-static-pager') {
        throw new ConfigError(
            `REPORT_PUBLISHER must be simple-static-pager: ${publisher}`
        );
    }
    const repo = env['PAGER_REPO']?.trim();
    const token = env['PAGER_GITHUB_TOKEN']?.trim();
    if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
        throw new ConfigError(`PAGER_REPO must be owner/name: ${repo}`);
    }
    if (!repo || !token) {
        // 録音や文字起こしは動かせるので、起動は止めない。
        return {
            report: null,
            reportDisabledReason:
                '議事録ページの公開先が設定されていません(PAGER_REPO と PAGER_GITHUB_TOKEN)。',
        };
    }
    return {
        report: {
            autoDelayMs:
                parseInteger(env, 'REPORT_AUTO_DELAY_HOURS', 12, 0) * 3_600_000,
            jobTimeoutMs:
                parseInteger(env, 'REPORT_JOB_TIMEOUT_MINUTES', 240, 1) *
                60_000,
            jobsDir: path.resolve(
                env['REPORT_JOBS_DIR']?.trim() ||
                    path.join(dataDir, 'report-jobs')
            ),
            timeZone: parseTimeZone(env),
            publisher: {
                kind: 'simple-static-pager',
                repo,
                branch: env['PAGER_BRANCH']?.trim() || 'html',
                token,
            },
        },
        reportDisabledReason: null,
    };
}

function parseTimeZone(env: NodeJS.ProcessEnv): string {
    const timeZone = env['PROCEEDINGS_TIMEZONE']?.trim() || 'Asia/Tokyo';
    try {
        new Intl.DateTimeFormat('en-US', { timeZone });
    } catch {
        throw new ConfigError(
            `PROCEEDINGS_TIMEZONE is not a time zone: ${timeZone}`
        );
    }
    return timeZone;
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
