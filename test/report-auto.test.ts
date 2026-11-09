import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decideAuto } from '../src/report/auto.ts';
import type { SessionInfo, SessionState } from '../src/report/sessions.ts';
import type { ReportRecord } from '../src/report/store.ts';

const HOUR = 3_600_000;
const NOW = new Date('2026-11-09T12:00:00Z');

function ago(hours: number): Date {
    return new Date(NOW.getTime() - hours * HOUR);
}

function session(
    id: string,
    endedHoursAgo: number,
    state: SessionState = 'ready'
): SessionInfo {
    return {
        guildId: 'g',
        sessionId: id,
        channelId: 'v',
        guildName: 'G',
        channelName: 'V',
        textChannelId: 't',
        directory: `/data/sessions/g/${id}`,
        startedAt: ago(endedHoursAgo + 1),
        endedAt: ago(endedHoursAgo),
        utteranceCount: 1,
        state,
    };
}

function record(
    sessionIds: string[],
    createdHoursAgo: number,
    overrides: Partial<ReportRecord> = {}
): ReportRecord {
    return {
        id: `r-${sessionIds.join('-')}`,
        guildId: 'g',
        guildName: 'G',
        trigger: 'auto',
        status: 'announced',
        sessionIds,
        periodLabel: 'x',
        notifyChannelId: 't',
        createdAt: ago(createdHoursAgo).toISOString(),
        path: 'reports/g/x.html',
        ...overrides,
    };
}

function decide(
    sessions: SessionInfo[],
    records: ReportRecord[] = [],
    recording = false
): string[] {
    return decideAuto({
        sessions,
        records,
        recording,
        now: NOW,
        delayMs: 12 * HOUR,
        autoEnabledAt: ago(1000),
    }).map((s) => s.sessionId);
}

describe('自動生成の判定', () => {
    it('まとめていないセッションだけをまとめる(a,b はあり、c,d はなし)', () => {
        const sessions = [
            session('a', 100),
            session('b', 90),
            session('c', 30),
            session('d', 13),
        ];
        assert.deepEqual(
            decide(sessions, [record(['a'], 99), record(['b'], 89)]),
            ['c', 'd']
        );
    });

    it('最後の録音の終了から N 時間たっていなければ作らない', () => {
        assert.deepEqual(decide([session('c', 30), session('d', 11)]), []);
    });

    it('録音中や文字起こし中は作らない', () => {
        assert.deepEqual(decide([session('c', 30)], [], true), []);
        assert.deepEqual(
            decide([session('c', 30), session('d', 20, 'transcribing')]),
            []
        );
    });

    it('処理中のジョブがあれば作らない', () => {
        assert.deepEqual(
            decide(
                [session('c', 30)],
                [record(['z'], 40, { status: 'queued' })]
            ),
            []
        );
    });

    it('最後の終了以降に手動で生成していたら、その回は作らない', () => {
        const sessions = [session('c', 30), session('d', 20)];
        assert.deepEqual(
            decide(sessions, [record(['c'], 5, { trigger: 'manual' })]),
            []
        );
    });

    it('手動生成より後に録音があれば、残りを持ち越して作る', () => {
        const sessions = [session('c', 30), session('d', 20), session('e', 13)];
        assert.deepEqual(
            decide(sessions, [record(['c'], 25, { trigger: 'manual' })]),
            ['d', 'e']
        );
    });

    it('手動の失敗は手動生成とみなさない', () => {
        const sessions = [session('c', 30), session('d', 20)];
        assert.deepEqual(
            decide(sessions, [
                record(['c'], 5, { trigger: 'manual', status: 'failed' }),
            ]),
            ['c', 'd']
        );
    });

    it('自動が失敗したら同じ回ではやり直さない', () => {
        const sessions = [session('c', 30), session('d', 20)];
        assert.deepEqual(
            decide(sessions, [record(['c', 'd'], 5, { status: 'failed' })]),
            []
        );
    });

    it('発言のないセッションや失敗したセッションは対象にしない', () => {
        const sessions = [
            session('c', 30, 'empty'),
            session('d', 20, 'failed'),
            session('e', 13),
        ];
        assert.deepEqual(decide(sessions), ['e']);
    });

    it('機能を有効にする前に終わったセッションは対象にしない', () => {
        const chosen = decideAuto({
            sessions: [session('old', 100), session('new', 13)],
            records: [],
            recording: false,
            now: NOW,
            delayMs: 12 * HOUR,
            autoEnabledAt: ago(50),
        });
        assert.deepEqual(
            chosen.map((s) => s.sessionId),
            ['new']
        );
    });

    it('公開済みのページが index の更新で失敗しても、まとめ済みとして扱う', () => {
        const sessions = [session('c', 30), session('d', 20)];
        assert.deepEqual(
            decide(sessions, [
                record(['c'], 25, {
                    status: 'failed',
                    url: 'https://pager.example/s/x',
                }),
            ]),
            ['d']
        );
    });
});
