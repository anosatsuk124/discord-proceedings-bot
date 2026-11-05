import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyUdpPacket, formatPacketCounts } from '../src/voice-debug.ts';

function rtpHeader(secondByte: number, ssrc: number): Buffer {
    const header = Buffer.alloc(12);
    header[0] = 0x80; // version 2
    header[1] = secondByte;
    header.writeUInt32BE(ssrc, 8);
    return Buffer.concat([header, Buffer.alloc(20)]);
}

describe('classifyUdpPacket', () => {
    it('音声の RTP は SSRC と payload type で分ける', () => {
        assert.equal(
            classifyUdpPacket(rtpHeader(120, 4861)),
            'rtp ssrc=4861 pt=120'
        );
        // marker ビットが立っていても payload type は同じ。
        assert.equal(
            classifyUdpPacket(rtpHeader(0x80 | 120, 4861)),
            'rtp ssrc=4861 pt=120'
        );
    });

    it('RTCP と、keepalive の応答などそれ以外を見分ける', () => {
        assert.equal(classifyUdpPacket(rtpHeader(200, 1)), 'rtcp');
        assert.equal(classifyUdpPacket(Buffer.alloc(8)), 'other 8B');
        assert.equal(classifyUdpPacket(Buffer.alloc(74)), 'other 74B');
    });
});

describe('formatPacketCounts', () => {
    it('合計と種類ごとの数を出す', () => {
        assert.equal(formatPacketCounts(new Map()), 'none');
        assert.equal(
            formatPacketCounts(
                new Map([
                    ['rtp ssrc=4861 pt=120', 248],
                    ['other 8B', 1],
                ])
            ),
            '249 (other 8B: 1, rtp ssrc=4861 pt=120: 248)'
        );
    });
});
