import { Transform, type TransformCallback } from 'node:stream';
import { randomInt } from 'node:crypto';

/**
 * Opus パケットの列を Ogg Opus (RFC 3533 / RFC 7845) のバイト列に包む。
 *
 * Discord から受け取った Opus パケットを再エンコードせずにそのまま保存するために使う。
 * 書き込み側は 1 チャンク = 1 Opus パケットの Buffer を渡す(objectMode)。
 */

const OPUS_SAMPLE_RATE = 48_000;
const MAX_SEGMENTS_PER_PAGE = 255;

const HEADER_TYPE_BOS = 0x02;
const HEADER_TYPE_EOS = 0x04;

export interface OggOpusWriterOptions {
    /** OpusHead に書くチャンネル数。Discord の音声はステレオ。 */
    readonly channelCount?: number;
    /** 1 ページに入れるパケット数の上限。Discord の 20ms パケットなら 50 で約 1 秒。 */
    readonly maxPacketsPerPage?: number;
    /** Ogg の論理ビットストリームのシリアル番号。省略時は乱数。 */
    readonly serialNumber?: number;
    /** OpusTags に書くベンダー文字列。 */
    readonly vendor?: string;
}

export class OggOpusWriter extends Transform {
    readonly #serialNumber: number;
    readonly #maxPacketsPerPage: number;
    #pageSequence = 0;
    #granulePosition = 0n;
    #pendingPackets: Buffer[] = [];
    #pendingSegments = 0;
    #packetCount = 0;

    constructor(options: OggOpusWriterOptions = {}) {
        super({ writableObjectMode: true });
        this.#serialNumber = options.serialNumber ?? randomInt(0, 2 ** 32);
        this.#maxPacketsPerPage = options.maxPacketsPerPage ?? 50;
        this.push(
            this.#page(
                [opusHead(options.channelCount ?? 2)],
                0n,
                HEADER_TYPE_BOS
            )
        );
        this.push(
            this.#page(
                [opusTags(options.vendor ?? 'discord-proceedings-bot')],
                0n,
                0
            )
        );
    }

    /** これまでに受け取った(空でない)Opus パケットの数。 */
    get packetCount(): number {
        return this.#packetCount;
    }

    override _transform(
        packet: unknown,
        _encoding: BufferEncoding,
        callback: TransformCallback
    ): void {
        if (!Buffer.isBuffer(packet)) {
            callback(new TypeError('OggOpusWriter accepts Buffer chunks only'));
            return;
        }
        if (packet.length === 0) {
            callback();
            return;
        }
        const segments = laceSegmentCount(packet.length);
        if (segments > MAX_SEGMENTS_PER_PAGE) {
            callback(
                new RangeError(`Opus packet too large: ${packet.length} bytes`)
            );
            return;
        }
        if (
            this.#pendingPackets.length >= this.#maxPacketsPerPage ||
            this.#pendingSegments + segments > MAX_SEGMENTS_PER_PAGE
        ) {
            this.#flushPage(0);
        }
        this.#pendingPackets.push(packet);
        this.#pendingSegments += segments;
        this.#granulePosition += BigInt(opusPacketSampleCount(packet));
        this.#packetCount += 1;
        callback();
    }

    override _flush(callback: TransformCallback): void {
        // 最後のページには EOS を立てる。残りのパケットが無ければ空の EOS ページになる。
        this.#flushPage(HEADER_TYPE_EOS);
        callback();
    }

    #flushPage(headerType: number): void {
        this.push(
            this.#page(this.#pendingPackets, this.#granulePosition, headerType)
        );
        this.#pendingPackets = [];
        this.#pendingSegments = 0;
    }

    #page(
        packets: readonly Buffer[],
        granulePosition: bigint,
        headerType: number
    ): Buffer {
        const lacing: number[] = [];
        for (const packet of packets) {
            let remaining = packet.length;
            while (remaining >= 255) {
                lacing.push(255);
                remaining -= 255;
            }
            lacing.push(remaining);
        }

        const header = Buffer.alloc(27 + lacing.length);
        header.write('OggS', 0, 'ascii');
        header.writeUInt8(0, 4); // stream_structure_version
        header.writeUInt8(headerType, 5);
        header.writeBigUInt64LE(granulePosition, 6);
        header.writeUInt32LE(this.#serialNumber, 14);
        header.writeUInt32LE(this.#pageSequence, 18);
        header.writeUInt32LE(0, 22); // CRC は全体を組み立ててから入れる
        header.writeUInt8(lacing.length, 26);
        Buffer.from(lacing).copy(header, 27);
        this.#pageSequence += 1;

        const page = Buffer.concat([header, ...packets]);
        page.writeUInt32LE(oggCrc32(page), 22);
        return page;
    }
}

/** パケット長 length を Ogg のレーシング値で表したときのセグメント数。 */
function laceSegmentCount(length: number): number {
    return Math.floor(length / 255) + 1;
}

function opusHead(channelCount: number): Buffer {
    const head = Buffer.alloc(19);
    head.write('OpusHead', 0, 'ascii');
    head.writeUInt8(1, 8); // version
    head.writeUInt8(channelCount, 9);
    head.writeUInt16LE(0, 10); // pre-skip
    head.writeUInt32LE(OPUS_SAMPLE_RATE, 12); // input sample rate
    head.writeInt16LE(0, 16); // output gain
    head.writeUInt8(0, 18); // channel mapping family
    return head;
}

function opusTags(vendor: string): Buffer {
    const vendorBytes = Buffer.from(vendor, 'utf8');
    const tags = Buffer.alloc(8 + 4 + vendorBytes.length + 4);
    tags.write('OpusTags', 0, 'ascii');
    tags.writeUInt32LE(vendorBytes.length, 8);
    vendorBytes.copy(tags, 12);
    tags.writeUInt32LE(0, 12 + vendorBytes.length); // user comment list length
    return tags;
}

/**
 * Opus パケット 1 つに入っている 48kHz 換算のサンプル数を TOC バイトから求める (RFC 6716 3.1)。
 */
export function opusPacketSampleCount(packet: Uint8Array): number {
    const toc = packet[0];
    if (toc === undefined) return 0;
    const config = toc >> 3;
    let frameSize: number; // 48kHz でのサンプル数
    if (config < 12) {
        // SILK: 10, 20, 40, 60 ms
        frameSize = [480, 960, 1920, 2880][config % 4]!;
    } else if (config < 16) {
        // Hybrid: 10, 20 ms
        frameSize = config % 2 === 0 ? 480 : 960;
    } else {
        // CELT: 2.5, 5, 10, 20 ms
        frameSize = [120, 240, 480, 960][config % 4]!;
    }
    let frameCount: number;
    switch (toc & 0x03) {
        case 0:
            frameCount = 1;
            break;
        case 1:
        case 2:
            frameCount = 2;
            break;
        default:
            frameCount = (packet[1] ?? 0) & 0x3f;
    }
    return frameSize * frameCount;
}

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let r = i << 24;
        for (let bit = 0; bit < 8; bit++) {
            r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
        }
        table[i] = r >>> 0;
    }
    return table;
})();

/** Ogg のページで使う CRC-32 (多項式 0x04c11db7、初期値 0、反転なし)。 */
export function oggCrc32(bytes: Uint8Array): number {
    let crc = 0;
    for (const byte of bytes) {
        crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]!) >>> 0;
    }
    return crc;
}
