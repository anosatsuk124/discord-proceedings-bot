import { readdir, stat, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import {
    MANIFEST_FILE,
    readManifestSummary,
    type ManifestSummary,
} from './manifest.ts';
import type { Logger } from './recording-session.ts';

/**
 * recognizer が書いた議事録(proceedings.csv)を、/gijiroku start を実行したテキストチャンネルに投稿する。
 *
 * セッションのディレクトリを定期的に見て、議事録(または文字起こしの失敗の記録)があり、
 * まだ投稿していないものを投稿する。投稿したら delivery.json を書くので、Bot が再起動しても
 * 二重には投稿しない。
 */

/** recognizer が書く議事録。 */
export const PROCEEDINGS_FILE = 'proceedings.csv';
/** recognizer が文字起こしに失敗したときに書く。 */
export const TRANSCRIPTION_ERROR_FILE = 'transcription.error';
/** 投稿の結果。これがあるセッションは投稿しない。 */
export const DELIVERY_FILE = 'delivery.json';

/** Bot が添付できるファイルの大きさの上限(ブーストしていないサーバーで 10MB)。 */
export const MAX_ATTACHMENT_BYTES = 10_000_000;

export interface OutgoingMessage {
    readonly content: string;
    readonly file?: { readonly path: string; readonly name: string };
}

/** チャンネルにメッセージを送るもの。テストでは偽物に差し替える。 */
export interface Poster {
    post(
        channelId: string,
        message: OutgoingMessage
    ): Promise<{ readonly messageId: string }>;
}

/** 投稿先が無い、権限が無いなど、やり直しても成功しない失敗。 */
export class PermanentDeliveryError extends Error {
    override name = 'PermanentDeliveryError';
}

export type Outcome =
    | {
          readonly kind: 'ready';
          readonly csvPath: string;
          readonly csvBytes: number;
      }
    | { readonly kind: 'failed' };

export interface Deliverable {
    readonly directory: string;
    readonly manifest: ManifestSummary & { readonly textChannelId: string };
    readonly outcome: Outcome;
}

/** 投稿できる状態で、まだ投稿していないセッションを探す。 */
export async function findDeliverable(
    dataDir: string,
    logger: Logger = console
): Promise<Deliverable[]> {
    const found: Deliverable[] = [];
    for (const directory of await sessionDirectories(dataDir)) {
        const files = new Set(await readdir(directory).catch(() => []));
        if (!files.has(MANIFEST_FILE) || files.has(DELIVERY_FILE)) continue;
        let outcome: Outcome;
        if (files.has(PROCEEDINGS_FILE)) {
            const csvPath = path.join(directory, PROCEEDINGS_FILE);
            outcome = {
                kind: 'ready',
                csvPath,
                csvBytes: (await stat(csvPath)).size,
            };
        } else if (files.has(TRANSCRIPTION_ERROR_FILE)) {
            outcome = { kind: 'failed' };
        } else {
            continue; // まだ文字起こしが終わっていない
        }
        let manifest: ManifestSummary;
        try {
            manifest = await readManifestSummary(directory);
        } catch (error) {
            logger.warn(`cannot read the manifest in ${directory}`, error);
            continue;
        }
        // 投稿先を記録する前の版で録ったセッションは投稿しない。
        if (manifest.textChannelId === null) continue;
        found.push({
            directory,
            manifest: { ...manifest, textChannelId: manifest.textChannelId },
            outcome,
        });
    }
    return found;
}

/** `<DATA_DIR>/sessions/<guild_id>/<session_id>` を古い順に並べる。 */
export async function sessionDirectories(dataDir: string): Promise<string[]> {
    const root = path.join(dataDir, 'sessions');
    const directories: string[] = [];
    for (const guild of await subdirectories(root)) {
        directories.push(...(await subdirectories(guild)));
    }
    return directories.sort((a, b) =>
        path.basename(a).localeCompare(path.basename(b))
    );
}

async function subdirectories(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true }).catch(
        (error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return [];
            throw error;
        }
    );
    return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(directory, entry.name));
}

/** 投稿するメッセージを組み立てる。 */
export function composeMessage(deliverable: Deliverable): OutgoingMessage {
    const { manifest, outcome } = deliverable;
    const when = `<t:${unix(manifest.startedAt)}:f> 〜 <t:${unix(manifest.endedAt)}:t>`;
    const where = `<#${manifest.channelId}>`;
    if (outcome.kind === 'failed') {
        return {
            content: `⚠️ ${where} の録音(${when})は文字起こしに失敗しました。recognizer のログを確認してください。`,
        };
    }
    if (manifest.utteranceCount === 0) {
        return {
            content: `📝 ${where} の録音(${when})には発言がありませんでした。`,
        };
    }
    const summary = `📝 ${where} の議事録です(${when}、発言 ${manifest.utteranceCount} 件)。`;
    if (outcome.csvBytes > MAX_ATTACHMENT_BYTES) {
        return {
            content: `${summary}\nファイルが大きすぎて添付できないので、サーバーの ${path.basename(deliverable.directory)}/${PROCEEDINGS_FILE} を見てください。`,
        };
    }
    return {
        content: summary,
        file: {
            path: outcome.csvPath,
            name: `proceedings-${manifest.sessionId}.csv`,
        },
    };
}

function unix(date: Date): number {
    return Math.floor(date.getTime() / 1000);
}

export interface DeliveryOptions {
    readonly dataDir: string;
    readonly poster: Poster;
    readonly logger?: Logger;
    readonly now?: () => Date;
}

/** 投稿できるセッションをすべて投稿する。一時的な失敗は次の回にやり直す。 */
export async function deliverPending(
    options: DeliveryOptions
): Promise<number> {
    const logger = options.logger ?? console;
    const now = options.now ?? (() => new Date());
    let delivered = 0;
    for (const deliverable of await findDeliverable(options.dataDir, logger)) {
        const channelId = deliverable.manifest.textChannelId;
        try {
            const { messageId } = await options.poster.post(
                channelId,
                composeMessage(deliverable)
            );
            await writeDelivery(deliverable.directory, {
                status: 'posted',
                channel_id: channelId,
                message_id: messageId,
                at: now().toISOString(),
            });
            logger.info(
                `posted the proceedings of ${deliverable.directory} to channel ${channelId}`
            );
            delivered += 1;
        } catch (error) {
            if (error instanceof PermanentDeliveryError) {
                logger.error(
                    `giving up posting ${deliverable.directory}: ${error.message}`
                );
                await writeDelivery(deliverable.directory, {
                    status: 'failed',
                    channel_id: channelId,
                    error: error.message,
                    at: now().toISOString(),
                });
            } else {
                logger.warn(
                    `failed to post ${deliverable.directory}; retrying later`,
                    error
                );
            }
        }
    }
    return delivered;
}

async function writeDelivery(directory: string, record: object): Promise<void> {
    const target = path.join(directory, DELIVERY_FILE);
    await writeFile(`${target}.tmp`, `${JSON.stringify(record, null, 2)}\n`, {
        mode: 0o640,
    });
    await rename(`${target}.tmp`, target);
}
