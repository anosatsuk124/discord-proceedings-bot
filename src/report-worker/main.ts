import { setTimeout as delay } from 'node:timers/promises';
import { loadWorkerConfig } from './config.ts';
import { pendingJobs, processJob } from './job.ts';

/** ジョブが来ていないかを見に行く間隔 */
const POLL_INTERVAL_MS = 5_000;

const config = loadWorkerConfig();

let stopping = false;
const stop = (): void => {
    stopping = true;
    // 動いている LLM の結果は作業ディレクトリに残るので、次の起動でそこから続く。
    process.exit(0);
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

if (config.agent === null) {
    console.info('REPORT_AGENT=off; report-worker is idle');
    // restart: unless-stopped で再起動を繰り返さないよう、終わらずに待つ。
    setInterval(() => {}, 2 ** 31 - 1);
} else {
    const { agent } = config;
    console.info(
        `report-worker ready: ${agent.kind} (model ${agent.model ?? 'default'}, sandbox ${config.sandbox})`
    );
    // ジョブは 1 つずつ処理する(同時に動かす LLM の数はジョブの中で制限する)。
    while (!stopping) {
        const [next] = await pendingJobs(config.jobsDir);
        if (next === undefined) {
            await delay(POLL_INTERVAL_MS);
        } else {
            await processJob(next, config, agent);
        }
    }
}
