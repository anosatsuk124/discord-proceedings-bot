import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { parseSessionStart, purgeExpiredRecordings } from '../src/retention.ts';
import type { Logger } from '../src/recording-session.ts';

const silentLogger: Logger = { info() {}, warn() {}, error() {} };
const now = () => new Date('2026-12-10T00:00:00Z');

describe('録音の保存期間', () => {
    let dataDir: string;
    beforeEach(async () => {
        dataDir = await mkdtemp(path.join(tmpdir(), 'retention-'));
    });
    afterEach(async () => {
        await rm(dataDir, { recursive: true, force: true });
    });

    async function session(id: string, files: string[]): Promise<string> {
        const directory = path.join(dataDir, 'sessions', 'g', id);
        await mkdir(directory, { recursive: true });
        for (const file of files)
            await writeFile(path.join(directory, file), '');
        return directory;
    }

    it('期間を過ぎたセッションの音声だけを消し、議事録と manifest は残す', async () => {
        const old = await session('20261105T000000Z-00000001', [
            'a.ogg',
            'b.ogg',
            'manifest.json',
            'proceedings.csv',
        ]);
        const recent = await session('20261201T000000Z-00000002', [
            'c.ogg',
            'manifest.json',
        ]);
        const orphan = await session('20261001T000000Z-00000003', ['d.ogg']);

        const result = await purgeExpiredRecordings({
            dataDir,
            retentionDays: 30,
            now,
            logger: silentLogger,
        });
        assert.deepEqual(result, { deletedFiles: 3, deletedDirectories: 1 });
        assert.deepEqual((await readdir(old)).sort(), [
            'manifest.json',
            'proceedings.csv',
        ]);
        assert.deepEqual((await readdir(recent)).sort(), [
            'c.ogg',
            'manifest.json',
        ]);
        await assert.rejects(readdir(orphan), { code: 'ENOENT' });
    });

    it('0 日なら何も消さない', async () => {
        const old = await session('20200101T000000Z-00000001', ['a.ogg']);
        await purgeExpiredRecordings({
            dataDir,
            retentionDays: 0,
            now,
            logger: silentLogger,
        });
        assert.deepEqual(await readdir(old), ['a.ogg']);
    });

    it('セッション ID から開始時刻を読む', () => {
        assert.deepEqual(
            parseSessionStart('20261105T080102Z-deadbeef'),
            new Date('2026-11-05T08:01:02Z')
        );
        assert.equal(parseSessionStart('not-a-session'), null);
    });
});
