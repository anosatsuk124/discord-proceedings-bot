import { copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import {
    PROCEEDINGS_FILE,
    PermanentDeliveryError,
    type Poster,
} from '../delivery.ts';
import { newSessionId } from '../manifest.ts';
import type { Logger } from '../recording-session.ts';
import { decideAuto } from './auto.ts';
import {
    loadIndexAssets,
    renderIndexPage,
    type IndexEntry,
} from './index-page.ts';
import {
    JOB_INPUT_DIR,
    JOB_REPORT_FILE,
    JOB_REQUEST_FILE,
    JOB_RESULT_FILE,
    JOB_VERSION,
    type JobRequest,
    type JobResult,
} from './job-files.ts';
import { yearMonthOf, type DateRange } from './period.ts';
import { DeployFailedError, type Publisher } from './publisher.ts';
import { writeJsonAtomic } from './shared.ts';
import {
    listFinishedSessions,
    overlaps,
    type SessionInfo,
} from './sessions.ts';
import {
    coversSessions,
    isActive,
    ReportStore,
    type ReportRecord,
    type ReportTrigger,
} from './store.ts';

/**
 * まとめページの生成を最初から最後まで進める。LLM 以外の処理はすべてここにある。
 *
 * ジョブを作り、worker の結果を受け取り、公開して、チャンネルに投稿し、index を更新する。
 * 進み具合は report.json に残すので、再起動しても途中から続き、LLM をやり直さない。
 */

const MAX_ATTEMPTS = 5;
const RETRY_BASE_MS = 60_000;
/** 自動生成の判定は全セッションを読むので、ページの処理より間隔を空ける。 */
const AUTO_CHECK_INTERVAL_MS = 5 * 60_000;

export interface CoordinatorOptions {
    readonly dataDir: string;
    readonly jobsDir: string;
    readonly timeZone: string;
    /** 0 なら自動では生成しない。 */
    readonly autoDelayMs: number;
    readonly jobTimeoutMs: number;
    readonly publisher: Publisher;
    readonly poster: Poster;
    readonly isRecording: (guildId: string) => boolean;
    /** index の URL を知らせるチャンネル(システムメッセージのチャンネル)。 */
    readonly announceChannel: (guildId: string) => Promise<string | null>;
    readonly logger?: Logger;
    readonly now?: () => Date;
}

export type ReportSelection =
    | { readonly kind: 'pending' }
    | { readonly kind: 'range'; readonly range: DateRange };

export interface ManualRequest {
    readonly guildId: string;
    readonly guildName: string | null;
    readonly channelId: string;
    readonly selection: ReportSelection;
}

export type ManualOutcome =
    | { readonly kind: 'accepted'; readonly sessionCount: number }
    | { readonly kind: 'empty' }
    | { readonly kind: 'busy' };

/** 処理中の記録。段階ごとに保存した最新の内容を持つ。 */
interface Progress {
    record: ReportRecord;
}

export class ReportCoordinator {
    readonly #options: CoordinatorOptions;
    readonly #store: ReportStore;
    readonly #logger: Logger;
    readonly #now: () => Date;
    #lastAutoCheck: number | null = null;

    constructor(options: CoordinatorOptions) {
        this.#options = options;
        this.#store = new ReportStore(options.dataDir);
        this.#logger = options.logger ?? console;
        this.#now = options.now ?? (() => new Date());
    }

    /** /gijiroku report。期間に入っていれば、まとめ済みのセッションも対象にする。 */
    async requestManual(request: ManualRequest): Promise<ManualOutcome> {
        const { guildId, selection } = request;
        const records = await this.#store.list(guildId);
        if (records.some(isActive)) return { kind: 'busy' };
        const sessions = (
            await listFinishedSessions(this.#options.dataDir, this.#logger)
        ).get(guildId);
        const ready = (sessions ?? []).filter((s) => s.state === 'ready');
        const covered = new Set(
            records.filter(coversSessions).flatMap((r) => r.sessionIds)
        );
        const chosen =
            selection.kind === 'pending'
                ? ready.filter((s) => !covered.has(s.sessionId))
                : ready.filter((s) =>
                      overlaps(s, selection.range.start, selection.range.end)
                  );
        if (chosen.length === 0) return { kind: 'empty' };
        await this.#createJob({
            guildId,
            guildName: request.guildName,
            sessions: chosen,
            trigger: 'manual',
            notifyChannelId: request.channelId,
            periodLabel:
                selection.kind === 'pending'
                    ? 'まだまとめていない録音'
                    : selection.range.label,
        });
        return { kind: 'accepted', sessionCount: chosen.length };
    }

    async indexUrl(guildId: string): Promise<string | null> {
        return (await this.#store.guildState(guildId))?.indexUrl ?? null;
    }

    /** 定期的に呼ぶ。進められる記録を進め、自動生成の判定をする。 */
    async tick(): Promise<void> {
        for (const guildId of await this.#store.guildIds()) {
            for (const record of await this.#store.list(guildId)) {
                if (isActive(record)) await this.#advance(record);
            }
        }
        const now = this.#now().getTime();
        if (
            this.#options.autoDelayMs > 0 &&
            (this.#lastAutoCheck === null ||
                now - this.#lastAutoCheck >= AUTO_CHECK_INTERVAL_MS)
        ) {
            this.#lastAutoCheck = now;
            await this.#runAuto();
        }
    }

    async #runAuto(): Promise<void> {
        const now = this.#now();
        const autoEnabledAt = await this.#store.autoEnabledAt(now);
        const byGuild = await listFinishedSessions(
            this.#options.dataDir,
            this.#logger
        );
        for (const [guildId, sessions] of byGuild) {
            const chosen = decideAuto({
                sessions,
                records: await this.#store.list(guildId),
                recording: this.#options.isRecording(guildId),
                now,
                delayMs: this.#options.autoDelayMs,
                autoEnabledAt,
            });
            const newest = chosen.at(-1);
            if (newest === undefined) continue;
            this.#logger.info(
                `auto report for guild ${guildId}: ${chosen.length} session(s)`
            );
            await this.#createJob({
                guildId,
                guildName: newest.guildName,
                sessions: chosen,
                trigger: 'auto',
                notifyChannelId: newest.textChannelId,
                periodLabel: 'まだまとめていない録音',
            });
        }
    }

    async #createJob(job: {
        readonly guildId: string;
        readonly guildName: string | null;
        readonly sessions: readonly SessionInfo[];
        readonly trigger: ReportTrigger;
        readonly notifyChannelId: string | null;
        readonly periodLabel: string;
    }): Promise<void> {
        const now = this.#now();
        const id = newSessionId(now);
        const first = job.sessions[0];
        if (first === undefined) throw new Error('a job needs sessions');
        const { year, month } = yearMonthOf(
            first.startedAt,
            this.#options.timeZone
        );
        const directory = path.join(this.#options.jobsDir, id);
        await mkdir(path.join(directory, JOB_INPUT_DIR), { recursive: true });
        for (const session of job.sessions) {
            await copyFile(
                path.join(session.directory, PROCEEDINGS_FILE),
                path.join(directory, JOB_INPUT_DIR, `${session.sessionId}.csv`)
            );
        }
        await this.#store.save({
            id,
            guildId: job.guildId,
            guildName: job.guildName,
            trigger: job.trigger,
            status: 'queued',
            sessionIds: job.sessions.map((s) => s.sessionId),
            periodLabel: job.periodLabel,
            notifyChannelId: job.notifyChannelId,
            createdAt: now.toISOString(),
            path: `reports/${job.guildId}/${year}/${month}/${id}.html`,
        });
        const request: JobRequest = {
            version: JOB_VERSION,
            jobId: id,
            guildName: job.guildName,
            timeZone: this.#options.timeZone,
            periodLabel: job.periodLabel,
            createdAt: now.toISOString(),
            sessions: job.sessions.map((s) => ({
                sessionId: s.sessionId,
                channelName: s.channelName,
                startedAt: s.startedAt.toISOString(),
                endedAt: s.endedAt.toISOString(),
                csv: `${JOB_INPUT_DIR}/${s.sessionId}.csv`,
            })),
        };
        // worker は request.json を見て動くので、ほかの準備が済んでから最後に書く。
        await writeJsonAtomic(path.join(directory, JOB_REQUEST_FILE), request);
    }

    async #advance(initial: ReportRecord): Promise<void> {
        const retryAt = initial.retryAt;
        if (retryAt && new Date(retryAt) > this.#now()) return;
        const progress: Progress = { record: initial };
        try {
            for (;;) {
                const before = progress.record;
                await this.#step(progress);
                if (progress.record === before || !isActive(progress.record)) {
                    return;
                }
            }
        } catch (error) {
            await this.#handleError(progress, error);
        }
    }

    async #step(progress: Progress): Promise<void> {
        switch (progress.record.status) {
            case 'queued':
                await this.#collectResult(progress);
                break;
            case 'rendered':
                await this.#publishReport(progress);
                break;
            case 'published':
                await this.#publishIndex(progress);
                break;
            case 'indexed':
                await this.#announceIndex(progress);
                break;
            case 'announced':
            case 'failed':
                break;
        }
    }

    async #update(
        progress: Progress,
        patch: Partial<ReportRecord>
    ): Promise<void> {
        progress.record = { ...progress.record, ...patch };
        await this.#store.save(progress.record);
    }

    async #collectResult(progress: Progress): Promise<void> {
        const { record } = progress;
        const jobDirectory = path.join(this.#options.jobsDir, record.id);
        const result = await readResult(
            path.join(jobDirectory, JOB_RESULT_FILE)
        );
        if (result === null) {
            const age =
                this.#now().getTime() - new Date(record.createdAt).getTime();
            if (age > this.#options.jobTimeoutMs) {
                await this.#fail(
                    progress,
                    '生成が時間内に終わりませんでした(report-worker が動いていない可能性があります)'
                );
            }
            return;
        }
        if (result.status === 'failed') {
            await this.#fail(progress, result.error);
            return;
        }
        await mkdir(this.#store.reportDirectory(record.guildId, record.id), {
            recursive: true,
        });
        await copyFile(
            path.join(jobDirectory, JOB_REPORT_FILE),
            this.#htmlFile(record)
        );
        await this.#update(progress, {
            status: 'rendered',
            title: result.title,
            lede: result.lede,
            participants: result.participants,
            utteranceCount: result.utteranceCount,
            startedAt: result.startedAt,
            endedAt: result.endedAt,
            warnings: result.warnings,
        });
        await rm(jobDirectory, { recursive: true, force: true });
    }

    #htmlFile(record: ReportRecord): string {
        return path.join(
            this.#store.reportDirectory(record.guildId, record.id),
            'report.html'
        );
    }

    async #publishReport(progress: Progress): Promise<void> {
        if (progress.record.url === undefined) {
            let sha = progress.record.commitSha;
            if (sha === undefined) {
                const { record } = progress;
                sha = await this.#options.publisher.commit(
                    [
                        {
                            path: record.path,
                            content: await readFile(this.#htmlFile(record)),
                        },
                    ],
                    `Publish report ${record.id}`
                );
                await this.#update(progress, { commitSha: sha });
            }
            const url = await this.#waitForUrl(
                progress,
                sha,
                progress.record.path,
                'commitSha'
            );
            await this.#update(progress, { url });
        }
        await this.#post(
            progress.record.notifyChannelId,
            reportMessage(progress.record)
        );
        await this.#update(progress, {
            status: 'published',
            commitSha: undefined,
            attempts: 0,
            retryAt: undefined,
        });
    }

    async #publishIndex(progress: Progress): Promise<void> {
        const { guildId } = progress.record;
        const indexPath = `reports/${guildId}/index.html`;
        let sha = progress.record.indexCommitSha;
        if (sha === undefined) {
            const html = await this.#renderIndex(progress.record);
            sha = await this.#options.publisher.commit(
                [{ path: indexPath, content: Buffer.from(html) }],
                `Update the index of guild ${guildId}`
            );
            await this.#update(progress, { indexCommitSha: sha });
        }
        const url = await this.#waitForUrl(
            progress,
            sha,
            indexPath,
            'indexCommitSha'
        );
        const state = await this.#store.guildState(guildId);
        await this.#store.saveGuildState(guildId, {
            ...state,
            guildName: progress.record.guildName,
            indexUrl: url,
        });
        await this.#update(progress, {
            status: 'indexed',
            indexCommitSha: undefined,
            attempts: 0,
            retryAt: undefined,
        });
    }

    /** デプロイが失敗したら、次の試行でコミットからやり直せるよう識別子を消す。 */
    async #waitForUrl(
        progress: Progress,
        ref: string,
        file: string,
        field: 'commitSha' | 'indexCommitSha'
    ): Promise<string> {
        try {
            const urls = await this.#options.publisher.urlsFor(ref, [file]);
            const url = urls.get(file);
            if (url === undefined) throw new Error(`no URL for ${file}`);
            return url;
        } catch (error) {
            if (error instanceof DeployFailedError) {
                await this.#update(progress, { [field]: undefined });
            }
            throw error;
        }
    }

    async #renderIndex(current: ReportRecord): Promise<string> {
        const records = await this.#store.list(current.guildId);
        const entries: IndexEntry[] = [];
        for (const record of records) {
            if (
                record.url !== undefined &&
                record.title !== undefined &&
                record.startedAt !== undefined &&
                record.endedAt !== undefined
            ) {
                entries.push({
                    url: record.url,
                    title: record.title,
                    lede: record.lede ?? '',
                    startedAt: record.startedAt,
                    endedAt: record.endedAt,
                    sessionCount: record.sessionIds.length,
                    participants: record.participants ?? [],
                });
            }
        }
        return renderIndexPage(await loadIndexAssets(), {
            guildName: current.guildName,
            timeZone: this.#options.timeZone,
            entries,
            updatedAt: this.#now(),
        });
    }

    async #announceIndex(progress: Progress): Promise<void> {
        const { guildId, notifyChannelId } = progress.record;
        const state = await this.#store.guildState(guildId);
        if (state?.indexUrl !== undefined && !state.indexAnnouncedAt) {
            const content =
                `📚 このサーバーの議事録の入口ページです。今後の議事録はここにも追加されます。\n<${state.indexUrl}>\n` +
                'このURLを知っている人はページを見られます。扱いに注意してください。';
            const channels = [
                await this.#options.announceChannel(guildId),
                notifyChannelId,
            ].filter((id): id is string => id !== null);
            for (const channelId of channels) {
                try {
                    await this.#options.poster.post(channelId, {
                        content,
                        files: [],
                    });
                    await this.#store.saveGuildState(guildId, {
                        ...state,
                        indexAnnouncedAt: this.#now().toISOString(),
                    });
                    break;
                } catch (error) {
                    if (!(error instanceof PermanentDeliveryError)) throw error;
                    this.#logger.warn(
                        `cannot announce the index in channel ${channelId}: ${error.message}`
                    );
                }
            }
        }
        await this.#update(progress, { status: 'announced' });
    }

    async #post(channelId: string | null, content: string): Promise<void> {
        if (channelId === null) return;
        try {
            await this.#options.poster.post(channelId, { content, files: [] });
        } catch (error) {
            if (!(error instanceof PermanentDeliveryError)) throw error;
            this.#logger.error(
                `giving up posting to channel ${channelId}: ${error.message}`
            );
        }
    }

    async #handleError(progress: Progress, error: unknown): Promise<void> {
        const { record } = progress;
        const attempts = (record.attempts ?? 0) + 1;
        this.#logger.error(
            `report ${record.id} failed at ${record.status} (attempt ${attempts})`,
            error
        );
        if (attempts >= MAX_ATTEMPTS) {
            await this.#fail(
                progress,
                error instanceof Error ? error.message : String(error)
            );
            return;
        }
        await this.#update(progress, {
            attempts,
            retryAt: new Date(
                this.#now().getTime() + RETRY_BASE_MS * 2 ** attempts
            ).toISOString(),
        });
    }

    async #fail(progress: Progress, reason: string): Promise<void> {
        const { record } = progress;
        await this.#update(progress, { status: 'failed', error: reason });
        await rm(path.join(this.#options.jobsDir, record.id), {
            recursive: true,
            force: true,
        });
        await this.#post(
            record.notifyChannelId,
            record.url === undefined
                ? `⚠️ 議事録ページの生成に失敗しました(${record.periodLabel}): ${reason}`
                : `⚠️ 議事録ページは公開しましたが、入口ページの更新に失敗しました: ${reason}`
        ).catch((error: unknown) =>
            this.#logger.error('failed to report the failure', error)
        );
    }
}

/** 公開したページを知らせる文面。URL を <> で囲み、プレビューの取得を抑える。 */
export function reportMessage(record: ReportRecord): string {
    const lines = [
        `📄 議事録ページができました: **${record.title ?? record.id}**`,
    ];
    if (record.startedAt !== undefined && record.endedAt !== undefined) {
        lines.push(
            `<t:${unix(record.startedAt)}:f> 〜 <t:${unix(record.endedAt)}:t>(録音 ${record.sessionIds.length} 件)`
        );
    }
    lines.push(`<${record.url}>`);
    if (record.warnings !== undefined && record.warnings.length > 0) {
        lines.push(`※ ${record.warnings.join(' / ')}`);
    }
    return lines.join('\n');
}

function unix(iso: string): number {
    return Math.floor(new Date(iso).getTime() / 1000);
}

async function readResult(file: string): Promise<JobResult | null> {
    let text: string;
    try {
        text = await readFile(file, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
    }
    return JSON.parse(text) as JobResult;
}
