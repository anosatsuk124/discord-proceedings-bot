import { setTimeout as delay } from 'node:timers/promises';
import {
    DeployFailedError,
    type Publisher,
    type PublishFile,
} from './publisher.ts';
import { readZipEntry } from './unzip.ts';

/**
 * simple-static-pager に公開する。
 *
 * git コマンドを使わず GitHub の Git Data API で 1 コミットを作る(bot のイメージには
 * git が入っていない)。URL は Actions の Job summary を API で読めないので、workflow が
 * 上げる artifact の links.json から読む。
 */

const API_ORIGIN = 'https://api.github.com';
const ARTIFACT_NAME = 'links';
const LINKS_FILE = 'links.json';
const FAST_FORWARD_ATTEMPTS = 3;

export interface GithubPagerOptions {
    /** owner/name */
    readonly repo: string;
    readonly branch: string;
    readonly token: string;
    readonly fetch?: typeof fetch;
    readonly sleep?: (ms: number) => Promise<unknown>;
    readonly pollIntervalMs?: number;
    /** push してから run が現れるまでの待ち時間の上限。 */
    readonly runAppearTimeoutMs?: number;
    /** run の完了を待つ時間の上限。 */
    readonly runTimeoutMs?: number;
}

interface WorkflowRun {
    readonly id: number;
    readonly status: string;
    readonly conclusion: string | null;
}

/** 公開先のパスとして受け付ける形か確かめる。ほかのファイルを書き換えられないようにする。 */
export function assertPublishablePath(file: string): void {
    const parts = file.split('/');
    if (
        parts[0] !== 'reports' ||
        parts.length < 2 ||
        !file.endsWith('.html') ||
        file.includes('\\') ||
        parts.some((p) => p === '' || p === '.' || p === '..')
    ) {
        throw new Error(`refusing to publish outside reports/: ${file}`);
    }
}

export class GithubPagerPublisher implements Publisher {
    readonly #repo: string;
    readonly #branch: string;
    readonly #token: string;
    readonly #fetch: typeof fetch;
    readonly #sleep: (ms: number) => Promise<unknown>;
    readonly #pollIntervalMs: number;
    readonly #runAppearTimeoutMs: number;
    readonly #runTimeoutMs: number;

    constructor(options: GithubPagerOptions) {
        this.#repo = options.repo;
        this.#branch = options.branch;
        this.#token = options.token;
        this.#fetch = options.fetch ?? fetch;
        this.#sleep = options.sleep ?? delay;
        this.#pollIntervalMs = options.pollIntervalMs ?? 10_000;
        this.#runAppearTimeoutMs = options.runAppearTimeoutMs ?? 180_000;
        this.#runTimeoutMs = options.runTimeoutMs ?? 30 * 60_000;
    }

    async commit(
        files: readonly PublishFile[],
        message: string
    ): Promise<string> {
        for (const file of files) assertPublishablePath(file.path);
        const blobs = await Promise.all(
            files.map(async (file) => {
                const blob = await this.#api<{ sha: string }>(
                    'POST',
                    '/git/blobs',
                    {
                        content: file.content.toString('base64'),
                        encoding: 'base64',
                    }
                );
                return {
                    path: file.path,
                    mode: '100644',
                    type: 'blob',
                    sha: blob.sha,
                };
            })
        );
        for (let attempt = 1; ; attempt += 1) {
            const head = await this.#api<{ object: { sha: string } }>(
                'GET',
                `/git/ref/heads/${this.#branch}`
            );
            const parent = await this.#api<{ tree: { sha: string } }>(
                'GET',
                `/git/commits/${head.object.sha}`
            );
            // やり直しで内容が同じなら空のコミットになるが、push は起きるのでデプロイされる。
            const tree = await this.#api<{ sha: string }>(
                'POST',
                '/git/trees',
                { base_tree: parent.tree.sha, tree: blobs }
            );
            const commit = await this.#api<{ sha: string }>(
                'POST',
                '/git/commits',
                {
                    message,
                    tree: tree.sha,
                    parents: [head.object.sha],
                }
            );
            const response = await this.#request(
                'PATCH',
                `/git/refs/heads/${this.#branch}`,
                { sha: commit.sha }
            );
            if (response.ok) return commit.sha;
            // 422 は fast-forward できないとき(別のコミットが先に入った)。作り直す。
            if (response.status !== 422 || attempt >= FAST_FORWARD_ATTEMPTS) {
                throw new Error(
                    `failed to update ${this.#branch}: HTTP ${response.status}`
                );
            }
        }
    }

    async urlsFor(
        ref: string,
        paths: readonly string[]
    ): Promise<ReadonlyMap<string, string>> {
        const run = await this.#waitForRun(ref);
        const links = await this.#readLinks(run.id);
        const urls = new Map<string, string>();
        for (const file of paths) {
            const url = links.get(relativeToReports(file));
            if (url === undefined) {
                throw new DeployFailedError(
                    `the deployment has no URL for ${file}`
                );
            }
            urls.set(file, url);
        }
        return urls;
    }

    async #waitForRun(sha: string): Promise<WorkflowRun> {
        const started = Date.now();
        const query = new URLSearchParams({
            head_sha: sha,
            event: 'push',
            per_page: '20',
        });
        for (;;) {
            const { workflow_runs: runs } = await this.#api<{
                workflow_runs: WorkflowRun[];
            }>('GET', `/actions/runs?${query.toString()}`);
            const run = runs[0];
            if (run?.status === 'completed') {
                if (run.conclusion === 'success') return run;
                throw new DeployFailedError(
                    `deployment run ${run.id} ended with ${run.conclusion}`
                );
            }
            const waited = Date.now() - started;
            if (run === undefined && waited > this.#runAppearTimeoutMs) {
                throw new DeployFailedError(
                    `no deployment run appeared for ${sha}`
                );
            }
            if (waited > this.#runTimeoutMs) {
                throw new Error(`timed out waiting for the run of ${sha}`);
            }
            await this.#sleep(this.#pollIntervalMs);
        }
    }

    async #readLinks(runId: number): Promise<Map<string, string>> {
        const query = new URLSearchParams({ name: ARTIFACT_NAME });
        const { artifacts } = await this.#api<{
            artifacts: Array<{ id: number; expired: boolean }>;
        }>('GET', `/actions/runs/${runId}/artifacts?${query.toString()}`);
        const artifact = artifacts.find((a) => !a.expired);
        if (artifact === undefined) {
            throw new DeployFailedError(`run ${runId} has no links artifact`);
        }
        const zip = await this.#downloadArtifact(artifact.id);
        const entry = readZipEntry(zip, LINKS_FILE);
        if (entry === null) {
            throw new DeployFailedError(`artifact has no ${LINKS_FILE}`);
        }
        const parsed = JSON.parse(entry.toString('utf8')) as {
            files: Array<{ file: string; url: string }>;
        };
        return new Map(
            parsed.files.map((f) => [f.file.normalize('NFC'), f.url])
        );
    }

    /** 実体は署名付き URL への 302。転送先にはトークンを送らない。 */
    async #downloadArtifact(id: number): Promise<Buffer> {
        const response = await this.#request(
            'GET',
            `/actions/artifacts/${id}/zip`,
            undefined,
            'manual'
        );
        if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get('location');
            if (location === null) {
                throw new Error('artifact redirect has no location');
            }
            const blob = await this.#fetch(location);
            if (!blob.ok) {
                throw new Error(`artifact download: HTTP ${blob.status}`);
            }
            return Buffer.from(await blob.arrayBuffer());
        }
        if (!response.ok) {
            throw new Error(`artifact download: HTTP ${response.status}`);
        }
        return Buffer.from(await response.arrayBuffer());
    }

    async #api<T>(
        method: string,
        pathname: string,
        body?: unknown
    ): Promise<T> {
        const response = await this.#request(method, pathname, body);
        if (!response.ok) {
            // 本文にはトークンや URL が入らないが、長くなるのでステータスだけにする。
            throw new Error(
                `GitHub API ${method} ${pathname}: HTTP ${response.status}`
            );
        }
        return (await response.json()) as T;
    }

    #request(
        method: string,
        pathname: string,
        body?: unknown,
        redirect: 'follow' | 'manual' = 'follow'
    ): Promise<Response> {
        return this.#fetch(`${API_ORIGIN}/repos/${this.#repo}${pathname}`, {
            method,
            redirect,
            headers: {
                Authorization: `Bearer ${this.#token}`,
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
                'User-Agent': 'discord-proceedings-bot',
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
    }
}

function relativeToReports(file: string): string {
    return file.replace(/^reports\//, '').normalize('NFC');
}
