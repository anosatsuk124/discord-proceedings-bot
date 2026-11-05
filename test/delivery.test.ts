import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
    DELIVERY_FILE,
    MAX_ATTACHMENT_BYTES,
    PermanentDeliveryError,
    PROCEEDINGS_FILE,
    TRANSCRIPTION_ERROR_FILE,
    composeMessage,
    deliverPending,
    findDeliverable,
    type OutgoingMessage,
    type Poster,
} from '../src/delivery.ts';
import { serializeManifest } from '../src/manifest.ts';
import type { Logger } from '../src/recording-session.ts';

const silentLogger: Logger = { info() {}, warn() {}, error() {} };

class FakePoster implements Poster {
    readonly posts: Array<{ channelId: string; message: OutgoingMessage }> = [];
    failure: Error | undefined;

    async post(channelId: string, message: OutgoingMessage) {
        if (this.failure) throw this.failure;
        this.posts.push({ channelId, message });
        return { messageId: `m${this.posts.length}` };
    }
}

describe('議事録の投稿', () => {
    let dataDir: string;
    beforeEach(async () => {
        dataDir = await mkdtemp(path.join(tmpdir(), 'delivery-'));
    });
    afterEach(async () => {
        await rm(dataDir, { recursive: true, force: true });
    });

    async function session(
        id: string,
        options: { textChannelId?: string | null; utterances?: number } = {}
    ): Promise<string> {
        const directory = path.join(dataDir, 'sessions', 'g', id);
        await mkdir(directory, { recursive: true });
        await writeFile(
            path.join(directory, 'manifest.json'),
            serializeManifest({
                sessionId: id,
                guildId: 'g',
                channelId: 'voice-1',
                textChannelId:
                    options.textChannelId === undefined
                        ? 'text-1'
                        : options.textChannelId,
                startedAt: new Date('2026-11-05T01:00:00Z'),
                endedAt: new Date('2026-11-05T02:00:00Z'),
                utterances: Array.from(
                    { length: options.utterances ?? 2 },
                    (_, i) => ({
                        id: `u${i}`,
                        userId: '1',
                        speaker: '山田',
                        startedAt: new Date('2026-11-05T01:00:00Z'),
                        endedAt: new Date('2026-11-05T01:00:01Z'),
                        file: `u${i}.ogg`,
                    })
                ),
            })
        );
        return directory;
    }

    it('議事録ができたセッションだけを、まだ投稿していなければ投稿する', async () => {
        const ready = await session('20261105T010000Z-00000001');
        await writeFile(
            path.join(ready, PROCEEDINGS_FILE),
            'speaker,date,talk\n'
        );
        await session('20261105T020000Z-00000002'); // 文字起こしがまだ
        const legacy = await session('20261105T030000Z-00000003', {
            textChannelId: null,
        });
        await writeFile(
            path.join(legacy, PROCEEDINGS_FILE),
            'speaker,date,talk\n'
        );

        const poster = new FakePoster();
        assert.equal(
            await deliverPending({ dataDir, poster, logger: silentLogger }),
            1
        );
        assert.equal(poster.posts.length, 1);
        const [post] = poster.posts;
        assert.equal(post?.channelId, 'text-1');
        assert.match(post!.message.content, /<#voice-1>.*発言 2 件/);
        assert.deepEqual(post!.message.file, {
            path: path.join(ready, PROCEEDINGS_FILE),
            name: 'proceedings-20261105T010000Z-00000001.csv',
        });

        const record = JSON.parse(
            await readFile(path.join(ready, DELIVERY_FILE), 'utf8')
        );
        assert.equal(record.status, 'posted');
        assert.equal(record.message_id, 'm1');

        // 二度目は投稿しない
        assert.equal(
            await deliverPending({ dataDir, poster, logger: silentLogger }),
            0
        );
        assert.equal(poster.posts.length, 1);
    });

    it('文字起こしに失敗したセッションは、失敗したことを投稿する', async () => {
        const failed = await session('20261105T010000Z-00000001');
        await writeFile(path.join(failed, TRANSCRIPTION_ERROR_FILE), 'boom\n');
        const poster = new FakePoster();
        await deliverPending({ dataDir, poster, logger: silentLogger });
        assert.match(poster.posts[0]!.message.content, /失敗/);
        assert.equal(poster.posts[0]!.message.file, undefined);
    });

    it('一時的な失敗は次の回にやり直し、やり直しても無駄な失敗は記録してあきらめる', async () => {
        const ready = await session('20261105T010000Z-00000001');
        await writeFile(
            path.join(ready, PROCEEDINGS_FILE),
            'speaker,date,talk\n'
        );
        const poster = new FakePoster();

        poster.failure = new Error('network');
        await deliverPending({ dataDir, poster, logger: silentLogger });
        assert.equal((await findDeliverable(dataDir)).length, 1);

        poster.failure = new PermanentDeliveryError('Missing Access');
        await deliverPending({ dataDir, poster, logger: silentLogger });
        const record = JSON.parse(
            await readFile(path.join(ready, DELIVERY_FILE), 'utf8')
        );
        assert.equal(record.status, 'failed');
        assert.match(record.error, /Missing Access/);
        assert.equal((await findDeliverable(dataDir)).length, 0);
    });

    it('発言が無かったセッションや大きすぎる議事録は添付しない', async () => {
        const base = {
            directory: '/data/sessions/g/s',
            manifest: {
                sessionId: 's',
                channelId: 'v',
                textChannelId: 't',
                startedAt: new Date(0),
                endedAt: new Date(0),
                utteranceCount: 0,
            },
        };
        const empty = composeMessage({
            ...base,
            outcome: { kind: 'ready', csvPath: '/x.csv', csvBytes: 20 },
        });
        assert.match(empty.content, /発言がありませんでした/);
        assert.equal(empty.file, undefined);

        const huge = composeMessage({
            ...base,
            manifest: { ...base.manifest, utteranceCount: 1 },
            outcome: {
                kind: 'ready',
                csvPath: '/x.csv',
                csvBytes: MAX_ATTACHMENT_BYTES + 1,
            },
        });
        assert.match(huge.content, /大きすぎて/);
        assert.equal(huge.file, undefined);
    });

    it('sessions ディレクトリが無ければ何もしない', async () => {
        assert.deepEqual(
            await findDeliverable(path.join(dataDir, 'missing')),
            []
        );
    });
});
