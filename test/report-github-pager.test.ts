import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import {
    GithubPagerPublisher,
    assertPublishablePath,
} from '../src/report/github-pager.ts';
import { DeployFailedError } from '../src/report/publisher.ts';
import { readZipEntry } from '../src/report/unzip.ts';

const fixture = (): Promise<Buffer> =>
    readFile(new URL('./fixtures/links.zip', import.meta.url));

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status });
}

interface Call {
    readonly url: string;
    readonly method: string;
    readonly body: unknown;
    readonly authorization: string | null;
}

function publisher(handler: Handler): {
    publisher: GithubPagerPublisher;
    calls: Call[];
} {
    const calls: Call[] = [];
    return {
        calls,
        publisher: new GithubPagerPublisher({
            repo: 'o/r',
            branch: 'html',
            token: 'secret',
            sleep: async () => {},
            runAppearTimeoutMs: -1,
            fetch: (async (input: string | URL, init: RequestInit = {}) => {
                const url = String(input);
                const headers = new Headers(init.headers);
                calls.push({
                    url,
                    method: init.method ?? 'GET',
                    body: init.body ? JSON.parse(String(init.body)) : undefined,
                    authorization: headers.get('authorization'),
                });
                return handler(url, init);
            }) as typeof fetch,
        }),
    };
}

const FILE = { path: 'reports/g1/x.html', content: Buffer.from('<p>x') };

function gitApi(refPatch: () => Response): Handler {
    return (url, init) => {
        if (url.endsWith('/git/blobs')) return json({ sha: 'blob' });
        if (url.endsWith('/git/ref/heads/html')) {
            return json({ object: { sha: 'head' } });
        }
        if (url.endsWith('/git/commits/head')) {
            return json({ tree: { sha: 'base-tree' } });
        }
        if (url.endsWith('/git/trees')) return json({ sha: 'new-tree' });
        if (url.endsWith('/git/commits') && init.method === 'POST') {
            return json({ sha: 'commit' });
        }
        if (url.endsWith('/git/refs/heads/html')) return refPatch();
        throw new Error(`unexpected request: ${url}`);
    };
}

describe('zip の読み取り', () => {
    it('Python で作った zip から指定のファイルを取り出す', async () => {
        const entry = readZipEntry(await fixture(), 'links.json');
        const parsed = JSON.parse(entry?.toString('utf8') ?? '') as {
            files: unknown[];
        };
        assert.equal(parsed.files.length, 2);
    });

    it('無いファイルは null', async () => {
        assert.equal(readZipEntry(await fixture(), 'nothing'), null);
    });
});

describe('公開先のパスの制限', () => {
    it('reports/ の下の .html だけを許す', () => {
        assertPublishablePath('reports/g/2026/11/r.html');
        for (const bad of [
            '.github/workflows/x.yml',
            'reports/../secret.html',
            'reports//x.html',
            'reports/x.txt',
            'x.html',
            'reports/a\\b.html',
        ]) {
            assert.throws(() => assertPublishablePath(bad), /refusing/);
        }
    });
});

describe('GithubPagerPublisher', () => {
    it('blob → tree → commit → ref の順で 1 コミットを作る', async () => {
        const { publisher: p, calls } = publisher(gitApi(() => json({})));
        assert.equal(await p.commit([FILE], 'msg'), 'commit');
        const tree = calls.find((c) => c.url.endsWith('/git/trees'));
        assert.deepEqual(tree?.body, {
            base_tree: 'base-tree',
            tree: [
                {
                    path: FILE.path,
                    mode: '100644',
                    type: 'blob',
                    sha: 'blob',
                },
            ],
        });
        const patch = calls.at(-1);
        assert.equal(patch?.method, 'PATCH');
        assert.deepEqual(patch?.body, { sha: 'commit' });
    });

    it('fast-forward できなければ作り直す', async () => {
        let attempts = 0;
        const { publisher: p, calls } = publisher(
            gitApi(() => {
                attempts += 1;
                return attempts === 1 ? json({}, 422) : json({});
            })
        );
        assert.equal(await p.commit([FILE], 'msg'), 'commit');
        assert.equal(
            calls.filter((c) => c.url.endsWith('/git/blobs')).length,
            1
        );
        assert.equal(
            calls.filter((c) => c.url.endsWith('/git/commits')).length,
            2
        );
    });

    it('reports/ の外には公開しない', async () => {
        const { publisher: p, calls } = publisher(gitApi(() => json({})));
        await assert.rejects(
            p.commit(
                [
                    {
                        path: '.github/workflows/x.html',
                        content: Buffer.from(''),
                    },
                ],
                'm'
            ),
            /refusing/
        );
        assert.equal(calls.length, 0);
    });

    function deployApi(zip: Buffer, runs: unknown[][]): Handler {
        let i = 0;
        return (url) => {
            if (url.includes('/actions/runs?')) {
                const workflow_runs = runs[Math.min(i, runs.length - 1)];
                i += 1;
                return json({ workflow_runs });
            }
            if (url.includes('/actions/runs/7/artifacts')) {
                return json({ artifacts: [{ id: 9, expired: false }] });
            }
            if (url.includes('/actions/artifacts/9/zip')) {
                return new Response(null, {
                    status: 302,
                    headers: { location: 'https://blob.example/signed' },
                });
            }
            if (url === 'https://blob.example/signed') {
                return new Response(zip);
            }
            throw new Error(`unexpected request: ${url}`);
        };
    }

    it('完了を待って artifact から URL を読み、転送先にトークンを送らない', async () => {
        const zip = await fixture();
        const { publisher: p, calls } = publisher(
            deployApi(zip, [
                [{ id: 7, status: 'in_progress', conclusion: null }],
                [{ id: 7, status: 'completed', conclusion: 'success' }],
            ])
        );
        const urls = await p.urlsFor('commit', ['reports/g1/2026/11/r1.html']);
        assert.equal(
            urls.get('reports/g1/2026/11/r1.html'),
            'https://pager.example/s/REPORT'
        );
        const blob = calls.find((c) => c.url.includes('blob.example'));
        assert.equal(blob?.authorization, null);
        const api = calls.find((c) => c.url.includes('/artifacts/9/zip'));
        assert.equal(api?.authorization, 'Bearer secret');
    });

    it('run が失敗したら DeployFailedError', async () => {
        const { publisher: p } = publisher(
            deployApi(await fixture(), [
                [{ id: 7, status: 'completed', conclusion: 'failure' }],
            ])
        );
        await assert.rejects(
            p.urlsFor('commit', ['reports/g1/index.html']),
            DeployFailedError
        );
    });

    it('run が現れなければ DeployFailedError', async () => {
        const { publisher: p } = publisher(deployApi(await fixture(), [[]]));
        await assert.rejects(
            p.urlsFor('commit', ['reports/g1/index.html']),
            DeployFailedError
        );
    });

    it('artifact にパスがなければ DeployFailedError', async () => {
        const { publisher: p } = publisher(
            deployApi(await fixture(), [
                [{ id: 7, status: 'completed', conclusion: 'success' }],
            ])
        );
        await assert.rejects(
            p.urlsFor('commit', ['reports/none.html']),
            DeployFailedError
        );
    });
});
