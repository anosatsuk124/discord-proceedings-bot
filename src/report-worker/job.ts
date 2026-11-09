import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
    JOB_REPORT_FILE,
    JOB_REQUEST_FILE,
    JOB_RESULT_FILE,
    JOB_VERSION,
    type JobRequest,
    type JobResult,
} from '../report/job-files.ts';
import { writeJsonAtomic } from '../report/shared.ts';
import type { AgentKind } from './agent-cli.ts';
import type { WorkerConfig } from './config.ts';
import { runPipeline } from './pipeline.ts';
import { cliRunner } from './runner.ts';

/** request.json があり、result.json がないジョブを古い順に返す。 */
export async function pendingJobs(jobsDir: string): Promise<string[]> {
    const entries = await readdir(jobsDir, { withFileTypes: true }).catch(
        (error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return [];
            throw error;
        }
    );
    const pending: Array<{ directory: string; created: number }> = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const directory = path.join(jobsDir, entry.name);
        const requested = await stat(
            path.join(directory, JOB_REQUEST_FILE)
        ).catch(() => null);
        if (requested === null) continue;
        const finished = await stat(
            path.join(directory, JOB_RESULT_FILE)
        ).catch(() => null);
        if (finished === null) {
            pending.push({ directory, created: requested.mtimeMs });
        }
    }
    return pending
        .sort((a, b) => a.created - b.created)
        .map((p) => p.directory);
}

/** URL に到達できるかを確かめる。許可したドメインの https だけを見に行く。 */
export function reachabilityChecker(
    domains: readonly string[]
): (url: string) => Promise<boolean> {
    const matches = (host: string): boolean =>
        domains.some((domain) =>
            domain.startsWith('*.')
                ? host.endsWith(domain.slice(1))
                : host === domain
        );
    return async (url) => {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:' || !matches(parsed.hostname)) {
            return false;
        }
        try {
            const response = await fetch(url, {
                signal: AbortSignal.timeout(15_000),
            });
            return response.ok;
        } catch {
            return false;
        }
    };
}

/** ジョブを 1 つ処理する。失敗しても result.json を書いて bot に知らせる。 */
export async function processJob(
    directory: string,
    config: WorkerConfig,
    agent: NonNullable<WorkerConfig['agent']>
): Promise<void> {
    let result: JobResult;
    try {
        const request = JSON.parse(
            await readFile(path.join(directory, JOB_REQUEST_FILE), 'utf8')
        ) as JobRequest;
        if (request.version !== JOB_VERSION) {
            throw new Error(`unsupported job version: ${request.version}`);
        }
        const output = await runPipeline({
            jobDirectory: directory,
            request,
            agentKind: agent.kind as AgentKind,
            concurrency: config.concurrency,
            taskRoot: config.taskRoot,
            research: {
                enabled: config.research.enabled,
                maxTopics: config.research.maxTopics,
                isReachable: reachabilityChecker(config.research.domains),
            },
            runner: cliRunner({
                agent,
                sandbox: config.sandbox,
                jobsDir: config.jobsDir,
                taskRoot: config.taskRoot,
                webDomains: config.research.domains,
                extraDomains: config.extraDomains,
                timeoutMs: config.taskTimeoutMs,
            }),
        });
        await writeFile(path.join(directory, JOB_REPORT_FILE), output.html);
        result = output.result;
    } catch (error) {
        console.error(`job ${path.basename(directory)} failed`, error);
        result = {
            status: 'failed',
            error: error instanceof Error ? error.message : String(error),
        };
    }
    // bot は result.json を見て動くので、最後に書く。
    await writeJsonAtomic(path.join(directory, JOB_RESULT_FILE), result);
}
