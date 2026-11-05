import type { Logger } from './recording-session.ts';

/**
 * task を intervalMs ごとに動かす。前の回が終わっていなければその回は飛ばす。
 * 戻り値の関数で止める。
 */
export function runPeriodically(
    name: string,
    intervalMs: number,
    task: () => Promise<unknown>,
    logger: Logger = console
): () => void {
    let running = false;
    const tick = () => {
        if (running) return;
        running = true;
        task()
            .catch((error: unknown) => logger.error(`${name} failed`, error))
            .finally(() => {
                running = false;
            });
    };
    const timer = setInterval(tick, intervalMs);
    tick();
    return () => clearInterval(timer);
}
