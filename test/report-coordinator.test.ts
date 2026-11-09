import assert from 'node:assert/strict';
import {
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rm,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
    PermanentDeliveryError,
    type OutgoingMessage,
    type Poster,
} from '../src/delivery.ts';
import { serializeManifest } from '../src/manifest.ts';
import type { Logger } from '../src/recording-session.ts';
import { ReportCoordinator } from '../src/report/coordinator.ts';
import {
    JOB_REPORT_FILE,
    JOB_REQUEST_FILE,
    JOB_RESULT_FILE,
    type JobRequest,
    type JobResult,
} from '../src/report/job-files.ts';
import {
    DeployFailedError,
    type Publisher,
    type PublishFile,
} from '../src/report/publisher.ts';
import type { ReportRecord } from '../src/report/store.ts';

const silent: Logger = { info() {}, warn() {}, error() {} };

class FakePoster implements Poster {
    readonly posts: Array<{ channelId: string; content: string }> = [];
    permanentFailures = new Set<string>();

    async post(channelId: string, message: OutgoingMessage) {
        if (this.permanentFailures.has(channelId)) {
            throw new PermanentDeliveryError('no access');
        }
        this.posts.push({ channelId, content: message.content });
        return { messageId: 'm' };
    }
}

class FakePublisher implements Publisher {
    readonly commits: Array<readonly PublishFile[]> = [];
    deployFailures = 0;

    async commit(files: readonly PublishFile[]) {
        this.commits.push(files);
        return `sha${this.commits.length}`;
    }

    async urlsFor(_ref: string, paths: readonly string[]) {
        if (this.deployFailures > 0) {
            this.deployFailures -= 1;
            throw new DeployFailedError('deploy failed');
        }
        return new Map(paths.map((p) => [p, `https://pager.example/${p}`]));
    }
}

const SUCCESS: JobResult = {
    status: 'ok',
    title: '題名',
    lede: '要約',
    participants: ['Alice'],
    utteranceCount: 2,
    startedAt: '2026-11-06T12:00:00.000Z',
    endedAt: '2026-11-06T13:00:00.000Z',
    warnings: [],
};

describe('ReportCoordinator', () => {
    let dataDir: string;
    let jobsDir: string;
    let now: Date;
    let poster: FakePoster;
    let publisher: FakePublisher;
    let recording: boolean;
    let systemChannel: string | null;

    function coordinator(autoDelayMs = 0): ReportCoordinator {
        return new ReportCoordinator({
            dataDir,
            jobsDir,
            timeZone: 'Asia/Tokyo',
            autoDelayMs,
            jobTimeoutMs: 60_000,
            publisher,
            poster,
            isRecording: () => recording,
            announceChannel: async () => systemChannel,
            logger: silent,
            now: () => now,
        });
    }

    async function addSession(
        id: string,
        endedAt: string,
        rows = 'Alice,2026-11-06T21:00:00+09:00,こんにちは\n'
    ): Promise<void> {
        const directory = path.join(dataDir, 'sessions', 'g1', id);
        await mkdir(directory, { recursive: true });
        await writeFile(
            path.join(directory, 'manifest.json'),
            serializeManifest({
                sessionId: id,
                guildId: 'g1',
                channelId: 'v',
                guildName: 'サーバー',
                channelName: 'VC',
                textChannelId: 'text-1',
                startedAt: new Date(new Date(endedAt).getTime() - 3_600_000),
                endedAt: new Date(endedAt),
                utterances: [],
            })
        );
        await writeFile(
            path.join(directory, 'proceedings.csv'),
            `speaker,date,talk\n${rows}`
        );
    }

    async function jobIds(): Promise<string[]> {
        return readdir(jobsDir).catch(() => []);
    }

    async function finishJob(result: JobResult = SUCCESS): Promise<void> {
        const [id] = await jobIds();
        assert.ok(id);
        await writeFile(path.join(jobsDir, id, JOB_REPORT_FILE), '<html>');
        await writeFile(
            path.join(jobsDir, id, JOB_RESULT_FILE),
            JSON.stringify(result)
        );
    }

    async function records(): Promise<ReportRecord[]> {
        const root = path.join(dataDir, 'reports', 'g1');
        const names = await readdir(root);
        const list: ReportRecord[] = [];
        for (const name of names) {
            if (name === 'guild.json') continue;
            list.push(
                JSON.parse(
                    await readFile(path.join(root, name, 'report.json'), 'utf8')
                ) as ReportRecord
            );
        }
        return list;
    }

    beforeEach(async () => {
        dataDir = await mkdtemp(path.join(tmpdir(), 'coordinator-'));
        jobsDir = path.join(dataDir, 'report-jobs');
        now = new Date('2026-11-09T12:00:00Z');
        poster = new FakePoster();
        publisher = new FakePublisher();
        recording = false;
        systemChannel = 'system';
    });

    afterEach(async () => {
        await rm(dataDir, { recursive: true, force: true });
    });

    const manual = {
        guildId: 'g1',
        guildName: 'サーバー',
        channelId: 'text-9',
        selection: { kind: 'pending' as const },
    };

    it('ジョブを作り、公開し、投稿して index を更新する', async () => {
        await addSession('20261106T120000Z-aaaa', '2026-11-06T13:00:00Z');
        const c = coordinator();
        assert.deepEqual(await c.requestManual(manual), {
            kind: 'accepted',
            sessionCount: 1,
        });
        const [id] = await jobIds();
        const request = JSON.parse(
            await readFile(path.join(jobsDir, id!, JOB_REQUEST_FILE), 'utf8')
        ) as JobRequest;
        assert.equal(request.sessions.length, 1);

        await c.tick(); // まだ結果がない
        assert.equal(publisher.commits.length, 0);

        await finishJob();
        await c.tick();

        assert.equal(publisher.commits.length, 2);
        assert.match(
            publisher.commits[0]?.[0]?.path ?? '',
            /^reports\/g1\/2026\/11\/.+\.html$/
        );
        assert.equal(publisher.commits[1]?.[0]?.path, 'reports/g1/index.html');
        assert.match(
            publisher.commits[1]?.[0]?.content.toString() ?? '',
            /題名/
        );
        assert.equal(poster.posts[0]?.channelId, 'text-9');
        assert.match(
            poster.posts[0]?.content ?? '',
            /<https:\/\/pager\.example\/reports\/g1\/2026\/11\/.+>/
        );
        assert.equal(poster.posts[1]?.channelId, 'system');
        assert.match(poster.posts[1]?.content ?? '', /index\.html>/);
        assert.equal((await records())[0]?.status, 'announced');
        assert.deepEqual(await jobIds(), []);
        assert.equal(
            await c.indexUrl('g1'),
            'https://pager.example/reports/g1/index.html'
        );
    });

    it('index の URL は最初の 1 回だけ投稿する', async () => {
        await addSession('20261106T120000Z-aaaa', '2026-11-06T13:00:00Z');
        const c = coordinator();
        await c.requestManual(manual);
        await finishJob();
        await c.tick();
        now = new Date('2026-11-10T12:00:00Z');
        await addSession('20261107T120000Z-bbbb', '2026-11-07T13:00:00Z');
        await c.requestManual(manual);
        await finishJob();
        await c.tick();
        assert.equal(
            poster.posts.filter((p) => p.channelId === 'system').length,
            1
        );
        assert.equal(poster.posts.length, 3);
    });

    it('システムチャンネルが使えなければ投稿先のチャンネルに知らせる', async () => {
        systemChannel = null;
        await addSession('20261106T120000Z-aaaa', '2026-11-06T13:00:00Z');
        const c = coordinator();
        await c.requestManual(manual);
        await finishJob();
        await c.tick();
        assert.equal(poster.posts[1]?.channelId, 'text-9');
    });

    it('システムチャンネルに権限がなくても投稿先に知らせる', async () => {
        poster.permanentFailures.add('system');
        await addSession('20261106T120000Z-aaaa', '2026-11-06T13:00:00Z');
        const c = coordinator();
        await c.requestManual(manual);
        await finishJob();
        await c.tick();
        assert.match(poster.posts[1]?.content ?? '', /入口ページ/);
        assert.equal(poster.posts[1]?.channelId, 'text-9');
    });

    it('処理中は別のジョブを受け付けない', async () => {
        await addSession('20261106T120000Z-aaaa', '2026-11-06T13:00:00Z');
        const c = coordinator();
        await c.requestManual(manual);
        assert.deepEqual(await c.requestManual(manual), { kind: 'busy' });
    });

    it('対象がなければ empty', async () => {
        assert.deepEqual(await coordinator().requestManual(manual), {
            kind: 'empty',
        });
    });

    it('期間指定はまとめ済みのセッションも対象にする', async () => {
        await addSession('20261106T120000Z-aaaa', '2026-11-06T13:00:00Z');
        const c = coordinator();
        await c.requestManual(manual);
        await finishJob();
        await c.tick();
        assert.deepEqual(await c.requestManual(manual), { kind: 'empty' });
        const outcome = await c.requestManual({
            ...manual,
            selection: {
                kind: 'range',
                range: {
                    start: new Date('2026-11-06T00:00:00Z'),
                    end: new Date('2026-11-07T00:00:00Z'),
                    label: '指定',
                },
            },
        });
        assert.deepEqual(outcome, { kind: 'accepted', sessionCount: 1 });
    });

    it('worker の失敗はチャンネルに知らせ、まとめ済みにしない', async () => {
        await addSession('20261106T120000Z-aaaa', '2026-11-06T13:00:00Z');
        const c = coordinator();
        await c.requestManual(manual);
        await finishJob({ status: 'failed', error: 'LLM が失敗' });
        await c.tick();
        assert.equal((await records())[0]?.status, 'failed');
        assert.match(poster.posts[0]?.content ?? '', /失敗.*LLM が失敗/);
        assert.deepEqual(await c.requestManual(manual), {
            kind: 'accepted',
            sessionCount: 1,
        });
    });

    it('時間内に結果がなければ失敗にする', async () => {
        await addSession('20261106T120000Z-aaaa', '2026-11-06T13:00:00Z');
        const c = coordinator();
        await c.requestManual(manual);
        now = new Date(now.getTime() + 120_000);
        await c.tick();
        assert.equal((await records())[0]?.status, 'failed');
        assert.match(poster.posts[0]?.content ?? '', /report-worker/);
        assert.deepEqual(await jobIds(), []);
    });

    it('デプロイが失敗したら待ってからコミットをやり直す', async () => {
        await addSession('20261106T120000Z-aaaa', '2026-11-06T13:00:00Z');
        publisher.deployFailures = 1;
        const c = coordinator();
        await c.requestManual(manual);
        await finishJob();
        await c.tick();
        assert.equal(publisher.commits.length, 1);
        assert.equal((await records())[0]?.status, 'rendered');
        assert.equal(poster.posts.length, 0);

        await c.tick(); // 待ち時間のあいだは何もしない
        assert.equal(publisher.commits.length, 1);

        now = new Date(now.getTime() + 10 * 60_000);
        await c.tick();
        assert.equal(publisher.commits.length, 3);
        assert.equal((await records())[0]?.status, 'announced');
    });

    it('再起動しても途中から続く', async () => {
        await addSession('20261106T120000Z-aaaa', '2026-11-06T13:00:00Z');
        await coordinator().requestManual(manual);
        await finishJob();
        await coordinator().tick();
        assert.equal((await records())[0]?.status, 'announced');
        assert.equal(publisher.commits.length, 2);
    });

    it('自動生成は最新セッションのチャンネルに投稿する', async () => {
        now = new Date('2026-11-06T13:30:00Z');
        const c = coordinator(12 * 3_600_000);
        await c.tick(); // 有効にした時刻を記録する
        await addSession('20261106T140000Z-aaaa', '2026-11-06T15:00:00Z');
        now = new Date('2026-11-07T04:00:00Z');
        await c.tick();
        assert.equal((await jobIds()).length, 1);
        now = new Date('2026-11-07T04:00:30Z');
        await finishJob();
        await c.tick();
        assert.equal(poster.posts[0]?.channelId, 'text-1');
        // 同じ回の自動生成は繰り返さない(判定が走る時刻まで進める)
        now = new Date('2026-11-07T04:10:00Z');
        await c.tick();
        assert.deepEqual(await jobIds(), []);
    });

    it('録音中は自動生成しない', async () => {
        now = new Date('2026-11-06T13:30:00Z');
        const c = coordinator(12 * 3_600_000);
        await c.tick();
        await addSession('20261106T140000Z-aaaa', '2026-11-06T15:00:00Z');
        now = new Date('2026-11-07T04:00:00Z');
        recording = true;
        await c.tick();
        assert.deepEqual(await jobIds(), []);
    });

    it('自動生成の判定は 5 分おきにする', async () => {
        now = new Date('2026-11-06T13:30:00Z');
        const c = coordinator(12 * 3_600_000);
        await c.tick();
        await addSession('20261106T140000Z-aaaa', '2026-11-06T15:00:00Z');
        now = new Date('2026-11-07T04:00:00Z');
        await c.tick();
        await rm(jobsDir, { recursive: true, force: true });
        await rm(path.join(dataDir, 'reports', 'g1'), { recursive: true });
        await c.tick(); // 直後は判定しない
        assert.deepEqual(await jobIds(), []);
        now = new Date('2026-11-07T04:06:00Z');
        await c.tick();
        assert.equal((await jobIds()).length, 1);
    });
});
