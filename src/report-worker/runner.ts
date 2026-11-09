import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
    agentCredentialVariables,
    agentDomains,
    buildAgentCommand,
    type AgentSettings,
} from './agent-cli.ts';
import {
    childEnvironment,
    srtSettings,
    wrapCommand,
    type SandboxMode,
} from './sandbox.ts';

export interface AgentTask {
    readonly name: string;
    readonly cwd: string;
    readonly prompt: string;
    readonly web: boolean;
}

export interface AgentRun {
    readonly stdout: string;
    readonly exitCode: number | null;
    readonly timedOut: boolean;
}

/** LLM を起動するもの。テストでは偽物に差し替える。 */
export type AgentRunner = (task: AgentTask) => Promise<AgentRun>;

export interface CliRunnerOptions {
    readonly agent: AgentSettings;
    readonly sandbox: SandboxMode;
    readonly jobsDir: string;
    readonly taskRoot: string;
    readonly webDomains: readonly string[];
    readonly extraDomains: readonly string[];
    readonly timeoutMs: number;
    readonly env?: NodeJS.ProcessEnv;
}

/** サンドボックスで包んだ CLI を外部プロセスとして起動する。 */
export function cliRunner(options: CliRunnerOptions): AgentRunner {
    const { agent, sandbox } = options;
    return async (task) => {
        // タスクごとに別のホームにする。あるタスクが別のタスクに影響を残せないように。
        const home = path.join(options.taskRoot, 'homes', task.name);
        await mkdir(path.join(home, 'tmp'), { recursive: true });
        const built = buildAgentCommand(agent, {
            cwd: task.cwd,
            prompt: task.prompt,
            web: task.web,
        });
        for (const [file, content] of Object.entries(built.files)) {
            await writeFile(path.join(task.cwd, file), content);
        }
        const settingsFile = path.join(home, 'srt-settings.json');
        await writeFile(
            settingsFile,
            JSON.stringify(
                srtSettings({
                    taskDirectory: task.cwd,
                    homeDirectory: home,
                    allowedDomains: [
                        ...agentDomains(agent.kind),
                        ...options.extraDomains,
                        ...(task.web ? options.webDomains : []),
                    ],
                    denyRead: [options.jobsDir, options.taskRoot],
                })
            )
        );
        const wrapped = wrapCommand(
            sandbox,
            settingsFile,
            built.command,
            built.args
        );
        try {
            return await spawnAgent(
                wrapped.command,
                wrapped.args,
                task.cwd,
                childEnvironment(
                    options.env ?? process.env,
                    agentCredentialVariables(agent.kind),
                    home
                ),
                options.timeoutMs
            );
        } finally {
            // /tmp は容量の小さい tmpfs なので、タスクが終わったら消す。
            await rm(home, { recursive: true, force: true });
        }
    };
}

function spawnAgent(
    command: string,
    args: readonly string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    timeoutMs: number
): Promise<AgentRun> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd,
            env,
            // 標準入力を閉じる。開いたままだと CLI が入力を待つ。
            stdio: ['ignore', 'pipe', 'pipe'],
            // サンドボックスの孫プロセスごと止められるようプロセスグループを分ける。
            detached: true,
        });
        const chunks: Buffer[] = [];
        child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
        // stderr は読み捨てる(読まないとパイプが詰まる)。
        child.stderr.on('data', () => {});
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            if (child.pid !== undefined) {
                try {
                    process.kill(-child.pid, 'SIGKILL');
                } catch {
                    // すでに終わっている
                }
            }
        }, timeoutMs);
        child.once('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.once('close', (exitCode) => {
            clearTimeout(timer);
            resolve({
                stdout: Buffer.concat(chunks).toString('utf8'),
                exitCode,
                timedOut,
            });
        });
    });
}
