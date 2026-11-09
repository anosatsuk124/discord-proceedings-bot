import { open, readdir } from 'node:fs/promises';
import path from 'node:path';
import {
    PROCEEDINGS_FILE,
    TRANSCRIPTION_ERROR_FILE,
    sessionDirectories,
} from '../delivery.ts';
import {
    MANIFEST_FILE,
    readManifestSummary,
    type ManifestSummary,
} from '../manifest.ts';
import type { Logger } from '../recording-session.ts';

export type SessionState = 'ready' | 'empty' | 'transcribing' | 'failed';

/** まとめページの対象になり得る、録音が終わったセッション。 */
export interface SessionInfo extends ManifestSummary {
    readonly guildId: string;
    readonly directory: string;
    readonly state: SessionState;
}

/** サーバーごとに、録音が終わったセッションを古い順に並べる。 */
export async function listFinishedSessions(
    dataDir: string,
    logger: Logger = console
): Promise<Map<string, SessionInfo[]>> {
    const byGuild = new Map<string, SessionInfo[]>();
    for (const directory of await sessionDirectories(dataDir)) {
        const files = new Set(await readdir(directory).catch(() => []));
        if (!files.has(MANIFEST_FILE)) continue; // 録音中か、途中で止まったもの
        let manifest: ManifestSummary;
        try {
            manifest = await readManifestSummary(directory);
        } catch (error) {
            logger.warn(`cannot read the manifest in ${directory}`, error);
            continue;
        }
        let state: SessionState;
        if (files.has(PROCEEDINGS_FILE)) {
            state = (await csvHasRows(path.join(directory, PROCEEDINGS_FILE)))
                ? 'ready'
                : 'empty';
        } else if (files.has(TRANSCRIPTION_ERROR_FILE)) {
            state = 'failed';
        } else {
            state = 'transcribing';
        }
        const guildId = path.basename(path.dirname(directory));
        const list = byGuild.get(guildId) ?? [];
        list.push({ ...manifest, guildId, directory, state });
        byGuild.set(guildId, list);
    }
    return byGuild;
}

/** ヘッダーの次に中身のある行があるか。全体を読まずに済ませる。 */
async function csvHasRows(file: string): Promise<boolean> {
    const handle = await open(file, 'r');
    try {
        const { buffer, bytesRead } = await handle.read(
            Buffer.alloc(4096),
            0,
            4096,
            0
        );
        const text = buffer.subarray(0, bytesRead).toString('utf8');
        const newline = text.indexOf('\n');
        return newline !== -1 && text.slice(newline + 1).trim().length > 0;
    } finally {
        await handle.close();
    }
}

/** 期間 [start, end) と重なるセッションか。 */
export function overlaps(
    session: Pick<SessionInfo, 'startedAt' | 'endedAt'>,
    start: Date,
    end: Date
): boolean {
    return (
        session.startedAt.getTime() < end.getTime() &&
        session.endedAt.getTime() > start.getTime()
    );
}
