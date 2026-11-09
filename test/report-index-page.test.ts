import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadIndexAssets, renderIndexPage } from '../src/report/index-page.ts';

describe('index ページ', () => {
    it('月ごとに新しい順で並べ、値をエスケープする', async () => {
        const html = renderIndexPage(await loadIndexAssets(), {
            guildName: '<b>サーバー</b>',
            timeZone: 'Asia/Tokyo',
            updatedAt: new Date('2026-11-09T00:00:00Z'),
            entries: [
                {
                    url: 'https://pager.example/s/old',
                    title: '十月の会話',
                    lede: '要約 A',
                    startedAt: '2026-10-01T12:00:00Z',
                    endedAt: '2026-10-01T13:00:00Z',
                    sessionCount: 1,
                    participants: ['Alice'],
                },
                {
                    url: 'https://pager.example/s/new',
                    title: '十一月の<script>',
                    lede: '要約 B',
                    startedAt: '2026-11-06T12:00:00Z',
                    endedAt: '2026-11-06T13:00:00Z',
                    sessionCount: 2,
                    participants: ['Alice', 'Bob'],
                },
            ],
        });
        assert.ok(html.indexOf('2026年11月') < html.indexOf('2026年10月'));
        assert.match(html, /&lt;b&gt;サーバー&lt;\/b&gt;/);
        assert.match(html, /十一月の&lt;script&gt;/);
        assert.doesNotMatch(html, /<script/);
        assert.match(html, /href="https:\/\/pager\.example\/s\/new"/);
        assert.match(html, /録音 2 件 \/ 参加者: Alice、Bob/);
    });

    it('記録が無くても作れる', async () => {
        const html = renderIndexPage(await loadIndexAssets(), {
            guildName: null,
            timeZone: 'Asia/Tokyo',
            updatedAt: new Date(),
            entries: [],
        });
        assert.match(html, /まだ議事録はありません/);
    });
});
