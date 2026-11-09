/** recognizer が書く proceedings.csv を読む。 */

export interface CsvRow {
    readonly speaker: string;
    readonly date: string;
    readonly talk: string;
}

/** RFC 4180 の CSV を行とセルの配列にする。 */
export function parseCsv(text: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < text.length; i += 1) {
        const c = text[i];
        if (quoted) {
            if (c !== '"') cell += c;
            else if (text[i + 1] === '"') {
                cell += '"';
                i += 1;
            } else quoted = false;
        } else if (c === '"') {
            quoted = true;
        } else if (c === ',') {
            row.push(cell);
            cell = '';
        } else if (c === '\n') {
            row.push(cell);
            rows.push(row);
            row = [];
            cell = '';
        } else if (c !== '\r') {
            cell += c;
        }
    }
    if (cell !== '' || row.length > 0) {
        row.push(cell);
        rows.push(row);
    }
    return rows;
}

/**
 * recognizer は表計算ソフトでの数式の実行を防ぐため、= + - @ などで始まるセルの先頭に ' を
 * 付けている。読むときに外す。
 */
function removeFormulaGuard(value: string): string {
    return /^'[=+\-@\t\r]/.test(value) ? value.slice(1) : value;
}

export function parseProceedingsCsv(text: string): CsvRow[] {
    const [header, ...rows] = parseCsv(text);
    if (header?.join(',') !== 'speaker,date,talk') {
        throw new Error(`unexpected CSV header: ${header?.join(',')}`);
    }
    return rows
        .filter((row) => row.length === 3)
        .map(([speaker, date, talk]) => ({
            speaker: removeFormulaGuard(speaker ?? ''),
            date: date ?? '',
            talk: removeFormulaGuard(talk ?? '').trim(),
        }))
        .filter((row) => row.talk !== '');
}
