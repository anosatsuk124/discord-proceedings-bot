import { readAsset } from './assets.ts';
import { escapeHtml, fillTemplate } from './shared.ts';

/** サーバーの議事録の入口ページ。LLM を使わず、記録から機械的に作る。 */

export interface IndexEntry {
    readonly url: string;
    readonly title: string;
    readonly lede: string;
    readonly startedAt: string;
    readonly endedAt: string;
    readonly sessionCount: number;
    readonly participants: readonly string[];
}

export interface IndexPageInput {
    readonly guildName: string | null;
    readonly timeZone: string;
    readonly entries: readonly IndexEntry[];
    readonly updatedAt: Date;
}

export interface IndexAssets {
    readonly template: string;
    readonly css: string;
}

export async function loadIndexAssets(): Promise<IndexAssets> {
    return {
        template: await readAsset('index.template.html'),
        css: await readAsset('report.css'),
    };
}

export function renderIndexPage(
    assets: IndexAssets,
    input: IndexPageInput
): string {
    const { timeZone } = input;
    const month = new Intl.DateTimeFormat('ja-JP', {
        timeZone,
        year: 'numeric',
        month: 'long',
    });
    const dayAndTime = new Intl.DateTimeFormat('ja-JP', {
        timeZone,
        month: 'numeric',
        day: 'numeric',
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
    });
    const time = new Intl.DateTimeFormat('ja-JP', {
        timeZone,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
    });

    const sorted = [...input.entries].sort((a, b) =>
        b.startedAt.localeCompare(a.startedAt)
    );
    const groups = new Map<string, IndexEntry[]>();
    for (const entry of sorted) {
        const key = month.format(new Date(entry.startedAt));
        groups.set(key, [...(groups.get(key) ?? []), entry]);
    }
    const body =
        [...groups]
            .map(
                ([heading, entries]) => `<section>
<h2>${escapeHtml(heading)}</h2>
<ol class="reports">
${entries.map((entry) => renderEntry(entry, dayAndTime, time)).join('\n')}
</ol>
</section>`
            )
            .join('\n') || '<p>まだ議事録はありません。</p>';

    const guild = input.guildName ?? 'このサーバー';
    return fillTemplate(assets.template, {
        css: assets.css,
        title: escapeHtml(`${guild}の議事録`),
        heading: escapeHtml(guild),
        count: String(sorted.length),
        updated: escapeHtml(dayAndTime.format(input.updatedAt)),
        body,
    });
}

function renderEntry(
    entry: IndexEntry,
    dayAndTime: Intl.DateTimeFormat,
    time: Intl.DateTimeFormat
): string {
    const started = new Date(entry.startedAt);
    const ended = new Date(entry.endedAt);
    const participants = entry.participants.map(escapeHtml).join('、');
    return `<li>
<p class="dateline"><time datetime="${escapeHtml(entry.startedAt)}">${escapeHtml(dayAndTime.format(started))}</time>–<time datetime="${escapeHtml(entry.endedAt)}">${escapeHtml(time.format(ended))}</time></p>
<h3><a href="${escapeHtml(entry.url)}">${escapeHtml(entry.title)}</a></h3>
<p>${escapeHtml(entry.lede)}</p>
<p class="facts-line">録音 ${entry.sessionCount} 件 / 参加者: ${participants}</p>
</li>`;
}
