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
}

export interface JobFailure {
    readonly status: 'failed';
    readonly error: string;
}

export type JobResult = JobSuccess | JobFailure;
