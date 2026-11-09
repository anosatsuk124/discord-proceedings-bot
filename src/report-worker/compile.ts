import { readAsset } from '../report/assets.ts';
import { escapeHtml as e, fillTemplate } from '../report/shared.ts';
import type { Line, SessionMeta, Transcript } from './transcript.ts';
import type {
    LineCorrection,
    Outline,
    Point,
    Source,
    SourceKind,
    TopicSources,
} from './types.ts';

/**
 * JSON と原文を、本文を直接埋め込んだ静的な HTML にコンパイルする。
 *
 * ページには JSON を残さない。JS と CSS は見た目と検索のためのものなので、どちらも無効でも
 * 全文・見出し・リンクが使えるよう、情報はすべて HTML の本文と構造で表す。
 */

export interface CompileAssets {
    readonly template: string;
    readonly css: string;
    readonly js: string;
}

export async function loadCompileAssets(): Promise<CompileAssets> {
    return {
        template: await readAsset('report.template.html'),
        css: await readAsset('report.css'),
        js: await readAsset('report.js'),
    };
}

export interface CompileInput {
    readonly guildName: string | null;
    readonly timeZone: string;
    readonly periodLabel: string;
    readonly transcript: Transcript;
    readonly outline: Outline;
    readonly research: readonly TopicSources[];
    readonly corrections: ReadonlyMap<string, LineCorrection>;
    /** 校正できなかった行。ページに「未校正」と出す。 */
    readonly uncorrected: ReadonlySet<string>;
}

/** インライン JS の上限(バイト)。 */
const MAX_INLINE_JS = 8 * 1024;
/** pager が受け付ける上限。 */
const MAX_HTML_BYTES = 25 * 1024 * 1024;
const TURN_GAP_MS = 12_000;
const MAX_TURN_LINES = 20;
const AXIS_BUCKETS = 160;

const SOURCE_KIND_LABELS: Record<SourceKind, string> = {
    paper: '論文',
    encyclopedia: '事典',
    article: '記事',
    other: 'その他',
};

export function compileReport(
    assets: CompileAssets,
    input: CompileInput
): string {
    const context = new CompileContext(input);
    const { outline } = input;
    const html = fillTemplate(assets.template, {
        css: assets.css,
        js: assets.js,
        pageTitle: e(
            `${outline.title} — ${input.guildName ?? ''} 議事録`.trim()
        ),
        masthead: context.masthead(),
        speakers: context.speakerList(),
        toc: context.toc(),
        axis: context.axis(),
        summary: context.summary(),
        map: context.map(),
        transcript: context.transcriptBody(),
        sources: context.allSources(),
    });
    assertSelfContained(html, assets.js, input.transcript.lines);
    return html;
}

/** 完成した HTML が要件を満たすか確かめる。満たさなければ公開させない。 */
export function assertSelfContained(
    html: string,
    js: string,
    lines: readonly Line[]
): void {
    if (Buffer.byteLength(js) > MAX_INLINE_JS) {
        throw new Error(
            `inline JS is too large: ${Buffer.byteLength(js)} bytes`
        );
    }
    if (Buffer.byteLength(html) > MAX_HTML_BYTES) {
        throw new Error('the report exceeds the 25 MiB limit of the pager');
    }
    const forbidden: ReadonlyArray<readonly [RegExp, string]> = [
        [/<script[^>]*\ssrc\s*=/i, 'external script'],
        [/<script[^>]*type\s*=\s*["']?application\/json/i, 'embedded JSON'],
        [
            /<(img|iframe|embed|object|video|audio|source)[\s>]/i,
            'auto-loaded resource',
        ],
        [/<link[\s>]/i, 'external stylesheet'],
        [/url\(\s*["']?https?:/i, 'external CSS resource'],
    ];
    for (const [pattern, label] of forbidden) {
        if (pattern.test(html)) throw new Error(`the report contains ${label}`);
    }
    if (
        /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon/.test(js)
    ) {
        throw new Error('the inline JS must not use the network');
    }
    for (const line of lines) {
        if (!html.includes(` id="${line.id}"`)) {
            throw new Error(`line ${line.id} is missing from the report`);
        }
    }
}

const KANJI_DIGITS = '〇一二三四五六七八九';

/** 99 までの数を漢数字にする。 */
function kanji(n: number): string {
    if (n < 10) return KANJI_DIGITS[n] ?? String(n);
    const tens = Math.floor(n / 10);
    const ones = n % 10;
    return (
        (tens === 1 ? '' : (KANJI_DIGITS[tens] ?? '')) +
        '十' +
        (ones === 0 ? '' : (KANJI_DIGITS[ones] ?? ''))
    );
}

interface Turn {
    readonly id: string;
    readonly speaker: string;
    readonly lines: readonly Line[];
}

class CompileContext {
    readonly #input: CompileInput;
    readonly #time: Intl.DateTimeFormat;
    readonly #dateLine: Intl.DateTimeFormat;
    readonly #speakerIndex: ReadonlyMap<string, number>;
    readonly #chapterLines: ReadonlyArray<readonly Line[]>;

    constructor(input: CompileInput) {
        this.#input = input;
        this.#time = new Intl.DateTimeFormat('ja-JP', {
            timeZone: input.timeZone,
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
        });
        this.#dateLine = new Intl.DateTimeFormat('ja-JP', {
            timeZone: input.timeZone,
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            weekday: 'short',
        });
        this.#speakerIndex = new Map(
            input.transcript.participants.map((name, i) => [name, i])
        );
        const { position, lines } = input.transcript;
        this.#chapterLines = input.outline.chapters.map((chapter) =>
            lines.slice(
                position.get(chapter.start) ?? 0,
                (position.get(chapter.end) ?? -1) + 1
            )
        );
    }

    #clock(date: Date): string {
        return this.#time.format(date);
    }

    #refs(refs: readonly string[]): string {
        const { byId } = this.#input.transcript;
        return refs
            .flatMap((id) => {
                const line = byId.get(id);
                if (line === undefined) return [];
                return [
                    `<a class="ref" href="#${e(id)}">${e(this.#clock(line.at))}</a>`,
                ];
            })
            .join(' ');
    }

    #point(point: Point): string {
        return `<li>${e(point.text)} ${this.#refs(point.refs)}</li>`;
    }

    masthead(): string {
        const { transcript, outline, guildName, periodLabel } = this.#input;
        const first = transcript.sessions[0];
        const last = transcript.sessions.at(-1);
        const lines = transcript.lines;
        const startedAt = lines[0]?.at ?? first?.startedAt ?? new Date();
        const endedAt = lines.at(-1)?.at ?? last?.endedAt ?? startedAt;
        const dateText = this.#dateLine.format(startedAt);
        const endDate = this.#dateLine.format(endedAt);
        return `<p class="dateline"><time datetime="${e(startedAt.toISOString())}">${e(dateText)} ${e(this.#clock(startedAt))}</time>–<time datetime="${e(endedAt.toISOString())}">${endDate === dateText ? '' : `${e(endDate)} `}${e(this.#clock(endedAt))}</time></p>
<h1>${e(outline.title)}</h1>
<p class="lede">${e(outline.lede)}</p>
<dl class="facts">
<div><dt>サーバー</dt><dd>${e(guildName ?? '不明')}</dd></div>
<div><dt>対象</dt><dd>${e(periodLabel)}(録音 ${transcript.sessions.length} 件)</dd></div>
<div><dt>発言</dt><dd>${lines.length.toLocaleString('ja-JP')} 行</dd></div>
</dl>
<p class="notice">音声を自動で文字起こしし、AIが校正したものです。話者と時刻は原データのままです。校正した発言は「原文」から元の認識結果を確認できます。</p>`;
    }

    speakerList(): string {
        return this.#input.transcript.participants
            .map((name, i) => `<li data-s="${i}">${e(name)}</li>`)
            .join('');
    }

    toc(): string {
        const items = this.#input.outline.chapters.map((chapter, i) => {
            const line = this.#chapterLines[i]?.[0];
            return `<li><a href="#ch-${i + 1}"><span>第${kanji(i + 1)}章</span> ${e(chapter.title)}</a>${line ? ` <time datetime="${e(line.iso)}">${e(this.#clock(line.at))}</time>` : ''}</li>`;
        });
        return `<ol>${items.join('')}</ol>`;
    }

    /** 時間軸の図。時間の位置ごとの発言の量と章の区切りを、ビルド時に SVG にする。 */
    axis(): string {
        const { lines, sessions, participants } = this.#input.transcript;
        const totalMs = sessionDurations(lines, sessions).total;
        if (totalMs <= 0) return '';
        const offsetOf = timelineOffset(lines, sessions);
        const speakers = Math.min(participants.length, 4);
        const buckets = Array.from({ length: AXIS_BUCKETS }, () =>
            new Array<number>(speakers).fill(0)
        );
        const bucketOf = (line: Line): number =>
            Math.min(
                AXIS_BUCKETS - 1,
                Math.floor((offsetOf(line) / totalMs) * AXIS_BUCKETS)
            );
        for (const line of lines) {
            const s = this.#speakerIndex.get(line.speaker) ?? 0;
            const row = buckets[bucketOf(line)];
            if (row !== undefined) row[Math.min(s, speakers - 1)]! += 1;
        }
        const peak = Math.max(
            1,
            ...buckets.map((row) => row.reduce((a, b) => a + b, 0))
        );
        const rects = buckets
            .flatMap((row, y) => {
                let x = 0;
                return row.flatMap((count, s) => {
                    if (count === 0) return [];
                    const width = (count / peak) * 40;
                    const rect = `<rect class="s${s}" x="${x.toFixed(1)}" y="${y}" width="${width.toFixed(1)}" height="1"/>`;
                    x += width;
                    return [rect];
                });
            })
            .join('');
        const ticks = this.#input.outline.chapters
            .map((chapter, i) => {
                const first = this.#chapterLines[i]?.[0];
                if (first === undefined) return '';
                const y = (offsetOf(first) / totalMs) * AXIS_BUCKETS;
                return `<a href="#ch-${i + 1}"><title>第${kanji(i + 1)}章 ${e(chapter.title)}</title><line x1="0" x2="48" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"/><rect class="hit" x="0" y="${y.toFixed(1)}" width="48" height="4"/></a>`;
            })
            .join('');
        return `<svg viewBox="0 0 48 ${AXIS_BUCKETS}" width="48" height="160" preserveAspectRatio="none" role="img" aria-label="会話の時間軸。章をクリックすると移動します">${rects}${ticks}<rect id="axis-now" x="0" y="0" width="48" height="1"/></svg>`;
    }

    summary(): string {
        const { outline } = this.#input;
        const section = (heading: string, points: readonly Point[]): string =>
            points.length === 0
                ? ''
                : `<h3>${heading}</h3><ul>${points.map((p) => this.#point(p)).join('')}</ul>`;
        return (
            section('主な内容', outline.key_points) +
            section('決まったこと', outline.decisions) +
            section('残った問い', outline.open_questions)
        );
    }

    map(): string {
        const { threads } = this.#input.outline;
        if (threads.length === 0) return '<p>まとめる論点はありません。</p>';
        return threads
            .map(
                (thread) => `<section class="thread">
<h3>${e(thread.topic)}</h3>
<p class="question">${e(thread.question)}</p>
<dl>${thread.positions
                    .map(
                        (p) =>
                            `<dt>${e(p.speaker)}</dt><dd>${e(p.text)} ${this.#refs(p.refs)}</dd>`
                    )
                    .join('')}</dl>
</section>`
            )
            .join('\n');
    }

    transcriptBody(): string {
        const { outline } = this.#input;
        let turnNumber = 0;
        return outline.chapters
            .map((chapter, index) => {
                const number = index + 1;
                const lines = this.#chapterLines[index] ?? [];
                const turns = this.#groupTurns(lines, () => {
                    turnNumber += 1;
                    return `t${turnNumber}`;
                });
                const flow =
                    chapter.flow.length === 0
                        ? ''
                        : `<ul class="flow">${chapter.flow
                              .map(
                                  (f) =>
                                      `<li><b>${e(f.label)}</b> ${e(f.text)}</li>`
                              )
                              .join('')}</ul>`;
                return `<section id="ch-${number}">
<h3><span>第${kanji(number)}章</span> ${e(chapter.title)}</h3>
<p>${e(chapter.summary)}</p>
${flow}
<p class="point"><b>論点</b> ${e(chapter.point)}</p>
${this.#chapterSources(number)}
<ol class="log">
${turns.map((turn) => this.#turn(turn)).join('\n')}
</ol>
</section>`;
            })
            .join('\n');
    }

    /** 連続する同じ話者の短い発言を 1 つのターンにまとめる。 */
    #groupTurns(lines: readonly Line[], nextId: () => string): Turn[] {
        const turns: Turn[] = [];
        let current: Line[] = [];
        const flush = (): void => {
            const first = current[0];
            if (first !== undefined) {
                turns.push({
                    id: nextId(),
                    speaker: first.speaker,
                    lines: current,
                });
            }
            current = [];
        };
        for (const line of lines) {
            const previous = current.at(-1);
            if (
                previous !== undefined &&
                (previous.speaker !== line.speaker ||
                    previous.session !== line.session ||
                    line.at.getTime() - previous.at.getTime() > TURN_GAP_MS ||
                    current.length >= MAX_TURN_LINES)
            ) {
                flush();
            }
            current.push(line);
        }
        flush();
        return turns;
    }

    #turn(turn: Turn): string {
        const { corrections, uncorrected } = this.#input;
        const first = turn.lines[0];
        if (first === undefined) return '';
        const speakerIndex = this.#speakerIndex.get(turn.speaker) ?? 0;
        const kept = turn.lines.filter(
            (l) => corrections.get(l.id)?.kind !== 'drop'
        );
        const dropped = turn.lines.filter(
            (l) => corrections.get(l.id)?.kind === 'drop'
        );
        const say = kept.map((l) => this.#lineSpan(l)).join(' ');
        const changed = kept.some((l) => corrections.has(l.id));
        const original = changed
            ? `<details class="orig"><summary>原文</summary><p>${kept.map((l) => e(l.raw)).join(' ／ ')}</p></details>`
            : '';
        const droppedNote =
            dropped.length === 0
                ? ''
                : `<details class="dropped"><summary>誤認識の疑い ${dropped.length} 行</summary><p>${dropped.map((l) => `<span id="${e(l.id)}">${e(l.raw)}</span>`).join(' ／ ')}</p></details>`;
        const unchecked = turn.lines.some((l) => uncorrected.has(l.id))
            ? ' <small>(未校正)</small>'
            : '';
        return `<li id="${turn.id}" data-s="${speakerIndex}"><p class="who"><a href="#${turn.id}"><time datetime="${e(first.iso)}">${e(this.#clock(first.at))}</time></a> <b>${e(turn.speaker)}</b>${unchecked}</p>${say === '' ? '' : `<p class="say">${say}</p>`}${original}${droppedNote}</li>`;
    }

    #lineSpan(line: Line): string {
        const correction = this.#input.corrections.get(line.id);
        const id = e(line.id);
        if (correction?.text === undefined) {
            return `<span id="${id}">${e(line.raw)}</span>`;
        }
        if (correction.kind === 'infer') {
            return `<span id="${id}"><ins>${e(correction.text)}</ins><small>(補完)</small></span>`;
        }
        return `<span id="${id}">${e(correction.text)}</span>`;
    }

    #chapterSources(chapter: number): string {
        const related = this.#input.research.flatMap((entry) =>
            entry.topic.chapters.includes(chapter) ? entry.sources : []
        );
        const unique = uniqueByUrl(related);
        return unique.length === 0
            ? ''
            : `<details class="sources"><summary>関連資料 ${unique.length} 件</summary><ul>${unique.map(renderSource).join('')}</ul></details>`;
    }

    allSources(): string {
        const groups = this.#input.research.filter(
            (entry) => entry.sources.length > 0
        );
        if (groups.length === 0) {
            return '<p>関連資料はありません。</p>';
        }
        return (
            '<p class="notice">AIが収集した資料です。内容は原典で確認してください。</p>' +
            groups
                .map(
                    (entry) =>
                        `<section><h3>${e(entry.topic.question)}</h3><ul>${entry.sources.map(renderSource).join('')}</ul></section>`
                )
                .join('')
        );
    }
}

function uniqueByUrl(sources: readonly Source[]): Source[] {
    const seen = new Set<string>();
    return sources.filter((s) => {
        if (seen.has(s.url)) return false;
        seen.add(s.url);
        return true;
    });
}

function renderSource(source: Source): string {
    const domain = new URL(source.url).hostname;
    return `<li><a href="${e(source.url)}" rel="noopener noreferrer nofollow" target="_blank">${e(source.title)}</a> <span class="domain">${e(domain)}・${SOURCE_KIND_LABELS[source.kind]}</span><p>${e(source.summary)}</p><p class="relevance">${e(source.relevance)}</p></li>`;
}

/** 録音ごとの長さの合計(録音と録音のあいだの空白は詰める)。 */
function sessionDurations(
    lines: readonly Line[],
    sessions: readonly SessionMeta[]
): {
    readonly spans: ReadonlyMap<number, readonly [number, number]>;
    readonly total: number;
} {
    const spans = new Map<number, readonly [number, number]>();
    for (const session of sessions) {
        const own = lines.filter((l) => l.session === session.index);
        const first = own[0];
        const last = own.at(-1);
        if (first !== undefined && last !== undefined) {
            spans.set(session.index, [first.at.getTime(), last.at.getTime()]);
        }
    }
    let total = 0;
    for (const [start, end] of spans.values())
        total += Math.max(end - start, 1);
    return { spans, total };
}

function timelineOffset(
    lines: readonly Line[],
    sessions: readonly SessionMeta[]
): (line: Line) => number {
    const { spans } = sessionDurations(lines, sessions);
    const baseOf = new Map<number, number>();
    let base = 0;
    for (const [index, [start, end]] of spans) {
        baseOf.set(index, base);
        base += Math.max(end - start, 1);
    }
    return (line) => {
        const span = spans.get(line.session);
        if (span === undefined) return 0;
        return (baseOf.get(line.session) ?? 0) + (line.at.getTime() - span[0]);
    };
}
