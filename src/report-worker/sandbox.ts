/**
 * CLI をサンドボックス(srt)で包む。
 *
 * 書き込めるのはタスクのディレクトリと CLI のホームだけ、接続できるのは許可したドメインだけ。
 * ほかのジョブやタスクのファイルは読めないようにする。
 */

export type SandboxMode = 'srt' | 'none';

export interface SrtSettingsInput {
    readonly taskDirectory: string;
    readonly homeDirectory: string;
    readonly allowedDomains: readonly string[];
    /** 読ませないディレクトリ(ジョブの置き場所など)。 */
    readonly denyRead: readonly string[];
}

export function srtSettings(input: SrtSettingsInput): object {
    return {
        network: {
            allowedDomains: [...new Set(input.allowedDomains)],
            deniedDomains: [],
        },
        filesystem: {
            denyRead: input.denyRead,
            // denyRead より優先される。タスク自身のディレクトリだけ読めるようにする。
            allowRead: [input.taskDirectory, input.homeDirectory],
            allowWrite: [input.taskDirectory, input.homeDirectory],
            denyWrite: [],
        },
    };
}

export interface WrappedCommand {
    readonly command: string;
    readonly args: readonly string[];
}

export function wrapCommand(
    mode: SandboxMode,
    settingsFile: string,
    command: string,
    args: readonly string[]
): WrappedCommand {
    if (mode === 'none') return { command, args };
    return {
        command: 'srt',
        args: ['--settings', settingsFile, command, ...args],
    };
}

/** LLM の認証情報以外を子プロセスに渡さないための環境変数を作る。 */
export function childEnvironment(
    source: NodeJS.ProcessEnv,
    credentialVariables: readonly string[],
    homeDirectory: string
): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
        PATH: source['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
        HOME: homeDirectory,
        LANG: 'C.UTF-8',
        // CLI の一時ファイルをタスクのホームに置く(ルートのファイルシステムは読み取り専用)。
        // srt は TMPDIR にソケットを作るので、長いパスにならないよう /tmp のままにする。
        TMPDIR: '/tmp',
        CLAUDE_CODE_TMPDIR: `${homeDirectory}/tmp`,
        DISABLE_TELEMETRY: '1',
        DISABLE_ERROR_REPORTING: '1',
        DISABLE_AUTOUPDATER: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    };
    for (const name of credentialVariables) {
        const value = source[name];
        if (value) env[name] = value;
    }
    return env;
}
