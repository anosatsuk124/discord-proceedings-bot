import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
    AudioReceiveStream,
    EndBehaviorType,
    type AudioReceiveStreamOptions,
} from '@discordjs/voice';
import { MANIFEST_FILE } from '../src/manifest.ts';
import {
    RecordingSession,
    type Logger,
    type Receiver,
} from '../src/recording-session.ts';
import { opusAudioPackets } from './ogg.ts';

/** @discordjs/voice の VoiceReceiver の代わり。本物の AudioReceiveStream を返す。 */
class FakeReceiver implements Receiver {
    readonly speaking = new EventEmitter();
    readonly streams = new Map<string, AudioReceiveStream>();

    subscribe(
        userId: string,
        options: Partial<AudioReceiveStreamOptions> = {}
    ): AudioReceiveStream {
        const existing = this.streams.get(userId);
        if (existing) return existing;
        const stream = new AudioReceiveStream({
            end: { behavior: EndBehaviorType.Manual },
            ...options,
        });
        stream.once('close', () => this.streams.delete(userId));
        this.streams.set(userId, stream);
        return stream;
    }

    /** ユーザーが話し始めたときの動き(speaking の start → パケット)をまねる。 */
    speak(userId: string, packets: readonly Buffer[]): AudioReceiveStream {
        this.speaking.emit('start', userId);
        const stream = this.streams.get(userId);
        assert.ok(stream, `user ${userId} is not subscribed`);
        for (const packet of packets) stream.push(packet);
        return stream;
    }
}

const silentLogger: Logger = { info() {}, warn() {}, error() {} };
const packets = opusAudioPackets(
    await readFile(new URL('./fixtures/sine-stereo.opus', import.meta.url))
);

describe('RecordingSession', () => {
    let dataDir: string;
    let receiver: FakeReceiver;

    beforeEach(async () => {
        dataDir = await mkdtemp(path.join(tmpdir(), 'recording-session-'));
        receiver = new FakeReceiver();
    });
    afterEach(async () => {
        await rm(dataDir, { recursive: true, force: true });
    });

    function start(
        overrides: Partial<Parameters<typeof RecordingSession.start>[0]> = {}
    ) {
        return RecordingSession.start({
            receiver,
            dataDir,
            guildId: 'guild-1',
            channelId: 'channel-1',
            silenceDurationMs: 20,
            logger: silentLogger,
            ...overrides,
        });
    }

    async function readManifest(session: RecordingSession) {
        return JSON.parse(
            await readFile(path.join(session.directory, MANIFEST_FILE), 'utf8')
        );
    }

    it('発言ごとに Ogg Opus を書き、manifest に記録する', async () => {
        const session = await start({
            textChannelId: 'text-1',
            resolveSpeaker: async (userId) => `name-of-${userId}`,
        });
        assert.match(
            session.directory,
            /sessions\/guild-1\/\d{8}T\d{6}Z-[0-9a-f]{8}$/
        );

        const stream = receiver.speak('alice', packets);
        await once(stream, 'close'); // 無音で自動的に閉じる
        const manifest = await session.stop();

        assert.equal(manifest.utterances.length, 1);
        const json = await readManifest(session);
        assert.equal(json.version, 1);
        assert.equal(json.session_id, session.id);
        assert.equal(json.guild_id, 'guild-1');
        assert.equal(json.channel_id, 'channel-1');
        assert.equal(json.text_channel_id, 'text-1');
        const [utterance] = json.utterances;
        assert.equal(utterance.user_id, 'alice');
        assert.equal(utterance.speaker, 'name-of-alice');
        assert.equal(utterance.file, `${utterance.id}.ogg`);

        const audio = await readFile(
            path.join(session.directory, utterance.file)
        );
        assert.deepEqual(opusAudioPackets(audio), packets);
    });

    it('stop() は録音中の発言をそこまでで閉じて残す', async () => {
        const session = await start({ silenceDurationMs: 300 });
        receiver.speak('alice', packets.slice(0, 10));
        receiver.speak('bob', packets.slice(10, 20));
        const manifest = await session.stop();

        assert.deepEqual(manifest.utterances.map((u) => u.userId).sort(), [
            'alice',
            'bob',
        ]);
        assert.equal(receiver.streams.size, 0);
    });

    it('stop() のあとに話し始めた人は録音しない', async () => {
        const session = await start();
        await session.stop();
        receiver.speaking.emit('start', 'alice');
        assert.equal(receiver.streams.size, 0);
    });

    it('shouldRecord が false の相手は録音しない', async () => {
        const session = await start({
            shouldRecord: (userId) => userId !== 'music-bot',
        });
        receiver.speaking.emit('start', 'music-bot');
        assert.equal(receiver.streams.size, 0);
        await session.stop();
    });

    it('パケットが 1 つも来なかった発言はファイルごと捨てる', async () => {
        const session = await start();
        const stream = receiver.speak('alice', []);
        stream.push(null);
        const manifest = await session.stop();

        assert.equal(manifest.utterances.length, 0);
        assert.deepEqual(await readdir(session.directory), [MANIFEST_FILE]);
    });

    it('受信ストリームがエラーで閉じても、それまでの音声は残す', async () => {
        const session = await start({ silenceDurationMs: 300 });
        const stream = receiver.speak('alice', packets.slice(0, 5));
        const closed = new Promise((resolve) => stream.once('close', resolve));
        stream.destroy(new Error('failed to decrypt'));
        await closed;
        const manifest = await session.stop();

        assert.equal(manifest.utterances.length, 1);
        const audio = await readFile(
            path.join(session.directory, manifest.utterances[0]!.file)
        );
        assert.deepEqual(opusAudioPackets(audio), packets.slice(0, 5));
    });

    it('表示名の取得に失敗したら userId を使う', async () => {
        const session = await start({
            resolveSpeaker: () => Promise.reject(new Error('unknown member')),
        });
        receiver.speak('alice', packets.slice(0, 3));
        const manifest = await session.stop();
        assert.equal(manifest.utterances[0]?.speaker, 'alice');
    });

    it('manifest の発言は開始時刻順に並ぶ', async () => {
        let clock = 0;
        const session = await start({
            silenceDurationMs: 300,
            now: () => new Date(Date.UTC(2026, 10, 5, 0, 0, clock++)),
        });
        receiver.speak('alice', packets.slice(0, 3));
        receiver.speak('bob', packets.slice(0, 3));
        receiver.speak('carol', packets.slice(0, 3));
        const manifest = await session.stop();
        assert.deepEqual(
            manifest.utterances.map((u) => u.userId),
            ['alice', 'bob', 'carol']
        );
    });
});
