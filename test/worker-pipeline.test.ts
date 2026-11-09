import assert from 'node:assert/strict';
import {
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rm,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { JobRequest } from '../src/report/job-files.ts';
import { assertSelfContained } from '../src/report-worker/compile.ts';
import { runPipeline } from '../src/report-worker/pipeline.ts';
import type {
    AgentRun,
    AgentRunner,
    AgentTask,
} from '../src/report-worker/runner.ts';
import type { Line } from '../src/report-worker/transcript.ts';

const CSV = `speaker,date,talk
Alice,2026-11-06T21:00:00+09:00,画面距離でいい?
Bob,2026-11-06T21:00:05+09:00,みよう
Alice,2026-11-06T21:00:09+09:00,ありがとうございました
Bob,2026-11-06T21:00:15+09:00,<script>alert(1)</script>
`;

const OUTLINE = {
    title: '画面共有の相談',
    lede: 'Aliceが画面共有について尋ねる。',
    key_points: [{ text: '共有を始めた', refs: ['l1', 'l2'] }],
    decisions: [],
    open_questions: [],
    chapters: [
        {
            title: '共有の開始',
            start: 'l1',
            end: 'l4',
            summary: '共有を始める。',
            flow: [{ label: '発端', text: '尋ねる。' }],
            point: '進め方を決める。',
        },
    ],
    threads: [],
    glossary: [{ term: '画面共有', heard: ['画面距離'], note: '機能' }],
    research_topics: [
        { id: 'r1', query: '画面共有', question: '仕組みは?', chapters: [1] },
    ],
};

const MAP = {
    through_line: null,
    phases: [
        {
            title: '共有の相談',
            first_chapter: 1,
            last_chapter: 1,
            summary: '画面共有を始める。',
            keywords: ['画面共有'],
            transition: null,
        },
    ],
    debates: [
        {
            id: 'd1',
            title: '画面共有でよいか',
            question: '共有の方法はこれでよいか。',
            chapters: [1],
            branches: [
                {
                    stance: 'よい',
                    moves: [
                        {
                            kind: 'claim',
                            speaker: 'Bob',
                            text: 'このまま見ればよい。',
                            refs: ['l4'],
                        },
                    ],
                },
            ],
            outcome: { status: 'agreed', text: '共有で進めた。', refs: ['l1'] },
            links: [],
        },
    ],
};

const SOURCES = [
    {
        title: '取得した資料',
        url: 'https://fetched.example/a',
        kind: 'encyclopedia',
        summary: '説明。',
        relevance: '関連。',
    },
    {
        title: '作り話の資料',
        url: 'https://invented.example/b',
        kind: 'paper',
        summary: '説明。',
        relevance: '関連。',
    },
];

const fetchLog =
    JSON.stringify({
        message: {
            content: [
                {
                    type: 'tool_use',
                    id: 'x',
                    name: 'WebFetch',
                    input: { url: 'https://fetched.example/a' },
                },
            ],
        },
    }) +
    '\n' +
    JSON.stringify({
        message: { content: [{ type: 'tool_result', tool_use_id: 'x' }] },
    });

interface FakeBehaviour {
    /** 最初の correct の出力を不正にする。 */
    readonly invalidFirstCorrection?: boolean;
    readonly failCorrection?: boolean;
    readonly failOutline?: boolean;
    readonly failResearch?: boolean;
    readonly failMap?: boolean;
}

function fakeRunner(
    behaviour: FakeBehaviour,
    calls: AgentTask[],
    snapshots: Map<string, string[]>
): AgentRunner {
    let corrections = 0;
    return async (task): Promise<AgentRun> => {
        calls.push(task);
        snapshots.set(task.name, await readdir(task.cwd));
        const write = (value: unknown) =>
            writeFile(path.join(task.cwd, 'out.json'), JSON.stringify(value));
        const done: AgentRun = { stdout: '', exitCode: 0, timedOut: false };
        if (task.name === 'outline') {
            if (behaviour.failOutline) return done;
            await write(OUTLINE);
            return done;
        }
        if (task.name === 'map') {
            if (!behaviour.failMap) await write(MAP);
            return done;
        }
        if (task.name.includes('research')) {
            if (behaviour.failResearch) return done;
            await write({ topic: 'r1', sources: SOURCES });
            return { ...done, stdout: fetchLog };
        }
        corrections += 1;
        if (behaviour.failCorrection) return done;
        if (behaviour.invalidFirstCorrection && corrections === 1) {
            await write({
                chunk: 'p001',
                lines: [{ id: 'l99', kind: 'fix', text: 'x' }],
            });
            return done;
        }
        await write({
            chunk: 'p001',
            lines: [
                { id: 'l1', kind: 'fix', text: '画面共有でいい?' },
                { id: 'l2', kind: 'infer', text: '見よう', note: '返事' },
                { id: 'l3', kind: 'drop', note: '雑音' },
            ],
        });
        return done;
    };
}

describe('パイプライン', () => {
    let root: string;
    let jobDirectory: string;
    let taskRoot: string;
    let calls: AgentTask[];
    let snapshots: Map<string, string[]>;

    const request: JobRequest = {
        version: 1,
        jobId: 'job1',
        guildName: 'テストサーバー',
        timeZone: 'Asia/Tokyo',
        periodLabel: '今日',
        createdAt: '2026-11-06T13:00:00Z',
        sessions: [
            {
                sessionId: 's1',
                channelName: 'VC',
                startedAt: '2026-11-06T12:00:00Z',
                endedAt: '2026-11-06T12:30:00Z',
                csv: 'input/s1.csv',
            },
        ],
    };

    function run(behaviour: FakeBehaviour = {}) {
        return runPipeline({
            jobDirectory,
            request,
            agentKind: 'claude',
            runner: fakeRunner(behaviour, calls, snapshots),
            concurrency: 2,
            taskRoot,
            research: {
                enabled: true,
                maxTopics: 5,
                isReachable: async () => true,
            },
            logger: { info() {}, warn() {} },
        });
    }

    beforeEach(async () => {
        root = await mkdtemp(path.join(tmpdir(), 'pipeline-'));
        jobDirectory = path.join(root, 'jobs', 'job1');
        taskRoot = path.join(root, 'tasks');
        await mkdir(path.join(jobDirectory, 'input'), { recursive: true });
        await writeFile(path.join(jobDirectory, 'input', 's1.csv'), CSV);
        calls = [];
        snapshots = new Map();
    });

    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    it('本文を直接埋め込んだ静的な HTML を作る', async () => {
        const { html, result } = await run();
        assert.equal(result.title, '画面共有の相談');
        assert.deepEqual(result.participants, ['Alice', 'Bob']);
        assert.deepEqual(result.warnings, []);

        assert.match(html, /<h1>画面共有の相談<\/h1>/);
        // 校正結果と原文
        assert.match(html, /<span id="l1">画面共有でいい\?<\/span>/);
        assert.match(
            html,
            /<details class="orig"><summary>原文<\/summary><p>画面距離でいい\?/
        );
        // 補完は文字でも示す
        assert.match(html, /<ins>見よう<\/ins><small>\(補完\)<\/small>/);
        // 誤認識の疑いは畳む
        assert.match(html, /誤認識の疑い 1 行/);
        assert.match(html, /<span id="l3">ありがとうございました<\/span>/);
        // 目次と出典は普通のリンク
        assert.match(html, /<a href="#ch-1">/);
        assert.match(html, /<a class="ref" href="#l1">/);
        // 同じ分の参照は 1 つにまとめる
        assert.doesNotMatch(html, /<a class="ref" href="#l2">/);
        // 要約はカードにする
        assert.match(html, /<section class="card"><h3>主な内容<\/h3>/);
        // 話者と時刻は原データのまま
        assert.match(
            html,
            /<time datetime="2026-11-06T21:00:00\+09:00">21:00<\/time>/
        );
        assert.match(html, /<b class="c1">Bob<\/b>/);
        // 発言はエスケープされる
        assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
        assert.doesNotMatch(html, /<script>alert/);
        // JSON を残さない
        assert.doesNotMatch(html, /application\/json/);
        assert.doesNotMatch(html, /"key_points"/);
    });

    it('議論マップは本文に埋め込み、章と発言へのリンクを持つ', async () => {
        const { html } = await run();
        assert.match(html, /<h3>全体の流れ<\/h3>/);
        assert.match(html, /<section class="debate" id="d1">/);
        assert.match(html, /<span class="kind">主張<\/span> <b class="c1">Bob/);
        assert.match(html, /<a class="ref" href="#l4">/);
        assert.match(html, /<b>議論図<\/b> <a href="#d1">/);
    });

    it('議論マップには校正済みの全文を渡し、誤認識の行は渡さない', async () => {
        let transcript = '';
        const runner: AgentRunner = async (task) => {
            if (task.name === 'map') {
                transcript = await readFile(
                    path.join(task.cwd, 'transcript-01.txt'),
                    'utf8'
                );
            }
            return fakeRunner({}, calls, snapshots)(task);
        };
        await runPipeline({
            jobDirectory,
            request,
            agentKind: 'claude',
            runner,
            concurrency: 1,
            taskRoot,
            research: {
                enabled: true,
                maxTopics: 5,
                isReachable: async () => true,
            },
            logger: { info() {}, warn() {} },
        });
        assert.match(transcript, /画面共有でいい\?/);
        assert.doesNotMatch(transcript, /画面距離/);
        assert.doesNotMatch(transcript, /ありがとうございました/);
    });

    it('議論マップを作れなくてもページを作り、論点のカードを出す', async () => {
        const { html, result } = await run({ failMap: true });
        assert.deepEqual(result.warnings, ['議論マップを作れませんでした']);
        assert.doesNotMatch(html, /<h3>全体の流れ<\/h3>/);
        assert.match(html, /<h2>議論マップ<\/h2>/);
    });

    it('実際に取得した資料だけを、安全なリンクで載せる', async () => {
        const { html } = await run();
        assert.match(
            html,
            /<a href="https:\/\/fetched\.example\/a" rel="noopener noreferrer nofollow" target="_blank">取得した資料<\/a> <span class="domain">fetched\.example・事典/
        );
        assert.doesNotMatch(html, /invented\.example/);
        assert.match(html, /AIが収集した資料です/);
    });

    it('調査タスクには文字起こしを渡さず、ジョブの外で動かす', async () => {
        await run();
        const research = calls.find((c) => c.name.includes('research'));
        assert.equal(research?.web, true);
        assert.ok(research?.cwd.startsWith(taskRoot));
        assert.ok(!research?.cwd.startsWith(jobDirectory));
        const files = snapshots.get(research?.name ?? '') ?? [];
        assert.deepEqual(files.sort(), ['.claude', 'task.md', 'topic.json']);
    });

    it('文字起こしを読むタスクには Web を許さない', async () => {
        await run();
        for (const call of calls.filter((c) => !c.name.includes('research'))) {
            assert.equal(call.web, false, call.name);
        }
    });

    it('検証に落ちたらエラーを伝えて再試行する', async () => {
        const { html } = await run({ invalidFirstCorrection: true });
        assert.equal(
            calls.filter((c) => c.name.startsWith('correct')).length,
            2
        );
        assert.match(html, /画面共有でいい\?/);
    });

    it('校正に失敗した区間は原文のまま載せて知らせる', async () => {
        const { html, result } = await run({ failCorrection: true });
        assert.equal(
            calls.filter((c) => c.name.startsWith('correct')).length,
            3
        );
        assert.match(result.warnings.join(), /校正できなかった区間 1 件/);
        assert.match(html, /<span id="l1">画面距離でいい\?<\/span>/);
        assert.match(html, /\(未校正\)/);
    });

    it('調査に失敗してもページは作る', async () => {
        const { html, result } = await run({ failResearch: true });
        assert.match(result.warnings.join(), /調べられなかった話題 1 件/);
        assert.match(html, /関連資料はありません/);
    });

    it('全体のまとめに失敗したらジョブを失敗にする', async () => {
        await assert.rejects(run({ failOutline: true }), /全体のまとめ/);
    });

    it('やり直すときは成功済みのタスクを呼ばない', async () => {
        await run();
        const first = calls.length;
        await run();
        assert.equal(calls.length, first);
    });

    it('全体の outline には SKILL が含まれ、task.md が手順を指す', async () => {
        const seen: string[] = [];
        const runner: AgentRunner = async (task) => {
            if (task.name === 'outline') {
                seen.push(
                    await readFile(path.join(task.cwd, 'task.md'), 'utf8')
                );
                const entries = await readdir(
                    path.join(task.cwd, '.claude/skills/proceedings-report'),
                    { recursive: true }
                );
                seen.push(entries.sort().join(','));
            }
            return fakeRunner({}, calls, snapshots)(task);
        };
        await runPipeline({
            jobDirectory,
            request,
            agentKind: 'claude',
            runner,
            concurrency: 1,
            taskRoot,
            research: {
                enabled: true,
                maxTopics: 5,
                isReachable: async () => true,
            },
            logger: { info() {}, warn() {} },
        });
        assert.match(seen[0] ?? '', /references\/outline\.md/);
        assert.match(seen[0] ?? '', /transcript-01\.txt/);
        assert.match(
            seen[1] ?? '',
            /SKILL\.md.*references\/outline\.md.*schemas\/outline\.schema\.json/s
        );
    });
});

describe('公開前の検査', () => {
    const line: Line = {
        id: 'l1',
        session: 0,
        speaker: 'A',
        at: new Date(0),
        iso: '',
        raw: '',
    };
    const ok = '<span id="l1">x</span>';

    it('要件を満たす HTML は通る', () => {
        assertSelfContained(ok, 'const a=1;', [line]);
    });

    it('外部の読み込みや埋め込み JSON を拒否する', () => {
        for (const html of [
            '<script src="https://x"></script>',
            '<script type="application/json">{}</script>',
            '<img src="https://x">',
            '<iframe src="x"></iframe>',
            '<link rel="stylesheet" href="x">',
            '<style>a{background:url(https://x)}</style>',
        ]) {
            assert.throws(() =>
                assertSelfContained(ok + html, 'const a=1;', [line])
            );
        }
    });

    it('通信する JS を拒否する', () => {
        for (const js of [
            'fetch("x")',
            'new XMLHttpRequest()',
            'new WebSocket("x")',
        ]) {
            assert.throws(() => assertSelfContained(ok, js, [line]));
        }
    });

    it('発言が欠けていたら拒否する', () => {
        assert.throws(
            () => assertSelfContained('<p></p>', '', [line]),
            /missing/
        );
    });
});
