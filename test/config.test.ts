import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { ConfigError, loadConfig } from '../src/config.ts';
import { newSessionId, serializeManifest } from '../src/manifest.ts';

describe('loadConfig', () => {
    it('DISCORD_TOKEN が無ければエラー', () => {
        assert.throws(() => loadConfig({}), ConfigError);
        assert.throws(() => loadConfig({ DISCORD_TOKEN: '  ' }), ConfigError);
    });

    it('既定値', () => {
        const config = loadConfig({ DISCORD_TOKEN: 'token' });
        assert.equal(config.discordToken, 'token');
        assert.equal(config.dataDir, path.resolve('data'));
        assert.equal(config.silenceDurationMs, 1000);
        assert.equal(config.autoLeaveDelayMs, 60_000);
        assert.equal(config.retentionDays, 30);
    });

    it('環境変数で上書きできる', () => {
        const config = loadConfig({
            DISCORD_TOKEN: 'token',
            DATA_DIR: '/data',
            SILENCE_DURATION_MS: '1500',
            AUTO_LEAVE_DELAY_SECONDS: '0',
            RECORDING_RETENTION_DAYS: '7',
        });
        assert.equal(config.dataDir, '/data');
        assert.equal(config.silenceDurationMs, 1500);
        assert.equal(config.autoLeaveDelayMs, 0);
        assert.equal(config.retentionDays, 7);
    });

    it('自動退出と保存期間は 0 以上の整数だけ受け付ける', () => {
        for (const name of [
            'AUTO_LEAVE_DELAY_SECONDS',
            'RECORDING_RETENTION_DAYS',
        ]) {
            for (const value of ['-1', '1.5', 'abc']) {
                assert.throws(
                    () => loadConfig({ DISCORD_TOKEN: 'token', [name]: value }),
                    ConfigError,
                    `${name}=${value}`
                );
            }
        }
    });

    it('SILENCE_DURATION_MS は正の整数だけ受け付ける', () => {
        for (const value of ['0', '-1', '1.5', 'abc']) {
            assert.throws(
                () =>
                    loadConfig({
                        DISCORD_TOKEN: 'token',
                        SILENCE_DURATION_MS: value,
                    }),
                ConfigError,
                value
            );
        }
    });
});

describe('manifest', () => {
    it('セッション ID は UTC の時刻とランダムな接尾辞', () => {
        assert.equal(
            newSessionId(new Date('2026-11-05T08:01:02.345Z'), 'deadbeef'),
            '20261105T080102Z-deadbeef'
        );
    });

    it('recognizer が読む snake_case の JSON に書き出す', () => {
        const json = JSON.parse(
            serializeManifest({
                sessionId: 's',
                guildId: 'g',
                channelId: 'c',
                textChannelId: 't',
                startedAt: new Date('2026-11-05T00:00:00Z'),
                endedAt: new Date('2026-11-05T01:00:00Z'),
                utterances: [
                    {
                        id: 'u',
                        userId: '1',
                        speaker: '山田',
                        startedAt: new Date('2026-11-05T00:10:00Z'),
                        endedAt: new Date('2026-11-05T00:10:05Z'),
                        file: 'u.ogg',
                    },
                ],
            })
        );
        assert.deepEqual(json, {
            version: 1,
            session_id: 's',
            guild_id: 'g',
            channel_id: 'c',
            text_channel_id: 't',
            started_at: '2026-11-05T00:00:00.000Z',
            ended_at: '2026-11-05T01:00:00.000Z',
            utterances: [
                {
                    id: 'u',
                    user_id: '1',
                    speaker: '山田',
                    started_at: '2026-11-05T00:10:00.000Z',
                    ended_at: '2026-11-05T00:10:05.000Z',
                    file: 'u.ogg',
                },
            ],
        });
    });
});
