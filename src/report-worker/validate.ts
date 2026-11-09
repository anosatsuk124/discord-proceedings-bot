import type { Chunk, Line, Transcript } from './transcript.ts';
import {
    SOURCE_KINDS,
    type Chapter,
    type CorrectionResult,
    type FlowStep,
    type GlossaryItem,
    type LineCorrection,
    type Outline,
    type Point,
    type Position,
    type ResearchResult,
    type ResearchTopic,
    type Source,
    type SourceKind,
    type Thread,
} from './types.ts';

/**
 * LLM の出力を機械的に確かめる。エラーの文はそのまま LLM への再依頼に使う。
 * 話者と時刻は LLM の出力に含めないので、書き換えられることはない。
 */

export type Validation<T> =
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly errors: readonly string[] };

const MAX_LIST = 40;

class Reader {
    readonly errors: string[] = [];

    fail(path: string, message: string): void {
        this.errors.push(`${path}: ${message}`);
    }

    object(value: unknown, path: string): Record<string, unknown> {
        if (
            typeof value !== 'object' ||
            value === null ||
            Array.isArray(value)
        ) {
            this.fail(path, 'オブジェクトにしてください');
            return {};
        }
        return value as Record<string, unknown>;
    }

    array(value: unknown, path: string, max = MAX_LIST): unknown[] {
        if (!Array.isArray(value)) {
            this.fail(path, '配列にしてください');
            return [];
        }
        if (value.length > max) {
            this.fail(path, `${max} 個以下にしてください(${value.length} 個)`);
        }
        return value;
    }

    /** 改行は 1 つの空白にする。HTML はコンパイル時にエスケープするので、ここでは見ない。 */
    string(value: unknown, path: string, max: number): string {
        if (typeof value !== 'string' || value.trim() === '') {
            this.fail(path, '空でない文字列にしてください');
            return '';
        }
        const text = value.replace(/\s*\n\s*/g, ' ').trim();
        if (text.length > max) {
            this.fail(
                path,
                `${max} 文字以下にしてください(${text.length} 文字)`
            );
        }
        return text;
    }

    refs(
        value: unknown,
        path: string,
        byId: ReadonlyMap<string, Line>
    ): string[] {
        const refs: string[] = [];
        this.array(value, path, 8).forEach((id, i) => {
            if (typeof id !== 'string' || !byId.has(id)) {
                this.fail(`${path}[${i}]`, `存在しない行です: ${String(id)}`);
            } else {
                refs.push(id);
            }
        });
        if (refs.length === 0)
            this.fail(path, '出典の行を 1 つ以上書いてください');
        return refs;
    }

    point(
        value: unknown,
        path: string,
        byId: ReadonlyMap<string, Line>
    ): Point {
        const o = this.object(value, path);
        return {
            text: this.string(o['text'], `${path}.text`, 300),
            refs: this.refs(o['refs'], `${path}.refs`, byId),
        };
    }

    points(
        value: unknown,
        path: string,
        byId: ReadonlyMap<string, Line>,
        max: number
    ): Point[] {
        return this.array(value, path, max).map((v, i) =>
            this.point(v, `${path}[${i}]`, byId)
        );
    }

    result<T>(value: T): Validation<T> {
        return this.errors.length === 0
            ? { ok: true, value }
            : { ok: false, errors: this.errors };
    }
}

export interface OutlineContext {
    readonly transcript: Pick<Transcript, 'byId' | 'position' | 'participants'>;
    /** この outline が対象にする行。 */
    readonly lines: readonly Line[];
    readonly maxResearchTopics: number;
}

export function validateOutline(
    value: unknown,
    context: OutlineContext
): Validation<Outline> {
    const r = new Reader();
    const { byId, participants } = context.transcript;
    const o = r.object(value, '$');
    const chapters = r
        .array(o['chapters'], '$.chapters', 60)
        .map((v, i) => readChapter(r, v, `$.chapters[${i}]`, byId));
    checkChapterContinuity(r, chapters, context);
    const glossary = r
        .array(o['glossary'], '$.glossary', 80)
        .map((v, i): GlossaryItem => {
            const g = r.object(v, `$.glossary[${i}]`);
            return {
                term: r.string(g['term'], `$.glossary[${i}].term`, 80),
                heard: r
                    .array(g['heard'], `$.glossary[${i}].heard`, 10)
                    .map((h, j) =>
                        r.string(h, `$.glossary[${i}].heard[${j}]`, 80)
                    ),
                note: r.string(g['note'], `$.glossary[${i}].note`, 200),
            };
        });
    const threads = r
        .array(o['threads'], '$.threads', 12)
        .map((v, i) => readThread(r, v, `$.threads[${i}]`, byId, participants));
    const research_topics = readResearchTopics(
        r,
        o['research_topics'],
        chapters.length,
        participants,
        context.maxResearchTopics
    );
    return r.result({
        title: r.string(o['title'], '$.title', 40),
        lede: r.string(o['lede'], '$.lede', 500),
        key_points: r.points(o['key_points'], '$.key_points', byId, 12),
        decisions: r.points(o['decisions'], '$.decisions', byId, 12),
        open_questions: r.points(
            o['open_questions'],
            '$.open_questions',
            byId,
            12
        ),
        chapters,
        threads,
        glossary,
        research_topics,
    });
}

function readChapter(
    r: Reader,
    value: unknown,
    path: string,
    byId: ReadonlyMap<string, Line>
): Chapter {
    const c = r.object(value, path);
    const id = (key: string): string => {
        const v = c[key];
        if (typeof v !== 'string' || !byId.has(v)) {
            r.fail(`${path}.${key}`, `存在しない行です: ${String(v)}`);
            return '';
        }
        return v;
    };
    const flow = r.array(c['flow'], `${path}.flow`, 3).map((v, i): FlowStep => {
        const f = r.object(v, `${path}.flow[${i}]`);
        return {
            label: r.string(f['label'], `${path}.flow[${i}].label`, 12),
            text: r.string(f['text'], `${path}.flow[${i}].text`, 160),
        };
    });
    return {
        title: r.string(c['title'], `${path}.title`, 40),
        start: id('start'),
        end: id('end'),
        summary: r.string(c['summary'], `${path}.summary`, 400),
        flow,
        point: r.string(c['point'], `${path}.point`, 240),
    };
}

/** 章が全行を隙間なく覆い、録音をまたがないことを確かめる。 */
function checkChapterContinuity(
    r: Reader,
    chapters: readonly Chapter[],
    context: OutlineContext
): void {
    const { lines } = context;
    const { byId, position } = context.transcript;
    const first = lines[0];
    const last = lines.at(-1);
    if (chapters.length === 0) {
        r.fail('$.chapters', '章を 1 つ以上書いてください');
        return;
    }
    if (r.errors.length > 0 || first === undefined || last === undefined) {
        return;
    }
    let expected = position.get(first.id) ?? 0;
    chapters.forEach((chapter, i) => {
        const start = position.get(chapter.start) ?? -1;
        const end = position.get(chapter.end) ?? -1;
        if (start !== expected) {
            r.fail(
                `$.chapters[${i}].start`,
                `前の章の直後の行(${lines[expected - (position.get(first.id) ?? 0)]?.id})から始めてください`
            );
        }
        if (end < start) {
            r.fail(`$.chapters[${i}].end`, 'start より後の行にしてください');
        }
        if (
            byId.get(chapter.start)?.session !== byId.get(chapter.end)?.session
        ) {
            r.fail(`$.chapters[${i}]`, '1 つの章が録音をまたいでいます');
        }
        expected = end + 1;
    });
    if (chapters.at(-1)?.end !== last.id) {
        r.fail('$.chapters', `最後の章は ${last.id} で終えてください`);
    }
}

function readThread(
    r: Reader,
    value: unknown,
    path: string,
    byId: ReadonlyMap<string, Line>,
    participants: readonly string[]
): Thread {
    const t = r.object(value, path);
    const positions = r
        .array(t['positions'], `${path}.positions`, 8)
        .map((v, i): Position => {
            const p = r.object(v, `${path}.positions[${i}]`);
            const speaker = r.string(
                p['speaker'],
                `${path}.positions[${i}].speaker`,
                80
            );
            if (speaker !== '' && !participants.includes(speaker)) {
                r.fail(
                    `${path}.positions[${i}].speaker`,
                    `参加者の名前にしてください: ${speaker}`
                );
            }
            return {
                speaker,
                text: r.string(p['text'], `${path}.positions[${i}].text`, 300),
                refs: r.refs(p['refs'], `${path}.positions[${i}].refs`, byId),
            };
        });
    return {
        topic: r.string(t['topic'], `${path}.topic`, 60),
        question: r.string(t['question'], `${path}.question`, 200),
        positions,
    };
}

/**
 * 調査トピックを読む。検索語に参加者の名前が入っていたら、外部に出さないよう除外する
 * (LLM に直させるより確実なので、エラーにはしない)。
 */
function readResearchTopics(
    r: Reader,
    value: unknown,
    chapterCount: number,
    participants: readonly string[],
    max: number
): ResearchTopic[] {
    const topics = r
        .array(value, '$.research_topics', max)
        .map((v, i): ResearchTopic => {
            const path = `$.research_topics[${i}]`;
            const t = r.object(v, path);
            const chapters = r
                .array(t['chapters'], `${path}.chapters`, 10)
                .flatMap((n, j): number[] => {
                    if (
                        typeof n !== 'number' ||
                        !Number.isInteger(n) ||
                        n < 1 ||
                        n > chapterCount
                    ) {
                        r.fail(
                            `${path}.chapters[${j}]`,
                            `章番号が範囲外です: ${String(n)}`
                        );
                        return [];
                    }
                    return [n];
                });
            return {
                id: r.string(t['id'], `${path}.id`, 20),
                query: r.string(t['query'], `${path}.query`, 200),
                question: r.string(t['question'], `${path}.question`, 300),
                chapters,
            };
        });
    return topics.filter(
        (t) =>
            !participants.some(
                (name) => t.query.includes(name) || t.question.includes(name)
            )
    );
}

export interface ResearchContext {
    readonly topicId: string;
    readonly maxSources: number;
}

export function validateResearch(
    value: unknown,
    context: ResearchContext
): Validation<ResearchResult> {
    const r = new Reader();
    const o = r.object(value, '$');
    if (o['topic'] !== context.topicId) {
        r.fail('$.topic', `${context.topicId} にしてください`);
    }
    const sources = r
        .array(o['sources'], '$.sources', context.maxSources)
        .map((v, i) => readSource(r, v, `$.sources[${i}]`));
    return r.result({ topic: context.topicId, sources });
}

function readSource(r: Reader, value: unknown, path: string): Source {
    const s = r.object(value, path);
    const url = r.string(s['url'], `${path}.url`, 2000);
    if (url !== '' && !isSafeSourceUrl(url)) {
        r.fail(`${path}.url`, 'https の URL にしてください');
    }
    const kind = s['kind'];
    if (!SOURCE_KINDS.includes(kind as SourceKind)) {
        r.fail(
            `${path}.kind`,
            `${SOURCE_KINDS.join('/')} のどれかにしてください`
        );
    }
    return {
        title: r.string(s['title'], `${path}.title`, 200),
        url,
        kind: kind as SourceKind,
        summary: r.string(s['summary'], `${path}.summary`, 500),
        relevance: r.string(s['relevance'], `${path}.relevance`, 300),
    };
}

/** 埋め込んでよい URL か。https のみで、認証情報を含まないもの。 */
export function isSafeSourceUrl(url: string): boolean {
    try {
        const parsed = new URL(url);
        return (
            parsed.protocol === 'https:' &&
            parsed.username === '' &&
            parsed.password === ''
        );
    } catch {
        return false;
    }
}

/** 長さの比較に使う上限。短い行は増える余地を多めに見る。 */
function maxCorrectedLength(raw: string): number {
    return Math.max(raw.length * 3, raw.length + 40);
}

export function validateCorrection(
    value: unknown,
    chunk: Chunk
): Validation<CorrectionResult> {
    const r = new Reader();
    const o = r.object(value, '$');
    if (o['chunk'] !== chunk.id) {
        r.fail('$.chunk', `${chunk.id} にしてください`);
    }
    const order = new Map(chunk.target.map((line, i) => [line.id, i]));
    const raws = new Map(chunk.target.map((line) => [line.id, line.raw]));
    let previous = -1;
    const lines: LineCorrection[] = [];
    r.array(o['lines'], '$.lines', chunk.target.length).forEach((v, i) => {
        const path = `$.lines[${i}]`;
        const c = r.object(v, path);
        const id = c['id'];
        const position = typeof id === 'string' ? order.get(id) : undefined;
        if (typeof id !== 'string' || position === undefined) {
            r.fail(`${path}.id`, `校正対象の行ではありません: ${String(id)}`);
            return;
        }
        if (position <= previous) {
            r.fail(`${path}.id`, '行の順に、重複なく並べてください');
        }
        previous = position;
        const kind = c['kind'];
        const note =
            typeof c['note'] === 'string' && c['note'].trim() !== ''
                ? c['note'].trim().slice(0, 120)
                : undefined;
        if (kind === 'drop') {
            lines.push({ id, kind, ...(note ? { note } : {}) });
            return;
        }
        if (kind !== 'fix' && kind !== 'infer') {
            r.fail(`${path}.kind`, 'fix / infer / drop のどれかにしてください');
            return;
        }
        const raw = raws.get(id) ?? '';
        const text = r.string(
            c['text'],
            `${path}.text`,
            maxCorrectedLength(raw)
        );
        // 原文と同じなら修正ではないので、記録しない。
        if (text !== raw)
            lines.push({ id, kind, text, ...(note ? { note } : {}) });
    });
    return r.result({ chunk: chunk.id, lines });
}
