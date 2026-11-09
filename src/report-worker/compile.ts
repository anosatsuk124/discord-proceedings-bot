import { readAsset } from '../report/assets.ts';
import { escapeHtml as e, fillTemplate } from '../report/shared.ts';
import type { Line, Transcript } from './transcript.ts';
import type {
    ConversationMap,
    Debate,
    LineCorrection,
    MoveKind,
    OutcomeStatus,
    Outline,
    Phase,
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
    /** 作れなかったときは null。論点のカードだけを出す。 */
    readonly map: ConversationMap | null;
}

/** インライン JS の上限(バイト)。 */
const MAX_INLINE_JS = 8 * 1024;
/** pager が受け付ける上限。 */
const MAX_HTML_BYTES = 25 * 1024 * 1024;
const TURN_GAP_MS = 12_000;
const MAX_TURN_LINES = 20;
/** CSS の .c0〜.c5 の数。話者の名前の色に使う。 */
const SPEAKER_COLORS = 6;
/** これより短いターンは、区切りごとに改行せず続けて見せる。 */
const SHORT_TURN_CHARS = 16;

const MOVE_LABELS: Record<MoveKind, string> = {
    claim: '主張',
    reason: '理由',
    example: '例',
    objection: '反論',
    reply: '応答',
    question: '問い返し',
    concession: '譲歩',
};

const OUTCOME_LABELS: Record<OutcomeStatus, string> = {
    agreed: '合意',
    partial: '一部合意',
    unresolved: '未決着',
    shifted: '決着せず次の話へ',
};

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

    /** 同じ分の参照は見分けが付かないので、分ごとに最初の 1 件だけ残す。 */
    #refs(refs: readonly string[]): string {
        const { byId } = this.#input.transcript;
        const seen = new Set<string>();
        return refs
            .flatMap((id) => {
                const line = byId.get(id);
                if (line === undefined) return [];
                const label = this.#clock(line.at);
                if (seen.has(label)) return [];
                seen.add(label);
                return [`<a class="ref" href="#${e(id)}">${e(label)}</a>`];
            })
            .join(' ');
    }

    #speakerClass(name: string): string {
        return `c${(this.#speakerIndex.get(name) ?? 0) % SPEAKER_COLORS}`;
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
        return `<h1>${e(outline.title)}</h1>
<p class="dateline"><time datetime="${e(startedAt.toISOString())}">${e(dateText)} ${e(this.#clock(startedAt))}</time>–<time datetime="${e(endedAt.toISOString())}">${endDate === dateText ? '' : `${e(endDate)} `}${e(this.#clock(endedAt))}</time></p>
<dl class="facts">
<div><dt>サーバー</dt><dd>${e(guildName ?? '不明')}</dd></div>
<div><dt>対象</dt><dd>${e(periodLabel)}(録音 ${transcript.sessions.length} 件)</dd></div>
<div><dt>発言</dt><dd>${lines.length.toLocaleString('ja-JP')} 行</dd></div>
</dl>
<p class="notice">音声を自動で文字起こしし、AIが校正したものです。話者と時刻は原データのままです。校正した発言は「原文」から元の認識結果を確認できます。</p>`;
    }

    speakerList(): string {
        return this.#input.transcript.participants
            .map(
                (name, i) =>
                    `<li><button type="button" class="${this.#speakerClass(name)}" data-s="${i}">${e(name)}</button></li>`
            )
            .join('');
    }

    toc(): string {
        const items = this.#input.outline.chapters.map((chapter, i) => {
            const line = this.#chapterLines[i]?.[0];
            return `<li>${line ? `<time datetime="${e(line.iso)}">${e(this.#clock(line.at))}</time> ` : ''}<a href="#ch-${i + 1}">${e(chapter.title)}</a></li>`;
        });
        return `<ol>${items.join('')}</ol>`;
    }

    summary(): string {
        const { outline } = this.#input;
        const card = (heading: string, points: readonly Point[]): string =>
            points.length === 0
                ? ''
                : `<section class="card"><h3>${heading}</h3><ul>${points.map((p) => this.#point(p)).join('')}</ul></section>`;
        const pair =
            card('決まったこと', outline.decisions) +
            card('残った問い', outline.open_questions);
        return `<div class="cards">
<section class="card"><h3>概要</h3><p>${e(outline.lede)}</p></section>
${card('主な内容', outline.key_points)}
${pair === '' ? '' : `<div class="cards pair">${pair}</div>`}
</div>`;
    }

    map(): string {
        const { map } = this.#input;
        return map === null ? this.#threads() : this.#conversationMap(map);
    }

    #conversationMap(map: ConversationMap): string {
        const through =
            map.through_line === null
                ? ''
                : `<section class="card"><h3>会話を貫く問い</h3><p>${e(map.through_line)}</p></section>`;
        const debates = map.debates.map((d) => this.#debate(d)).join('\n');
        return `${through}
<h3>全体の流れ</h3>
<ol class="phases">
${map.phases.map((p) => this.#phase(p, map.debates)).join('\n')}
</ol>
${debates === '' ? '' : `<h3>議論図</h3>\n${debates}`}`;
    }

    #phase(phase: Phase, debates: readonly Debate[]): string {
        const first = this.#chapterLines[phase.first_chapter - 1]?.[0];
        const last = this.#chapterLines[phase.last_chapter - 1]?.at(-1);
        const range =
            first === undefined || last === undefined
                ? ''
                : `<p class="dateline"><time datetime="${e(first.iso)}">${e(this.#clock(first.at))}</time>–<time datetime="${e(last.iso)}">${e(this.#clock(last.at))}</time></p>`;
        const chapters = this.#input.outline.chapters.flatMap((chapter, i) =>
            i + 1 >= phase.first_chapter && i + 1 <= phase.last_chapter
                ? [`<a href="#ch-${i + 1}">${e(chapter.title)}</a>`]
                : []
        );
        const related = debates.flatMap((debate) => {
            const start = Math.min(...debate.chapters);
            return start >= phase.first_chapter && start <= phase.last_chapter
                ? [debateLink(debate)]
                : [];
        });
        const fact = (label: string, items: readonly string[]): string =>
            items.length === 0
                ? ''
                : `<div><dt>${label}</dt><dd>${items.join(' / ')}</dd></div>`;
        const transition =
            phase.transition === null
                ? ''
                : `<p class="transition"><span aria-hidden="true">↓</span> ${e(phase.transition)}</p>`;
        return `<li>
<section class="card">
${range}
<h4>${e(phase.title)}</h4>
<p>${e(phase.summary)}</p>
<dl class="phase-facts">${fact('話題', phase.keywords.map(e))}${fact('章', chapters)}${fact('議論図', related)}</dl>
</section>
${transition}
</li>`;
    }

    #debate(debate: Debate): string {
        const branches = debate.branches
            .map(
                (branch) => `<section class="branch">
<h5>${e(branch.stance)}</h5>
<ol class="moves">
${branch.moves
    .map(
        (move) =>
            `<li><p class="move-meta"><span class="kind">${MOVE_LABELS[move.kind]}</span> <b class="${this.#speakerClass(move.speaker)}">${e(move.speaker)}</b> ${this.#refs(move.refs)}</p><p>${e(move.text)}</p></li>`
    )
    .join('\n')}
</ol>
</section>`
            )
            .join('\n');
        const titles = new Map(
            (this.#input.map?.debates ?? []).map((d) => [d.id, d.title])
        );
        const links = debate.links
            .map(
                (link) =>
                    `<li><a href="#${e(link.to)}">${e(titles.get(link.to) ?? link.to)}</a>: ${e(link.text)}</li>`
            )
            .join('');
        return `<section class="debate" id="${e(debate.id)}">
<div class="card">
<h4>${e(debate.title)}</h4>
<p>${e(debate.question)}</p>
</div>
<div class="branches" data-n="${debate.branches.length}">
${branches}
</div>
<div class="card">
<p><b>${OUTCOME_LABELS[debate.outcome.status]}</b> ${e(debate.outcome.text)} ${this.#refs(debate.outcome.refs)}</p>
${links === '' ? '' : `<ul class="debate-links">${links}</ul>`}
</div>
</section>`;
    }

    #threads(): string {
        const { threads } = this.#input.outline;
        if (threads.length === 0) return '<p>まとめる論点はありません。</p>';
        const cards = threads
            .map(
                (thread) => `<section class="card thread">
<h3>${e(thread.topic)}</h3>
<p class="question">${e(thread.question)}</p>
<dl>${thread.positions
                    .map(
                        (p) =>
                            `<dt class="${this.#speakerClass(p.speaker)}">${e(p.speaker)}</dt><dd>${e(p.text)} ${this.#refs(p.refs)}</dd>`
                    )
                    .join('')}</dl>
</section>`
            )
            .join('\n');
        return `<div class="cards">${cards}</div>`;
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
                              .map((f) => `<li>${e(f.text)}</li>`)
                              .join('')}</ul>`;
                return `<section id="ch-${number}">
<h3>${e(chapter.title)}</h3>
<div class="card">
<p>${e(chapter.summary)}</p>
${flow}
<p class="point"><b>論点</b> ${e(chapter.point)}</p>
${this.#chapterDebates(number)}
${this.#chapterSources(number)}
</div>
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
        const spoken = turn.lines
            .filter((l) => corrections.get(l.id)?.kind !== 'drop')
            .map((l) => corrections.get(l.id)?.text ?? l.raw)
            .join('');
        const sayClass =
            spoken.length <= SHORT_TURN_CHARS ? 'say short' : 'say';
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
            ? '<small>(未校正)</small>'
            : '';
        return `<li id="${turn.id}" data-s="${speakerIndex}"><p class="who"><a href="#${turn.id}"><time datetime="${e(first.iso)}">${e(this.#clock(first.at))}</time></a> <b class="${this.#speakerClass(turn.speaker)}">${e(turn.speaker)}${unchecked}</b></p>${say === '' ? '' : `<p class="${sayClass}">${say}</p>`}${original}${droppedNote}</li>`;
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

    #chapterDebates(chapter: number): string {
        const related = (this.#input.map?.debates ?? []).filter((d) =>
            d.chapters.includes(chapter)
        );
        return related.length === 0
            ? ''
            : `<p class="point"><b>議論図</b> ${related.map(debateLink).join(' / ')}</p>`;
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

function debateLink(debate: Debate): string {
    return `<a href="#${e(debate.id)}">${e(debate.title)}</a>`;
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
