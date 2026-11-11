/**
 * bot と report-worker のあいだのファイル契約。
 *
 *   <JOBS_DIR>/<job_id>/input/<session_id>.csv  対象の文字起こし(bot がコピーする)
 *   <JOBS_DIR>/<job_id>/request.json            bot が最後に書く。これがあれば worker が処理する
 *   <JOBS_DIR>/<job_id>/work/                   worker の作業場所
 *   <JOBS_DIR>/<job_id>/report.html             完成したページ
 *   <JOBS_DIR>/<job_id>/result.json             worker が最後に書く。これがあれば処理は終わっている
 *
 * 形を変えるときは JOB_VERSION を上げる。
 */

export const JOB_VERSION = 1;
export const JOB_REQUEST_FILE = 'request.json';
export const JOB_RESULT_FILE = 'result.json';
export const JOB_REPORT_FILE = 'report.html';
export const JOB_INPUT_DIR = 'input';
export const JOB_WORK_DIR = 'work';

export interface JobSession {
    readonly sessionId: string;
    readonly channelName: string | null;
    readonly startedAt: string;
    readonly endedAt: string;
    /** ジョブのディレクトリからの相対パス。 */
    readonly csv: string;
}

export interface JobRequest {
    readonly version: typeof JOB_VERSION;
    readonly jobId: string;
    readonly guildName: string | null;
    readonly timeZone: string;
    readonly periodLabel: string;
    readonly sessions: readonly JobSession[];
    readonly createdAt: string;
}

/** 1 本のページの生成にかかった LLM の費用。 */
export interface JobUsage {
    /** CLI が定価で計算した推定額(USD)の合計。やり直した分も含む。 */
    readonly costUsd: number;
    /** タスクの種類ごとの内訳(USD)。 */
    readonly costByKind: Readonly<Record<string, number>>;
    /** CLI を起動した回数。 */
    readonly runs: number;
    /** 費用が分からなかった回数(時間切れなど)。0 でなければ costUsd は下限。 */
    readonly unreportedRuns: number;
    readonly inputTokens: number;
    readonly cacheWriteTokens: number;
    readonly cacheReadTokens: number;
    readonly outputTokens: number;
    readonly webSearches: number;
}

export interface JobSuccess {
    readonly status: 'ok';
    readonly title: string;
    readonly lede: string;
    readonly participants: readonly string[];
    readonly utteranceCount: number;
    readonly startedAt: string;
    readonly endedAt: string;
    /** ページは作れたが一部を省いたことの記録(校正できなかった区間など)。 */
    readonly warnings: readonly string[];
    readonly usage?: JobUsage | undefined;
}

export interface JobFailure {
    readonly status: 'failed';
    readonly error: string;
    readonly usage?: JobUsage | undefined;
}

export type JobResult = JobSuccess | JobFailure;
