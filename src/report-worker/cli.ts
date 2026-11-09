import {
    copyFile,
    mkdir,
    mkdtemp,
    readFile,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { JOB_VERSION, type JobRequest } from '../report/job-files.ts';
import { loadWorkerConfig } from './config.ts';
import { parseProceedingsCsv } from './csv.ts';
import { reachabilityChecker } from './job.ts';
import { runPipeline } from './pipeline.ts';
import { cliRunner } from './runner.ts';

/**
 * CSV を指定して HTML を作る単体実行用のコマンド。
 *
 *   pnpm report --csv a.csv --csv b.csv --out out.html [--work 作業ディレクトリ]
 *
 * 設定は bot と同じ環境変数(REPORT_AGENT など)から読む。
 */

const { values } = parseArgs({
    options: {
        csv: { type: 'string', multiple: true },
        out: { type: 'string' },
        work: { type: 'string' },
        guild: { type: 'string' },
        label: { type: 'string' },
    },
});

if (!values.csv?.length || !values.out) {
    console.error(
        'usage: pnpm report --csv a.csv [--csv b.csv] --out out.html [--work dir] [--guild name] [--label text]'
    );
    process.exit(2);
}

const config = loadWorkerConfig();
if (config.agent === null) {
    console.error('REPORT_AGENT is off');
    process.exit(2);
}

const work = path.resolve(
    values.work ?? (await mkdtemp(path.join(tmpdir(), 'report-')))
);
await mkdir(path.join(work, 'input'), { recursive: true });

const sessions: Array<JobRequest['sessions'][number]> = [];
for (const [index, csv] of values.csv.entries()) {
    const rows = parseProceedingsCsv(await readFile(csv, 'utf8'));
    const first = rows[0];
    const last = rows.at(-1);
    if (first === undefined || last === undefined) continue;
    const sessionId = `session-${index + 1}`;
    const relative = `input/${sessionId}.csv`;
    await copyFile(csv, path.join(work, relative));
    sessions.push({
        sessionId,
        channelName: null,
        startedAt: new Date(first.date).toISOString(),
        endedAt: new Date(last.date).toISOString(),
        csv: relative,
    });
}

const taskRoot = path.join(work, 'tasks');
const output = await runPipeline({
    jobDirectory: work,
    agentKind: config.agent.kind,
    concurrency: config.concurrency,
    taskRoot,
    request: {
        version: JOB_VERSION,
        jobId: path.basename(work),
        guildName: values.guild ?? null,
        timeZone: process.env['PROCEEDINGS_TIMEZONE']?.trim() || 'Asia/Tokyo',
        periodLabel: values.label ?? '指定の録音',
        sessions,
        createdAt: new Date().toISOString(),
    },
    research: {
        enabled: config.research.enabled,
        maxTopics: config.research.maxTopics,
        isReachable: reachabilityChecker(config.research.domains),
    },
    runner: cliRunner({
        agent: config.agent,
        sandbox: config.sandbox,
        jobsDir: path.join(work, 'work'),
        taskRoot,
        webDomains: config.research.domains,
        extraDomains: config.extraDomains,
        timeoutMs: config.taskTimeoutMs,
    }),
});
await writeFile(values.out, output.html);
console.info(`wrote ${values.out}`);
for (const warning of output.result.warnings)
    console.warn(`warning: ${warning}`);
