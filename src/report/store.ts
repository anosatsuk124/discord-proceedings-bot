import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { writeJsonAtomic } from './shared.ts';

/**
 * まとめページの記録。
 *
 *   <DATA_DIR>/reports/state.json                       全体の状態
 *   <DATA_DIR>/reports/<guild_id>/guild.json            サーバーごとの状態(index の URL など)
 *   <DATA_DIR>/reports/<guild_id>/<report_id>/report.json  ページごとの記録
 *   <DATA_DIR>/reports/<guild_id>/<report_id>/report.html  公開する HTML
 */

/**
 * waiting(対象の録音の文字起こし待ち)→ queued(worker が作成中)
 * → rendered(HTML ができた)→ published(本体を公開した)
 * → indexed(index を更新した)→ announced(すべて完了)。failed は打ち切り。
 */
export type ReportStatus =
    | 'waiting'
    | 'queued'
    | 'rendered'
    | 'published'
    | 'indexed'
    | 'announced'
    | 'failed';

export type ReportTrigger = 'auto' | 'manual';

export interface ReportRecord {
    readonly id: string;
    readonly guildId: string;
    readonly guildName: string | null;
    readonly trigger: ReportTrigger;
    readonly status: ReportStatus;
    readonly sessionIds: readonly string[];
    readonly periodLabel: string;
    /** 結果を投稿するテキストチャンネル。 */
    readonly notifyChannelId: string | null;
    readonly createdAt: string;
    /** 公開先のパス(reports/ から始まる)。 */
    readonly path: string;
    readonly title?: string;
    readonly lede?: string;
    readonly participants?: readonly string[];
    readonly utteranceCount?: number;
    readonly startedAt?: string;
    readonly endedAt?: string;
    readonly warnings?: readonly string[];
    /** 公開したページの URL。 */
    readonly url?: string;
    /** push 済みで Actions の完了を待っているコミット。再起動後はここから続ける。 */
    readonly commitSha?: string;
    readonly indexCommitSha?: string;
    readonly attempts?: number;
    /** 次にやり直してよい時刻。 */
    readonly retryAt?: string;
    readonly error?: string;
}

export interface GuildState {
    readonly guildName: string | null;
    readonly indexUrl?: string;
    /** index の URL をサーバーに知らせた時刻。二度は投稿しない。 */
    readonly indexAnnouncedAt?: string;
}

export interface GlobalState {
    /** この機能を初めて有効にした時刻。これより前に終わった録音は自動では扱わない。 */
    readonly autoEnabledAt: string;
}

/** 処理の途中か。同じサーバーでは同時に 1 件だけ動かす。 */
export function isActive(record: ReportRecord): boolean {
    return record.status !== 'announced' && record.status !== 'failed';
}

/** このページが対象のセッションを「まとめ済み」にするか。 */
export function coversSessions(record: ReportRecord): boolean {
    return record.status !== 'failed' || record.url !== undefined;
}

export class ReportStore {
    readonly #root: string;

    constructor(dataDir: string) {
        this.#root = path.join(dataDir, 'reports');
    }

    reportDirectory(guildId: string, reportId: string): string {
        return path.join(this.#root, guildId, reportId);
    }

    async save(record: ReportRecord): Promise<void> {
        await writeJsonAtomic(
            path.join(
                this.reportDirectory(record.guildId, record.id),
                'report.json'
            ),
            record
        );
    }

    /** サーバーの記録を、作成の古い順に返す。 */
    async list(guildId: string): Promise<ReportRecord[]> {
        const records: ReportRecord[] = [];
        for (const name of await subdirectories(
            path.join(this.#root, guildId)
        )) {
            const record = await readJson<ReportRecord>(
                path.join(this.#root, guildId, name, 'report.json')
            );
            if (record !== null) records.push(record);
        }
        return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    }

    async guildIds(): Promise<string[]> {
        return subdirectories(this.#root);
    }

    async guildState(guildId: string): Promise<GuildState | null> {
        return readJson<GuildState>(
            path.join(this.#root, guildId, 'guild.json')
        );
    }

    async saveGuildState(guildId: string, state: GuildState): Promise<void> {
        await writeJsonAtomic(
            path.join(this.#root, guildId, 'guild.json'),
            state
        );
    }

    /** 初回だけ今の時刻を書き、以後はその時刻を返す。 */
    async autoEnabledAt(now: Date): Promise<Date> {
        const file = path.join(this.#root, 'state.json');
        const existing = await readJson<GlobalState>(file);
        if (existing !== null) return new Date(existing.autoEnabledAt);
        await writeJsonAtomic(file, { autoEnabledAt: now.toISOString() });
        return now;
    }
}

async function subdirectories(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true }).catch(
        (error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return [];
            throw error;
        }
    );
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

async function readJson<T>(file: string): Promise<T | null> {
    let text: string;
    try {
        text = await readFile(file, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
    }
    return JSON.parse(text) as T;
}
