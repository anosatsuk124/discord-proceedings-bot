import { readdir, rm, rmdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { sessionDirectories } from './delivery.ts';
import type { Logger } from './recording-session.ts';

/**
 * 録音の保存期間。開始から retentionDays 日を過ぎたセッションの音声ファイル(.ogg)を消す。
 * 議事録(proceedings.csv)と manifest.json は残す。中身が空になったディレクトリ
 * (manifest を書く前に止まったセッションなど)は消す。
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RetentionOptions {
    readonly dataDir: string;
    readonly retentionDays: number;
    readonly now?: () => Date;
    readonly logger?: Logger;
}

export interface RetentionResult {
    readonly deletedFiles: number;
    readonly deletedDirectories: number;
}

export async function purgeExpiredRecordings(
    options: RetentionOptions
): Promise<RetentionResult> {
    const logger = options.logger ?? console;
    const now = options.now ?? (() => new Date());
    const result = { deletedFiles: 0, deletedDirectories: 0 };
    if (options.retentionDays <= 0) return result;

    const cutoff = now().getTime() - options.retentionDays * DAY_MS;
    for (const directory of await sessionDirectories(options.dataDir)) {
        const startedAt =
            parseSessionStart(path.basename(directory)) ??
            (await stat(directory)).mtime;
        if (startedAt.getTime() >= cutoff) continue;

        const entries = await readdir(directory);
        for (const name of entries.filter((name) => name.endsWith('.ogg'))) {
            await rm(path.join(directory, name), { force: true });
            result.deletedFiles += 1;
        }
        if ((await readdir(directory)).length === 0) {
            await rmdir(directory);
            result.deletedDirectories += 1;
        }
    }
    if (result.deletedFiles > 0 || result.deletedDirectories > 0) {
        logger.info(
            `deleted ${result.deletedFiles} recording(s) and ${result.deletedDirectories} empty session(s) older than ${options.retentionDays} day(s)`
        );
    }
    return result;
}

/** セッション ID(例: 20261105T080102Z-1a2b3c4d)から開始時刻を取り出す。 */
export function parseSessionStart(sessionId: string): Date | null {
    const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-/.exec(
        sessionId
    );
    if (match === null) return null;
    const [, y, mo, d, h, mi, s] = match.map(Number) as [number, ...number[]];
    return new Date(Date.UTC(y!, mo! - 1, d!, h!, mi!, s!));
}
