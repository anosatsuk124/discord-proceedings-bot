/** テスト用の最小の Ogg ページ読み取り。CRC の検証もする。 */

import { oggCrc32 } from '../src/ogg-opus.ts';

export interface OggPage {
    readonly headerType: number;
    readonly granulePosition: bigint;
    readonly serialNumber: number;
    readonly sequence: number;
    readonly crcValid: boolean;
    /** このページで完結するパケット(ページをまたぐパケットはテストで扱わない)。 */
    readonly packets: Buffer[];
}

export function parseOggPages(bytes: Buffer): OggPage[] {
    const pages: OggPage[] = [];
    let offset = 0;
    while (offset < bytes.length) {
        if (bytes.toString('ascii', offset, offset + 4) !== 'OggS') {
            throw new Error(`no capture pattern at ${offset}`);
        }
        const segmentCount = bytes.readUInt8(offset + 26);
        const lacing = bytes.subarray(offset + 27, offset + 27 + segmentCount);
        const headerLength = 27 + segmentCount;
        const bodyLength = lacing.reduce((sum, n) => sum + n, 0);
        const page = Buffer.from(
            bytes.subarray(offset, offset + headerLength + bodyLength)
        );
        const storedCrc = page.readUInt32LE(22);
        page.writeUInt32LE(0, 22);

        const packets: Buffer[] = [];
        let packetStart = headerLength;
        let packetLength = 0;
        for (const value of lacing) {
            packetLength += value;
            if (value < 255) {
                packets.push(
                    page.subarray(packetStart, packetStart + packetLength)
                );
                packetStart += packetLength;
                packetLength = 0;
            }
        }

        pages.push({
            headerType: page.readUInt8(5),
            granulePosition: page.readBigUInt64LE(6),
            serialNumber: page.readUInt32LE(14),
            sequence: page.readUInt32LE(18),
            crcValid: oggCrc32(page) === storedCrc,
            packets,
        });
        offset += headerLength + bodyLength;
    }
    return pages;
}

/** Ogg Opus から音声パケット(OpusHead / OpusTags を除く)を取り出す。 */
export function opusAudioPackets(bytes: Buffer): Buffer[] {
    return parseOggPages(bytes)
        .flatMap((page) => page.packets)
        .filter(
            (packet) =>
                !packet.subarray(0, 8).equals(Buffer.from('OpusHead')) &&
                !packet.subarray(0, 8).equals(Buffer.from('OpusTags'))
        );
}
