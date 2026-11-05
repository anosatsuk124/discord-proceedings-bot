import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import {
    EndBehaviorType,
    type AudioReceiveStreamOptions,
} from '@discordjs/voice';
import {
    newSessionId,
    sessionDirectory,
    writeManifest,
    type SessionManifest,
    type Utterance,
} from './manifest.ts';
import { OggOpusWriter } from './ogg-opus.ts';

export type Logger = Pick<Console, 'info' | 'warn' | 'error'>;

/**
 * RecordingSession が使う VoiceReceiver の機能だけを抜き出したもの。
 * @discordjs/voice の VoiceReceiver はこれを満たす。テストでは偽物に差し替える。
 */
export interface Receiver {
    readonly speaking: {
        on(event: 'start', listener: (userId: string) => void): unknown;
        off(event: 'start', listener: (userId: string) => void): unknown;
    };
    subscribe(
        userId: string,
        options?: Partial<AudioReceiveStreamOptions>
    ): Readable;
}

export interface RecordingSessionOptions {
    readonly receiver: Receiver;
    readonly dataDir: string;
    readonly guildId: string;
    readonly channelId: string;
    readonly silenceDurationMs: number;
    /** 録音する相手か(Bot を除くなど)。 */
    readonly shouldRecord?: (userId: string) => boolean;
    /** 発言者の表示名。失敗したときは呼び出し側で userId などに置き換えて返す。 */
    readonly resolveSpeaker?: (userId: string) => Promise<string>;
    readonly logger?: Logger;
    readonly now?: () => Date;
    /** stop() で書き込み中の録音を待つ上限(ミリ秒)。 */
    readonly stopTimeoutMs?: number;
}

/**
 * 1 つのボイスチャンネル接続での録音。発言(無音で区切られたひと続きの音声)ごとに
 * Ogg Opus ファイルを 1 つ書き、stop() で manifest.json を書いて終わる。
 */
export class RecordingSession {
    readonly id: string;
    readonly directory: string;
    readonly guildId: string;
    readonly channelId: string;
    readonly startedAt: Date;

    readonly #receiver: Receiver;
    readonly #silenceDurationMs: number;
    readonly #shouldRecord: (userId: string) => boolean;
    readonly #resolveSpeaker: (userId: string) => Promise<string>;
    readonly #logger: Logger;
    readonly #now: () => Date;
    readonly #stopTimeoutMs: number;

    /** 録音中のユーザーごとの受信ストリーム。 */
    readonly #activeStreams = new Map<string, Readable>();
    /** 書き込み中の発言。完了すると自分で消える。 */
    readonly #pendingWrites = new Set<Promise<void>>();
    readonly #utterances: Utterance[] = [];
    readonly #speakerNames = new Map<string, Promise<string>>();
    #stopping: Promise<SessionManifest> | undefined;

    static async start(
        options: RecordingSessionOptions
    ): Promise<RecordingSession> {
        const now = options.now ?? (() => new Date());
        const startedAt = now();
        const id = newSessionId(startedAt);
        const directory = sessionDirectory(
            options.dataDir,
            options.guildId,
            id
        );
        await mkdir(directory, { recursive: true, mode: 0o750 });
        return new RecordingSession(options, id, directory, startedAt);
    }

    private constructor(
        options: RecordingSessionOptions,
        id: string,
        directory: string,
        startedAt: Date
    ) {
        this.id = id;
        this.directory = directory;
        this.guildId = options.guildId;
        this.channelId = options.channelId;
        this.startedAt = startedAt;
        this.#receiver = options.receiver;
        this.#silenceDurationMs = options.silenceDurationMs;
        this.#shouldRecord = options.shouldRecord ?? (() => true);
        this.#resolveSpeaker =
            options.resolveSpeaker ?? ((userId) => Promise.resolve(userId));
        this.#logger = options.logger ?? console;
        this.#now = options.now ?? (() => new Date());
        this.#stopTimeoutMs = options.stopTimeoutMs ?? 10_000;
        this.#receiver.speaking.on('start', this.#onSpeakingStart);
    }

    get utteranceCount(): number {
        return this.#utterances.length;
    }

    /**
     * 録音を止めて manifest.json を書く。録音中の発言はそこまでで閉じる。
     * 何度呼んでも同じ結果を返す。
     */
    stop(): Promise<SessionManifest> {
        this.#stopping ??= this.#finish();
        return this.#stopping;
    }

    readonly #onSpeakingStart = (userId: string): void => {
        if (this.#stopping !== undefined) return;
        if (this.#activeStreams.has(userId)) return;
        if (!this.#shouldRecord(userId)) return;
        this.#record(userId);
    };

    #record(userId: string): void {
        const id = randomUUID();
        const file = `${id}.ogg`;
        const filePath = path.join(this.directory, file);
        const startedAt = this.#now();
        const speaker = this.#speakerName(userId);

        const opus = this.#receiver.subscribe(userId, {
            end: {
                behavior: EndBehaviorType.AfterSilence,
                duration: this.#silenceDurationMs,
            },
        });
        this.#activeStreams.set(userId, opus);
        const ogg = new OggOpusWriter();

        // 受信ストリームがエラーで閉じても(DAVE の復号失敗など)、それまでに受け取った
        // 音声は残したいので、pipeline でつながずに close を見て Ogg を閉じる。
        opus.on('error', (error) => {
            this.#logger.warn(
                `[${this.id}] receive stream for user ${userId} failed; keeping audio received so far`,
                error
            );
        });
        opus.once('close', () => {
            this.#activeStreams.delete(userId);
            ogg.end();
        });
        opus.pipe(ogg, { end: false });

        const write = pipeline(
            ogg,
            createWriteStream(filePath, { flags: 'wx', mode: 0o640 })
        )
            .then(async () => {
                if (ogg.packetCount === 0) {
                    await rm(filePath, { force: true });
                    return;
                }
                this.#utterances.push({
                    id,
                    userId,
                    speaker: await speaker,
                    startedAt,
                    endedAt: this.#now(),
                    file,
                });
            })
            .catch(async (error: unknown) => {
                this.#logger.error(
                    `[${this.id}] failed to write ${file}`,
                    error
                );
                await rm(filePath, { force: true }).catch(() => {});
            })
            .finally(() => {
                this.#pendingWrites.delete(write);
            });
        this.#pendingWrites.add(write);
    }

    #speakerName(userId: string): Promise<string> {
        let name = this.#speakerNames.get(userId);
        if (name === undefined) {
            name = this.#resolveSpeaker(userId).catch((error: unknown) => {
                this.#logger.warn(
                    `[${this.id}] failed to resolve the name of user ${userId}`,
                    error
                );
                return userId;
            });
            this.#speakerNames.set(userId, name);
        }
        return name;
    }

    async #finish(): Promise<SessionManifest> {
        this.#receiver.speaking.off('start', this.#onSpeakingStart);
        for (const stream of this.#activeStreams.values()) {
            stream.push(null);
        }

        const settled = Promise.allSettled([...this.#pendingWrites]).then(
            () => true
        );
        const finished = await Promise.race([
            settled,
            // ref: false にしておかないと、録音が先に終わってもタイマーがプロセスを止めておく。
            delay(this.#stopTimeoutMs, false, { ref: false }),
        ]);
        if (!finished) {
            this.#logger.warn(
                `[${this.id}] gave up waiting for ${this.#pendingWrites.size} recording(s) after ${this.#stopTimeoutMs}ms`
            );
        }

        const manifest: SessionManifest = {
            sessionId: this.id,
            guildId: this.guildId,
            channelId: this.channelId,
            startedAt: this.startedAt,
            endedAt: this.#now(),
            utterances: [...this.#utterances].sort(
                (a, b) => a.startedAt.getTime() - b.startedAt.getTime()
            ),
        };
        await writeManifest(this.directory, manifest);
        return manifest;
    }
}
