import { randomBytes } from 'node:crypto';
import { rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * 録音セッションの manifest。recognizer とのあいだの契約なので、形を変えるときは
 * MANIFEST_VERSION を上げて recognizer 側も合わせる。
 *
 * ディレクトリ構成:
 *   <DATA_DIR>/sessions/<guild_id>/<session_id>/manifest.json
 *   <DATA_DIR>/sessions/<guild_id>/<session_id>/<utterance_id>.ogg
 *
 * manifest.json は録音がすべて閉じてから最後に書く。recognizer は manifest.json の
 * 有無で「録音が終わったセッションか」を判断する。
 */

export const MANIFEST_FILE = 'manifest.json';
export const MANIFEST_VERSION = 1;

export interface Utterance {
    readonly id: string;
    readonly userId: string;
    /** 録音時点のサーバー内表示名。 */
    readonly speaker: string;
    readonly startedAt: Date;
    readonly endedAt: Date;
    /** セッションディレクトリからの相対パス(ファイル名のみ)。 */
    readonly file: string;
}

export interface SessionManifest {
    readonly sessionId: string;
    readonly guildId: string;
    readonly channelId: string;
    readonly startedAt: Date;
    readonly endedAt: Date;
    readonly utterances: readonly Utterance[];
}

/** 時刻順に並ぶセッション ID(例: 20261105T080102Z-1a2b3c4d)を作る。 */
export function newSessionId(
    startedAt: Date,
    suffix: string = randomBytes(4).toString('hex')
): string {
    const stamp = startedAt
        .toISOString()
        .replace(/[-:]/g, '')
        .replace(/\.\d{3}Z$/, 'Z');
    return `${stamp}-${suffix}`;
}

export function sessionDirectory(
    dataDir: string,
    guildId: string,
    sessionId: string
): string {
    return path.join(dataDir, 'sessions', guildId, sessionId);
}

export function serializeManifest(manifest: SessionManifest): string {
    const json = {
        version: MANIFEST_VERSION,
        session_id: manifest.sessionId,
        guild_id: manifest.guildId,
        channel_id: manifest.channelId,
        started_at: manifest.startedAt.toISOString(),
        ended_at: manifest.endedAt.toISOString(),
        utterances: manifest.utterances.map((u) => ({
            id: u.id,
            user_id: u.userId,
            speaker: u.speaker,
            started_at: u.startedAt.toISOString(),
            ended_at: u.endedAt.toISOString(),
            file: u.file,
        })),
    };
    return `${JSON.stringify(json, null, 2)}\n`;
}

/** manifest.json を書く。途中までの内容を recognizer に読まれないよう、一時ファイルから rename する。 */
export async function writeManifest(
    directory: string,
    manifest: SessionManifest
): Promise<string> {
    const target = path.join(directory, MANIFEST_FILE);
    const temporary = `${target}.tmp`;
    await writeFile(temporary, serializeManifest(manifest), {
        mode: 0o640,
    });
    await rename(temporary, target);
    return target;
}
