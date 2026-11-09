import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    PeriodError,
    parseRange,
    parseSelection,
    resolvePeriod,
    yearMonthOf,
    zonedTime,
} from '../src/report/period.ts';

const TOKYO = 'Asia/Tokyo';
/** 2026-11-09(月)10:30 JST */
const NOW = new Date('2026-11-09T01:30:00Z');

function iso(date: Date): string {
    return date.toISOString();
}

describe('コマンドのオプションの解釈', () => {
    const none = { period: null, from: null, to: null };

    it('何も指定されていなければ誤りにする', () => {
        assert.throws(
            () => parseSelection(none, NOW, TOKYO),
            (error: unknown) =>
                error instanceof PeriodError && /period/.test(error.message)
        );
    });

    it('pending を選んだときだけ、まとめていない録音を対象にする', () => {
        assert.deepEqual(
            parseSelection({ ...none, period: 'pending' }, NOW, TOKYO),
            { kind: 'pending' }
        );
    });

    it('today はその日の範囲になる', () => {
        const selection = parseSelection(
            { ...none, period: 'today' },
            NOW,
            TOKYO
        );
        assert.equal(selection.kind, 'range');
        assert.equal(
            selection.kind === 'range' && selection.range.label,
            '今日'
        );
    });

    it('from は範囲になる', () => {
        const selection = parseSelection(
            { ...none, from: '2026-11-06', to: '2026-11-07' },
            NOW,
            TOKYO
        );
        assert.equal(selection.kind, 'range');
    });

    it('period と from の併用、from のない to は誤りにする', () => {
        assert.throws(
            () =>
                parseSelection(
                    { period: 'today', from: '2026-11-06', to: null },
                    NOW,
                    TOKYO
                ),
            PeriodError
        );
        assert.throws(
            () => parseSelection({ ...none, to: '2026-11-07' }, NOW, TOKYO),
            PeriodError
        );
    });
});

describe('期間の名前の解決(JST)', () => {
    it('today はその日の 0 時から翌日の 0 時まで', () => {
        const range = resolvePeriod('today', NOW, TOKYO);
        assert.equal(iso(range.start), '2026-11-08T15:00:00.000Z');
        assert.equal(iso(range.end), '2026-11-09T15:00:00.000Z');
    });

    it('UTC では前日でも JST の日付で区切る', () => {
        // 2026-11-09 00:30 JST は UTC では 11/8
        const range = resolvePeriod(
            'today',
            new Date('2026-11-08T15:30:00Z'),
            TOKYO
        );
        assert.equal(iso(range.start), '2026-11-08T15:00:00.000Z');
    });

    it('yesterday と recent 24h', () => {
        assert.equal(
            iso(resolvePeriod('yesterday', NOW, TOKYO).start),
            '2026-11-07T15:00:00.000Z'
        );
        const recent = resolvePeriod('recent-24h', NOW, TOKYO);
        assert.equal(iso(recent.start), '2026-11-08T01:30:00.000Z');
        assert.equal(iso(recent.end), iso(NOW));
    });

    it('週は月曜から始まる', () => {
        const thisWeek = resolvePeriod('this-week', NOW, TOKYO);
        assert.equal(iso(thisWeek.start), '2026-11-08T15:00:00.000Z');
        assert.equal(iso(thisWeek.end), '2026-11-15T15:00:00.000Z');
        const sunday = new Date('2026-11-08T03:00:00Z'); // 11/8(日)12:00 JST
        assert.equal(
            iso(resolvePeriod('this-week', sunday, TOKYO).start),
            '2026-11-01T15:00:00.000Z'
        );
        assert.equal(
            iso(resolvePeriod('last-week', NOW, TOKYO).start),
            '2026-11-01T15:00:00.000Z'
        );
    });

    it('this month は年をまたいでもよい', () => {
        const december = new Date('2026-12-10T00:00:00Z');
        const range = resolvePeriod('this-month', december, TOKYO);
        assert.equal(iso(range.start), '2026-11-30T15:00:00.000Z');
        assert.equal(iso(range.end), '2026-12-31T15:00:00.000Z');
    });

    it('夏時間のあるタイムゾーンでも壁時計どおりになる', () => {
        // 2026-03-08 に米国東部は夏時間に入る
        assert.equal(
            iso(zonedTime('America/New_York', 2026, 3, 8, 12)),
            '2026-03-08T16:00:00.000Z'
        );
        assert.equal(
            iso(zonedTime('America/New_York', 2026, 3, 7, 12)),
            '2026-03-07T17:00:00.000Z'
        );
    });
});

describe('from と to の解釈', () => {
    it('to が日付だけならその日の終わりまで含める', () => {
        const range = parseRange('2026-11-06 21:00', '2026-11-07', NOW, TOKYO);
        assert.equal(iso(range.start), '2026-11-06T12:00:00.000Z');
        assert.equal(iso(range.end), '2026-11-07T15:00:00.000Z');
    });

    it('to を時刻まで書いたらその時刻まで、省略したら現在まで', () => {
        assert.equal(
            iso(parseRange('2026-11-06', '2026-11-06 22:30', NOW, TOKYO).end),
            '2026-11-06T13:30:00.000Z'
        );
        assert.equal(
            iso(parseRange('2026-11-06', null, NOW, TOKYO).end),
            iso(NOW)
        );
    });

    it('引用符やスラッシュ区切りも受け付ける', () => {
        const range = parseRange('"2026/11/06 21:00"', null, NOW, TOKYO);
        assert.equal(iso(range.start), '2026-11-06T12:00:00.000Z');
    });

    it('不正な指定は PeriodError', () => {
        for (const [from, to] of [
            ['きのう', null],
            ['2026-02-30', null],
            ['2026-11-06 25:00', null],
            ['2026-11-07', '2026-11-06'],
        ] as const) {
            assert.throws(() => parseRange(from, to, NOW, TOKYO), PeriodError);
        }
    });
});

describe('yearMonthOf', () => {
    it('タイムゾーンでの年月を返す', () => {
        assert.deepEqual(yearMonthOf(new Date('2026-11-30T16:00:00Z'), TOKYO), {
            year: '2026',
            month: '12',
        });
    });
});
