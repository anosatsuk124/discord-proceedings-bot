import { randomBytes } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
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
 *
 * 読む側は知らないフィールドを無視する。フィールドを足すだけなら MANIFEST_VERSION は上げない。
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
    /** 録音時点のサーバー名。議事録の見出しに使う。 */
    readonly guildName: string | null;
    /** 録音時点のボイスチャンネル名。議事録の見出しに使う。 */
    readonly channelName: string | null;
    /** /gijiroku start を実行したテキストチャンネル。議事録をここに投稿する。 */
    readonly textChannelId: string | null;
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
        guild_name: manifest.guildName,
        channel_name: manifest.channelName,
        text_channel_id: manifest.textChannelId,
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

/** 議事録の投稿に使う、manifest.json の一部。 */
export interface ManifestSummary {
    readonly sessionId: string;
    readonly channelId: string;
    readonly textChannelId: string | null;
    readonly startedAt: Date;
    readonly endedAt: Date;
    readonly utteranceCount: number;
}

export async function readManifestSummary(
    directory: string
): Promise<ManifestSummary> {
    const json: unknown = JSON.parse(
        await readFile(path.join(directory, MANIFEST_FILE), 'utf8')
    );
    if (typeof json !== 'object' || json === null) {
        throw new TypeError('manifest must be a JSON object');
    }
    const m = json as Record<string, unknown>;
    const string = (key: string): string => {
        const value = m[key];
        if (typeof value !== 'string') {
            throw new TypeError(`manifest ${key} must be a string`);
        }
        return value;
    };
    const date = (key: string): Date => {
        const value = new Date(string(key));
        if (Number.isNaN(value.getTime())) {
            throw new TypeError(`manifest ${key} is not a date`);
        }
        return value;
    };
    const textChannelId = m['text_channel_id'];
    return {
        sessionId: string('session_id'),
        channelId: string('channel_id'),
        textChannelId: typeof textChannelId === 'string' ? textChannelId : null,
        startedAt: date('started_at'),
        endedAt: date('ended_at'),
        utteranceCount: Array.isArray(m['utterances'])
            ? m['utterances'].length
            : 0,
    };
}
