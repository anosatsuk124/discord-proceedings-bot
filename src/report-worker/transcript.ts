import type { CsvRow } from './csv.ts';

/** 文字起こしの 1 行。id はページ内のアンカーにもなる。 */
export interface Line {
    readonly id: string;
    readonly session: number;
    readonly speaker: string;
    readonly at: Date;
    /** CSV に書かれていた時刻(タイムゾーン付き)。 */
    readonly iso: string;
    readonly raw: string;
}

export interface SessionMeta {
    readonly index: number;
    readonly sessionId: string;
    readonly channelName: string | null;
    readonly startedAt: Date;
    readonly endedAt: Date;
}

export interface Transcript {
    readonly lines: readonly Line[];
    readonly sessions: readonly SessionMeta[];
    /** 発言の多い順。 */
    readonly participants: readonly string[];
    readonly byId: ReadonlyMap<string, Line>;
    /** 行の並び順。章の連続性の確認に使う。 */
    readonly position: ReadonlyMap<string, number>;
}

export interface SessionInput {
    readonly sessionId: string;
    readonly channelName: string | null;
    readonly startedAt: Date;
    readonly endedAt: Date;
    readonly rows: readonly CsvRow[];
}

/** 複数のセッションを時刻順につなぎ、通し番号の行にする。 */
export function buildTranscript(inputs: readonly SessionInput[]): Transcript {
    const ordered = [...inputs].sort(
        (a, b) => a.startedAt.getTime() - b.startedAt.getTime()
    );
    const lines: Line[] = [];
    const sessions: SessionMeta[] = [];
    ordered.forEach((input, index) => {
        sessions.push({
            index,
            sessionId: input.sessionId,
            channelName: input.channelName,
            startedAt: input.startedAt,
            endedAt: input.endedAt,
        });
        for (const row of input.rows) {
            const at = new Date(row.date);
            if (Number.isNaN(at.getTime())) {
                throw new Error(`invalid date in CSV: ${row.date}`);
            }
            lines.push({
                id: `l${lines.length + 1}`,
                session: index,
                speaker: row.speaker,
                at,
                iso: row.date,
                raw: row.talk,
            });
        }
    });
    if (lines.length === 0) throw new Error('the transcript has no lines');
    const counts = new Map<string, number>();
    for (const line of lines) {
        counts.set(line.speaker, (counts.get(line.speaker) ?? 0) + 1);
    }
    return {
        lines,
        sessions,
        participants: [...counts.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([speaker]) => speaker),
        byId: new Map(lines.map((line) => [line.id, line])),
        position: new Map(lines.map((line, i) => [line.id, i])),
    };
}

/** Claude の Read の 1 回分に収まる大きさ。これを超えないようファイルを分ける。 */
const MAX_FILE_CHARS = 30_000;

/** 時刻を分までにする(LLM に渡す文字数を減らすため、毎行には書かない)。 */
function minuteOf(date: Date, timeZone: string): string {
    return new Intl.DateTimeFormat('ja-JP', {
        timeZone,
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
    }).format(date);
}

/** 話者の略称。LLM に渡す文字数を減らす。 */
function speakerLegend(participants: readonly string[]): Map<string, string> {
    return new Map(participants.map((name, i) => [name, `S${i + 1}`]));
}

/**
 * LLM に渡す全文を作る。Read の上限に収まるようファイルに分ける。
 * 形式は `l12 S1 本文`。分が変わるたびに時刻の行を入れる。
 */
export function renderForOutline(
    transcript: Pick<Transcript, 'sessions' | 'participants'>,
    lines: readonly Line[],
    timeZone: string
): string[] {
    const legend = speakerLegend(transcript.participants);
    const header =
        '話者の略称: ' +
        [...legend].map(([name, alias]) => `${alias}=${name}`).join('、') +
        '\n\n';
    const files: string[] = [];
    let current = header;
    let minute = '';
    let session = -1;
    const push = (text: string): void => {
        if (current.length + text.length > MAX_FILE_CHARS) {
            files.push(current);
            current = '';
        }
        current += text;
    };
    for (const line of lines) {
        if (line.session !== session) {
            session = line.session;
            const meta = transcript.sessions[session];
            push(
                `\n=== 録音 ${session + 1}: ${meta?.channelName ?? '(チャンネル不明)'} ===\n`
            );
            minute = '';
        }
        const lineMinute = minuteOf(line.at, timeZone);
        if (lineMinute !== minute) {
            minute = lineMinute;
            push(`--- ${minute} ---\n`);
        }
        push(`${line.id} ${legend.get(line.speaker) ?? '?'} ${line.raw}\n`);
    }
    files.push(current);
    return files;
}

export interface Chunk {
    readonly id: string;
    readonly target: readonly Line[];
    readonly before: readonly Line[];
    readonly after: readonly Line[];
}

/** 校正の単位に分ける。前後の行は文脈として渡すだけで、校正の対象にはしない。 */
export function chunkLines(
    lines: readonly Line[],
    size: number,
    contextSize: number
): Chunk[] {
    const chunks: Chunk[] = [];
    for (let start = 0; start < lines.length; start += size) {
        const end = Math.min(start + size, lines.length);
        chunks.push({
            id: `p${String(chunks.length + 1).padStart(3, '0')}`,
            target: lines.slice(start, end),
            before: lines.slice(Math.max(0, start - contextSize), start),
            after: lines.slice(end, end + contextSize),
        });
    }
    return chunks;
}

export function renderChunk(chunk: Chunk): string {
    const render = (lines: readonly Line[]): string =>
        lines.map((l) => `${l.id} ${l.speaker}: ${l.raw}`).join('\n');
    return [
        '=== 前の文脈(校正しない) ===',
        render(chunk.before),
        '',
        '=== 校正対象 ===',
        render(chunk.target),
        '',
        '=== 後の文脈(校正しない) ===',
        render(chunk.after),
        '',
    ].join('\n');
}
