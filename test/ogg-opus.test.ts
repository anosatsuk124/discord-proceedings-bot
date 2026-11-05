import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';
import {
    OggOpusWriter,
    oggCrc32,
    opusPacketSampleCount,
} from '../src/ogg-opus.ts';
import { opusAudioPackets, parseOggPages } from './ogg.ts';

const fixture = new URL('./fixtures/sine-stereo.opus', import.meta.url);
const ffprobeAvailable = await hasFfprobe();

async function mux(
    packets: Buffer[],
    options?: ConstructorParameters<typeof OggOpusWriter>[0]
): Promise<Buffer> {
    return buffer(
        Readable.from(packets, { objectMode: true }).pipe(
            new OggOpusWriter(options)
        )
    );
}

describe('oggCrc32', () => {
    it('ffmpeg が書いた Ogg ページの CRC と一致する', async () => {
        const pages = parseOggPages(await readFile(fixture));
        assert.ok(pages.length > 2);
        for (const page of pages) {
            assert.ok(page.crcValid, `page ${page.sequence}`);
        }
    });

    it('空の入力では 0', () => {
        assert.equal(oggCrc32(new Uint8Array()), 0);
    });
});

describe('opusPacketSampleCount', () => {
    it('20ms の CELT フレーム 1 つは 960 サンプル', () => {
        // config 31 (CELT FB 20ms), code 0
        assert.equal(opusPacketSampleCount(Uint8Array.of(31 << 3)), 960);
    });

    it('Discord の無音フレーム (0xf8 0xff 0xfe) は 960 サンプル', () => {
        assert.equal(
            opusPacketSampleCount(Uint8Array.of(0xf8, 0xff, 0xfe)),
            960
        );
    });

    it('code 3 はフレーム数をバイト 1 から読む', () => {
        // config 0 (SILK NB 10ms) を 3 フレーム
        assert.equal(opusPacketSampleCount(Uint8Array.of(0x03, 0x03)), 1440);
    });

    it('2 フレームのパケット', () => {
        // config 16 (CELT NB 2.5ms), code 1
        assert.equal(opusPacketSampleCount(Uint8Array.of((16 << 3) | 1)), 240);
    });
});

describe('OggOpusWriter', () => {
    it('パケットをそのまま運び、ヘッダーと EOS を正しく付ける', async () => {
        const packets = opusAudioPackets(await readFile(fixture));
        const bytes = await mux(packets, {
            serialNumber: 42,
            maxPacketsPerPage: 10,
        });
        const pages = parseOggPages(bytes);

        assert.ok(pages.every((page) => page.crcValid));
        assert.ok(pages.every((page) => page.serialNumber === 42));
        assert.deepEqual(
            pages.map((page) => page.sequence),
            pages.map((_, i) => i)
        );
        assert.equal(pages[0]?.headerType, 0x02); // BOS
        assert.equal(pages.at(-1)?.headerType, 0x04); // EOS
        assert.ok(
            pages[0]?.packets[0]?.subarray(0, 8).equals(Buffer.from('OpusHead'))
        );
        assert.ok(
            pages[1]?.packets[0]?.subarray(0, 8).equals(Buffer.from('OpusTags'))
        );

        assert.deepEqual(opusAudioPackets(bytes), packets);
        const expectedSamples = packets.reduce(
            (sum, packet) => sum + opusPacketSampleCount(packet),
            0
        );
        assert.equal(pages.at(-1)?.granulePosition, BigInt(expectedSamples));
        for (const page of pages.slice(2)) {
            assert.ok(page.packets.length <= 10);
        }
    });

    it('空のパケットは捨てる', async () => {
        const writer = new OggOpusWriter();
        const bytes = buffer(writer);
        writer.write(Buffer.alloc(0));
        writer.write(Buffer.from([0xf8, 0xff, 0xfe]));
        writer.end();
        await bytes;
        assert.equal(writer.packetCount, 1);
    });

    it(
        'ffmpeg で読める',
        { skip: !ffprobeAvailable && 'ffprobe が見つからない' },
        async () => {
            const packets = opusAudioPackets(await readFile(fixture));
            const directory = await mkdtemp(path.join(tmpdir(), 'ogg-opus-'));
            try {
                const file = path.join(directory, 'roundtrip.ogg');
                await writeFile(file, await mux(packets));
                const { stdout, stderr } = await promisify(execFile)(
                    'ffprobe',
                    [
                        '-v',
                        'error',
                        '-show_entries',
                        'stream=codec_name,channels,sample_rate:format=duration',
                        '-of',
                        'json',
                        file,
                    ]
                );
                assert.equal(stderr, '');
                const probe = JSON.parse(stdout);
                assert.equal(probe.streams[0].codec_name, 'opus');
                assert.equal(probe.streams[0].channels, 2);
                assert.ok(Math.abs(Number(probe.format.duration) - 1.5) < 0.1);
            } finally {
                await rm(directory, { recursive: true, force: true });
            }
        }
    );
});

async function hasFfprobe(): Promise<boolean> {
    try {
        await promisify(execFile)('ffprobe', ['-version']);
        return true;
    } catch {
        return false;
    }
}
