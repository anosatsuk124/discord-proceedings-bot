import path from 'node:path';
import type { AgentKind, AgentSettings } from './agent-cli.ts';
import type { SandboxMode } from './sandbox.ts';

export interface WorkerConfig {
    readonly jobsDir: string;
    /** タスクの一時ディレクトリの置き場所(Web に出るタスクはここで動かす)。 */
    readonly taskRoot: string;
    /** null なら無効。 */
    readonly agent: AgentSettings | null;
    readonly sandbox: SandboxMode;
    readonly extraDomains: readonly string[];
    readonly concurrency: number;
    readonly taskTimeoutMs: number;
    readonly research: {
        readonly enabled: boolean;
        readonly domains: readonly string[];
        readonly maxTopics: number;
    };
}

/**
 * 調査で取得を許すドメインの既定値。srt は *.com のような広い指定を受け付けないので列挙する。
 * 論文・事典・公的機関・技術文書を中心にしている。増やすときは REPORT_RESEARCH_ALLOWED_DOMAINS で。
 */
export const DEFAULT_RESEARCH_DOMAINS: readonly string[] = [
    '*.wikipedia.org',
    '*.wiktionary.org',
    '*.wikimedia.org',
    'arxiv.org',
    '*.arxiv.org',
    'doi.org',
    'dx.doi.org',
    'api.crossref.org',
    'api.openalex.org',
    'openalex.org',
    'api.semanticscholar.org',
    'www.semanticscholar.org',
    'aclanthology.org',
    'openreview.net',
    'plato.stanford.edu',
    'iep.utm.edu',
    'philarchive.org',
    'philpapers.org',
    'pubmed.ncbi.nlm.nih.gov',
    'www.ncbi.nlm.nih.gov',
    'pmc.ncbi.nlm.nih.gov',
    'dl.acm.org',
    'ieeexplore.ieee.org',
    'link.springer.com',
    'www.nature.com',
    'www.science.org',
    'www.sciencedirect.com',
    'www.jstor.org',
    'academic.oup.com',
    'www.cambridge.org',
    'onlinelibrary.wiley.com',
    'www.tandfonline.com',
    'journals.plos.org',
    'www.jstage.jst.go.jp',
    'cir.nii.ac.jp',
    'ci.nii.ac.jp',
    'ndlsearch.ndl.go.jp',
    'dl.ndl.go.jp',
    'laws.e-gov.go.jp',
    'elaws.e-gov.go.jp',
    'kotobank.jp',
    'www.britannica.com',
    'developer.mozilla.org',
    'docs.python.org',
    'github.com',
    'raw.githubusercontent.com',
    'www.rfc-editor.org',
    'www.w3.org',
];

const AGENT_KINDS: readonly string[] = ['claude', 'codex', 'opencode'];

function list(value: string | undefined): string[] {
    return (value ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item !== '');
}

function integer(
    env: NodeJS.ProcessEnv,
    name: string,
    fallback: number,
    minimum: number
): number {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < minimum) {
        throw new Error(`${name} must be an integer >= ${minimum}: ${raw}`);
    }
    return value;
}

export function loadWorkerConfig(
    env: NodeJS.ProcessEnv = process.env
): WorkerConfig {
    const kind = env['REPORT_AGENT']?.trim().toLowerCase() || 'off';
    if (kind !== 'off' && !AGENT_KINDS.includes(kind)) {
        throw new Error(`REPORT_AGENT is not supported: ${kind}`);
    }
    const budget = env['REPORT_AGENT_MAX_BUDGET_USD']?.trim();
    const sandbox = env['REPORT_AGENT_SANDBOX']?.trim().toLowerCase() || 'srt';
    if (sandbox !== 'srt' && sandbox !== 'none') {
        throw new Error(`REPORT_AGENT_SANDBOX must be srt or none: ${sandbox}`);
    }
    const researchDomains = list(env['REPORT_RESEARCH_ALLOWED_DOMAINS']);
    return {
        jobsDir: path.resolve(
            env['REPORT_JOBS_DIR']?.trim() || 'data/report-jobs'
        ),
        taskRoot: path.resolve(
            env['REPORT_TASK_ROOT']?.trim() || '/tmp/report-tasks'
        ),
        agent:
            kind === 'off'
                ? null
                : {
                      kind: kind as AgentKind,
                      model: env['REPORT_AGENT_MODEL']?.trim() || null,
                      effort: env['REPORT_AGENT_EFFORT']?.trim() || null,
                      maxBudgetUsd: budget ? Number(budget) : null,
                  },
        sandbox,
        extraDomains: list(env['REPORT_AGENT_ALLOWED_DOMAINS']),
        concurrency: integer(env, 'REPORT_AGENT_CONCURRENCY', 3, 1),
        taskTimeoutMs:
            integer(env, 'REPORT_AGENT_TASK_TIMEOUT_SECONDS', 900, 30) * 1000,
        research: {
            enabled:
                (env['REPORT_RESEARCH']?.trim().toLowerCase() || 'on') !==
                'off',
            domains:
                researchDomains.length > 0
                    ? researchDomains
                    : DEFAULT_RESEARCH_DOMAINS,
            maxTopics: integer(env, 'REPORT_RESEARCH_MAX_TOPICS', 10, 0),
        },
    };
}
