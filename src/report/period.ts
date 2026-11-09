/** /gijiroku report の期間指定を、タイムゾーンを考慮した時刻の範囲にする。 */

export interface DateRange {
    readonly start: Date;
    readonly end: Date;
    /** 投稿やページに出す期間の名前。 */
    readonly label: string;
}

/** 利用者が直せる期間指定の誤り。メッセージはそのまま返信に使う。 */
export class PeriodError extends Error {
    override name = 'PeriodError';
}

export const PERIOD_CHOICES = [
    { name: 'pending(まとめていない録音)', value: 'pending' },
    { name: 'today', value: 'today' },
    { name: 'yesterday', value: 'yesterday' },
    { name: 'recent 24h', value: 'recent-24h' },
    { name: 'this week', value: 'this-week' },
    { name: 'last week', value: 'last-week' },
    { name: 'this month', value: 'this-month' },
] as const;

export type PeriodChoice = (typeof PERIOD_CHOICES)[number]['value'];

const HOUR_MS = 60 * 60 * 1000;

interface WallClock {
    readonly year: number;
    readonly month: number;
    readonly day: number;
    readonly hour: number;
    readonly minute: number;
    readonly second: number;
}

function wallClockAt(date: Date, timeZone: string): WallClock {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
    }).formatToParts(date);
    const get = (type: Intl.DateTimeFormatPartTypes): number =>
        Number(parts.find((part) => part.type === type)?.value);
    return {
        year: get('year'),
        month: get('month'),
        day: get('day'),
        hour: get('hour'),
        minute: get('minute'),
        second: get('second'),
    };
}

function offsetMs(date: Date, timeZone: string): number {
    const w = wallClockAt(date, timeZone);
    const asUtc = Date.UTC(
        w.year,
        w.month - 1,
        w.day,
        w.hour,
        w.minute,
        w.second
    );
    return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** 指定のタイムゾーンでの日時を UTC の時刻にする。月や日のあふれは Date.UTC に任せる。 */
export function zonedTime(
    timeZone: string,
    year: number,
    month: number,
    day: number,
    hour = 0,
    minute = 0
): Date {
    const naive = Date.UTC(year, month - 1, day, hour, minute);
    const first = naive - offsetMs(new Date(naive), timeZone);
    // 夏時間の切り替えをまたぐと、最初の推定のオフセットがずれることがある。
    return new Date(naive - offsetMs(new Date(first), timeZone));
}

/** 月曜を 0 とする曜日。 */
function mondayIndex(w: WallClock): number {
    return (new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay() + 6) % 7;
}

/** pending 以外の期間の名前を範囲にする。 */
export function resolvePeriod(
    period: Exclude<PeriodChoice, 'pending'>,
    now: Date,
    timeZone: string
): DateRange {
    const w = wallClockAt(now, timeZone);
    const dayStart = (offset: number): Date =>
        zonedTime(timeZone, w.year, w.month, w.day + offset);
    const monday = -mondayIndex(w);
    switch (period) {
        case 'today':
            return { start: dayStart(0), end: dayStart(1), label: '今日' };
        case 'yesterday':
            return { start: dayStart(-1), end: dayStart(0), label: '昨日' };
        case 'recent-24h':
            return {
                start: new Date(now.getTime() - 24 * HOUR_MS),
                end: now,
                label: '直近24時間',
            };
        case 'this-week':
            return {
                start: dayStart(monday),
                end: dayStart(monday + 7),
                label: '今週',
            };
        case 'last-week':
            return {
                start: dayStart(monday - 7),
                end: dayStart(monday),
                label: '先週',
            };
        case 'this-month':
            return {
                start: zonedTime(timeZone, w.year, w.month, 1),
                end: zonedTime(timeZone, w.year, w.month + 1, 1),
                label: '今月',
            };
    }
}

interface ParsedMoment {
    readonly year: number;
    readonly month: number;
    readonly day: number;
    /** 時刻が書かれていなければ null。 */
    readonly time: { readonly hour: number; readonly minute: number } | null;
}

function parseMoment(text: string, optionName: string): ParsedMoment {
    // Discord の入力欄に引用符ごと書かれることがある。
    const trimmed = text.trim().replace(/^["'「]|["'」]$/g, '');
    const match =
        /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?$/.exec(
            trimmed
        );
    if (match === null) {
        throw new PeriodError(
            `${optionName} は「2026-11-06」か「2026-11-06 21:00」の形で指定してください。`
        );
    }
    const [year, month, day] = [match[1], match[2], match[3]].map(Number) as [
        number,
        number,
        number,
    ];
    const time =
        match[4] === undefined
            ? null
            : { hour: Number(match[4]), minute: Number(match[5]) };
    const check = new Date(Date.UTC(year, month - 1, day));
    if (
        check.getUTCMonth() !== month - 1 ||
        check.getUTCDate() !== day ||
        (time !== null && (time.hour > 23 || time.minute > 59))
    ) {
        throw new PeriodError(`${optionName} の日時が正しくありません。`);
    }
    return { year, month, day, time };
}

/**
 * from と to を範囲にする。to を日付だけで書いたらその日の終わりまでを含める。
 * to を省略したら現在まで。
 */
export function parseRange(
    from: string,
    to: string | null,
    now: Date,
    timeZone: string
): DateRange {
    const f = parseMoment(from, 'from');
    const start = zonedTime(
        timeZone,
        f.year,
        f.month,
        f.day,
        f.time?.hour ?? 0,
        f.time?.minute ?? 0
    );
    let end = now;
    if (to !== null) {
        const t = parseMoment(to, 'to');
        end =
            t.time === null
                ? zonedTime(timeZone, t.year, t.month, t.day + 1)
                : zonedTime(
                      timeZone,
                      t.year,
                      t.month,
                      t.day,
                      t.time.hour,
                      t.time.minute
                  );
    }
    if (end.getTime() <= start.getTime()) {
        throw new PeriodError('to は from より後にしてください。');
    }
    return {
        start,
        end,
        label: to === null ? `${from} 以降` : `${from} 〜 ${to}`,
    };
}

export type ReportSelection =
    | { readonly kind: 'pending' }
    | { readonly kind: 'range'; readonly range: DateRange };

export interface SelectionOptions {
    readonly period: string | null;
    readonly from: string | null;
    readonly to: string | null;
}

/**
 * /gijiroku report のオプションを対象の選び方にする。
 *
 * コマンドの後ろに続けて入力しただけの語は Discord からオプションとして届かない。
 * 既定の対象を決めると意図しない録音でページを作ってしまうので、指定がなければ誤りにする。
 */
export function parseSelection(
    { period, from, to }: SelectionOptions,
    now: Date,
    timeZone: string
): ReportSelection {
    if (period !== null && (from !== null || to !== null)) {
        throw new PeriodError('period と from / to は同時に指定できません。');
    }
    if (from === null && to !== null) {
        throw new PeriodError('to を使うときは from も指定してください。');
    }
    if (from !== null) {
        return { kind: 'range', range: parseRange(from, to, now, timeZone) };
    }
    if (period === null) {
        throw new PeriodError(
            '対象の期間を指定してください。period の候補から選ぶか(today など)、from に開始日時を入れます。'
        );
    }
    if (period === 'pending') return { kind: 'pending' };
    return {
        kind: 'range',
        range: resolvePeriod(
            period as Exclude<PeriodChoice, 'pending'>,
            now,
            timeZone
        ),
    };
}

/** その時刻の年と月(タイムゾーン考慮)。公開先のパスに使う。 */
export function yearMonthOf(
    date: Date,
    timeZone: string
): { readonly year: string; readonly month: string } {
    const w = wallClockAt(date, timeZone);
    return {
        year: String(w.year),
        month: String(w.month).padStart(2, '0'),
    };
}
