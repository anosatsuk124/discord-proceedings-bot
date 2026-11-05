import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { AutoLeaveTimers } from '../src/auto-leave.ts';

describe('AutoLeaveTimers', () => {
    it('人がいなくなってから待ち時間が過ぎたら退出する', (t) => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const expired: string[] = [];
        const timers = new AutoLeaveTimers(60_000, (guildId) =>
            expired.push(guildId)
        );

        timers.update('g', false);
        t.mock.timers.tick(59_999);
        assert.deepEqual(expired, []);
        // 出入りがあってもタイマーは延びない
        timers.update('g', false);
        t.mock.timers.tick(1);
        assert.deepEqual(expired, ['g']);
        assert.equal(timers.isPending('g'), false);
    });

    it('待っているあいだに誰かが戻ってきたら取り消す', (t) => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const onExpire = mock.fn();
        const timers = new AutoLeaveTimers(60_000, onExpire);

        timers.update('g', false);
        t.mock.timers.tick(30_000);
        timers.update('g', true);
        t.mock.timers.tick(60_000);
        assert.equal(onExpire.mock.callCount(), 0);
    });

    it('待ち時間が 0 なら自動では退出しない', (t) => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const onExpire = mock.fn();
        const timers = new AutoLeaveTimers(0, onExpire);
        timers.update('g', false);
        t.mock.timers.tick(1_000_000);
        assert.equal(onExpire.mock.callCount(), 0);
        assert.equal(timers.isPending('g'), false);
    });

    it('cancelAll ですべて止める', (t) => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const onExpire = mock.fn();
        const timers = new AutoLeaveTimers(1000, onExpire);
        timers.update('a', false);
        timers.update('b', false);
        timers.cancelAll();
        t.mock.timers.tick(2000);
        assert.equal(onExpire.mock.callCount(), 0);
    });
});
