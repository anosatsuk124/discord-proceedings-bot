import type { SessionInfo } from './sessions.ts';
import { coversSessions, isActive, type ReportRecord } from './store.ts';

export interface AutoDecisionInput {
    /** そのサーバーの、録音が終わったセッション。 */
    readonly sessions: readonly SessionInfo[];
    readonly records: readonly ReportRecord[];
    /** いま録音中か、録音を始めている途中か。 */
    readonly recording: boolean;
    readonly now: Date;
    readonly delayMs: number;
    /** これより前に終わったセッションは自動の対象にしない。 */
    readonly autoEnabledAt: Date;
}

/**
 * 自動でまとめるセッションを決める。何もしないなら空の配列を返す。
 *
 * 最後の録音が終わってから delayMs 待ち、まとめていないセッションを 1 ページにする。
 * その間に手動で生成していたら、この回は作らない。残りは次の回に持ち越す。
 */
export function decideAuto(input: AutoDecisionInput): SessionInfo[] {
    const { sessions, records, now, delayMs, autoEnabledAt } = input;
    if (input.recording) return [];
    if (sessions.some((s) => s.state === 'transcribing')) return [];
    if (records.some(isActive)) return [];

    const covered = new Set(
        records.filter(coversSessions).flatMap((r) => r.sessionIds)
    );
    const pending = sessions.filter(
        (s) =>
            s.state === 'ready' &&
            !covered.has(s.sessionId) &&
            s.endedAt.getTime() >= autoEnabledAt.getTime()
    );
    if (pending.length === 0) return [];

    const lastEnded = Math.max(...sessions.map((s) => s.endedAt.getTime()));
    if (now.getTime() - lastEnded < delayMs) return [];

    const handledThisRound = records.some(
        (r) =>
            new Date(r.createdAt).getTime() >= lastEnded &&
            // 手動の失敗は「手動で作った」ことにならない。自動の失敗は同じ回でやり直さない
            // (失敗し続けると LLM を呼び続けてしまうため)。
            (r.trigger === 'auto' || coversSessions(r))
    );
    return handledThisRound ? [] : pending;
}
