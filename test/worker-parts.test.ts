import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import {
    buildAgentCommand,
    fetchedUrls,
    normalizeUrl,
    type AgentSettings,
} from '../src/report-worker/agent-cli.ts';
import { loadWorkerConfig } from '../src/report-worker/config.ts';
import { parseCsv, parseProceedingsCsv } from '../src/report-worker/csv.ts';
import {
    childEnvironment,
    srtSettings,
    wrapCommand,
} from '../src/report-worker/sandbox.ts';
import {
    buildTranscript,
    chunkLines,
    renderChunk,
    renderForOutline,
    type Transcript,
} from '../src/report-worker/transcript.ts';
import {
    isSafeSourceUrl,
    validateCorrection,
    validateOutline,
    validateResearch,
} from '../src/report-worker/validate.ts';

const row = (speaker: string, seconds: number, talk: string) => ({
    speaker,
    date: new Date(Date.UTC(2026, 10, 6, 12, 0, seconds)).toISOString(),
    talk,
});

function transcript(): Transcript {
    return buildTranscript([
        {
            sessionId: 's2',
            channelName: 'VC2',
            startedAt: new Date('2026-11-06T14:00:00Z'),
            endedAt: new Date('2026-11-06T15:00:00Z'),
            rows: [
                {
                    speaker: 'Bob',
                    date: '2026-11-06T14:00:01Z',
                    talk: '二つ目の録音',
                },
            ],
        },
        {
            sessionId: 's1',
            channelName: 'VC1',
            startedAt: new Date('2026-11-06T12:00:00Z'),
            endedAt: new Date('2026-11-06T13:00:00Z'),
            rows: [
                row('Alice', 1, 'はい'),
                row('Alice', 2, 'そう'),
                row('Bob', 3, 'うん'),
            ],
        },
    ]);
}

describe('CSV', () => {
    it('引用符と改行を扱う', () => {
        assert.deepEqual(parseCsv('a,"b,""c"\r\n"d\ne",f\n'), [
            ['a', 'b,"c'],
            ['d\ne', 'f'],
        ]);
    });

    it("recognizer の ' の前置を外し、空の発言を除く", () => {
        const rows = parseProceedingsCsv(
            "speaker,date,talk\n'=x,2026-11-06T21:00:00+09:00,'+1\nA,2026-11-06T21:00:01+09:00,\nB,2026-11-06T21:00:02+09:00,it's\n"
        );
        assert.deepEqual(
            rows.map((r) => [r.speaker, r.talk]),
            [
                ['=x', '+1'],
                ['B', "it's"],
            ]
        );
    });

    it('想定外のヘッダーはエラー', () => {
        assert.throws(() => parseProceedingsCsv('a,b,c\n1,2,3\n'), /header/);
    });
});

describe('文字起こしの組み立て', () => {
    it('録音を時刻順につなぎ、通し番号にする', () => {
        const t = transcript();
        assert.deepEqual(
            t.lines.map((l) => [l.id, l.session, l.raw]),
            [
                ['l1', 0, 'はい'],
                ['l2', 0, 'そう'],
                ['l3', 0, 'うん'],
                ['l4', 1, '二つ目の録音'],
            ]
        );
        assert.deepEqual(t.participants, ['Alice', 'Bob']);
    });

    it('LLM 用の全文は略称と時刻の目印と録音の区切りを持つ', () => {
        const t = transcript();
        const [text] = renderForOutline(t, t.lines, 'Asia/Tokyo');
        assert.match(text ?? '', /S1=Alice、S2=Bob/);
        assert.match(text ?? '', /=== 録音 1: VC1 ===/);
        assert.match(text ?? '', /=== 録音 2: VC2 ===/);
        assert.match(text ?? '', /--- 11\/6 21:00 ---/);
        assert.match(text ?? '', /^l2 S1 そう$/m);
    });

    it('全文は Read の上限に収まるよう複数のファイルに分ける', () => {
        const long = 'あ'.repeat(200);
        const rows = Array.from({ length: 400 }, (_, i) =>
            row('Alice', i, long)
        );
        const t = buildTranscript([
            {
                sessionId: 's',
                channelName: null,
                startedAt: new Date(0),
                endedAt: new Date(1),
                rows,
            },
        ]);
        const files = renderForOutline(t, t.lines, 'Asia/Tokyo');
        assert.ok(files.length > 1);
        for (const file of files) assert.ok(file.length <= 30_000);
    });

    it('校正の単位に分け、前後の文脈を付ける', () => {
        const t = transcript();
        const chunks = chunkLines(t.lines, 2, 1);
        assert.deepEqual(
            chunks.map((c) => [
                c.id,
                c.target.map((l) => l.id),
                c.before.map((l) => l.id),
                c.after.map((l) => l.id),
            ]),
            [
                ['p001', ['l1', 'l2'], [], ['l3']],
                ['p002', ['l3', 'l4'], ['l2'], []],
            ]
        );
        assert.match(
            renderChunk(chunks[0]!),
            /=== 校正対象 ===\nl1 Alice: はい/
        );
    });
});

function outlineFixture(overrides: Record<string, unknown> = {}): unknown {
    return {
        title: '題',
        lede: '要約',
        key_points: [{ text: '要点', refs: ['l1'] }],
        decisions: [],
        open_questions: [],
        chapters: [
            {
                title: '一',
                start: 'l1',
                end: 'l3',
                summary: 's',
                flow: [{ label: '発端', text: 't' }],
                point: 'p',
            },
            {
                title: '二',
                start: 'l4',
                end: 'l4',
                summary: 's',
                flow: [],
                point: 'p',
            },
        ],
        threads: [
            {
                topic: 't',
                question: 'q',
                positions: [{ speaker: 'Alice', text: 'x', refs: ['l1'] }],
            },
        ],
        glossary: [],
        research_topics: [
            { id: 'r1', query: 'q', question: 'q?', chapters: [1] },
        ],
        ...overrides,
    };
}

function checkOutline(value: unknown) {
    const t = transcript();
    return validateOutline(value, {
        transcript: t,
        lines: t.lines,
        maxResearchTopics: 5,
    });
}

function errorsOf(result: { ok: boolean; errors?: readonly string[] }): string {
    return (result.errors ?? []).join('\n');
}

describe('outline の検証', () => {
    it('正しい形を受け付ける', () => {
        assert.equal(checkOutline(outlineFixture()).ok, true);
    });

    it('章に隙間があるとエラー', () => {
        const value = outlineFixture({
            chapters: [
                {
                    title: '一',
                    start: 'l1',
                    end: 'l2',
                    summary: 's',
                    flow: [],
                    point: 'p',
                },
                {
                    title: '二',
                    start: 'l4',
                    end: 'l4',
                    summary: 's',
                    flow: [],
                    point: 'p',
                },
            ],
        });
        const result = checkOutline(value);
        assert.equal(result.ok, false);
        assert.match(errorsOf(result as never), /直後の行\(l3\)/);
    });

    it('最後まで覆っていないとエラー', () => {
        const value = outlineFixture({
            chapters: [
                {
                    title: '一',
                    start: 'l1',
                    end: 'l3',
                    summary: 's',
                    flow: [],
                    point: 'p',
                },
            ],
        });
        assert.match(errorsOf(checkOutline(value) as never), /l4 で終えて/);
    });

    it('章が録音をまたぐとエラー', () => {
        const value = outlineFixture({
            chapters: [
                {
                    title: '一',
                    start: 'l1',
                    end: 'l4',
                    summary: 's',
                    flow: [],
                    point: 'p',
                },
            ],
        });
        assert.match(errorsOf(checkOutline(value) as never), /録音をまたいで/);
    });

    it('存在しない行の出典はエラー', () => {
        const value = outlineFixture({
            key_points: [{ text: 'x', refs: ['l99'] }],
        });
        assert.match(errorsOf(checkOutline(value) as never), /l99/);
    });

    it('参加者でない話者はエラー', () => {
        const value = outlineFixture({
            threads: [
                {
                    topic: 't',
                    question: 'q',
                    positions: [
                        { speaker: 'Mallory', text: 'x', refs: ['l1'] },
                    ],
                },
            ],
        });
        assert.match(errorsOf(checkOutline(value) as never), /Mallory/);
    });

    it('検索語に参加者の名前があるトピックは取り除く', () => {
        const value = outlineFixture({
            research_topics: [
                {
                    id: 'r1',
                    query: 'Alice の発言',
                    question: 'q',
                    chapters: [1],
                },
                {
                    id: 'r2',
                    query: '一般的な語',
                    question: 'Bob は?',
                    chapters: [1],
                },
                { id: 'r3', query: '一般的な語', question: 'q', chapters: [1] },
            ],
        });
        const result = checkOutline(value);
        assert.equal(result.ok, true);
        if (result.ok) {
            assert.deepEqual(
                result.value.research_topics.map((t) => t.id),
                ['r3']
            );
        }
    });

    it('範囲外の章番号はエラー', () => {
        const value = outlineFixture({
            research_topics: [
                { id: 'r1', query: 'q', question: 'q', chapters: [9] },
            ],
        });
        assert.match(errorsOf(checkOutline(value) as never), /範囲外/);
    });
});

describe('校正の検証', () => {
    const chunk = chunkLines(transcript().lines, 3, 0)[0]!;

    it('正しい形を受け付け、原文と同じ行は捨てる', () => {
        const result = validateCorrection(
            {
                chunk: 'p001',
                lines: [
                    { id: 'l1', kind: 'fix', text: 'はい。' },
                    { id: 'l2', kind: 'fix', text: 'そう' },
                    { id: 'l3', kind: 'drop', note: '雑音' },
                ],
            },
            chunk
        );
        assert.equal(result.ok, true);
        if (result.ok) {
            assert.deepEqual(
                result.value.lines.map((l) => l.id),
                ['l1', 'l3']
            );
        }
    });

    it('対象外の行、順序の乱れ、長すぎる書き換えはエラー', () => {
        for (const [lines, pattern] of [
            [
                [{ id: 'l4', kind: 'fix', text: 'x' }],
                /校正対象の行ではありません/,
            ],
            [
                [
                    { id: 'l2', kind: 'fix', text: 'x' },
                    { id: 'l1', kind: 'fix', text: 'y' },
                ],
                /行の順に/,
            ],
            [[{ id: 'l1', kind: 'fix', text: 'あ'.repeat(100) }], /文字以下/],
            [
                [{ id: 'l1', kind: 'rewrite', text: 'x' }],
                /fix \/ infer \/ drop/,
            ],
            [[{ id: 'l1', kind: 'fix' }], /空でない文字列/],
        ] as const) {
            const result = validateCorrection({ chunk: 'p001', lines }, chunk);
            assert.equal(result.ok, false);
            assert.match(errorsOf(result as never), pattern);
        }
    });
});

describe('調査結果の検証', () => {
    const source = {
        title: 't',
        url: 'https://example.org/a',
        kind: 'paper',
        summary: 's',
        relevance: 'r',
    };

    it('正しい形を受け付ける', () => {
        assert.equal(
            validateResearch(
                { topic: 'r1', sources: [source] },
                { topicId: 'r1', maxSources: 4 }
            ).ok,
            true
        );
    });

    it('https 以外の URL はエラー', () => {
        for (const url of [
            'http://example.org',
            'javascript:alert(1)',
            'data:text/html,x',
            'https://user:pw@example.org',
        ]) {
            assert.equal(isSafeSourceUrl(url), false, url);
            assert.equal(
                validateResearch(
                    { topic: 'r1', sources: [{ ...source, url }] },
                    { topicId: 'r1', maxSources: 4 }
                ).ok,
                false
            );
        }
    });

    it('違うトピックや上限超えはエラー', () => {
        assert.equal(
            validateResearch(
                { topic: 'r2', sources: [] },
                { topicId: 'r1', maxSources: 4 }
            ).ok,
            false
        );
        assert.equal(
            validateResearch(
                { topic: 'r1', sources: [source, source] },
                { topicId: 'r1', maxSources: 1 }
            ).ok,
            false
        );
    });
});

describe('SKILL のスキーマと検証の一致', () => {
    const schema = async (name: string) =>
        JSON.parse(
            await readFile(
                new URL(
                    `../skills/proceedings-report/schemas/${name}.schema.json`,
                    import.meta.url
                ),
                'utf8'
            )
        ) as { required: string[]; examples: unknown[] };

    it('outline のスキーマの例は検証を通り、必須項目を欠くと落ちる', async () => {
        const { examples, required } = await schema('outline');
        const t = buildTranscript([
            {
                sessionId: 's',
                channelName: null,
                startedAt: new Date(0),
                endedAt: new Date(1),
                rows: [row('Alice', 1, 'a'), row('Alice', 2, 'b')],
            },
        ]);
        const context = { transcript: t, lines: t.lines, maxResearchTopics: 5 };
        assert.equal(validateOutline(examples[0], context).ok, true);
        for (const key of required) {
            const { [key]: _removed, ...rest } = examples[0] as Record<
                string,
                unknown
            >;
            assert.equal(validateOutline(rest, context).ok, false, key);
        }
    });

    it('research と correction のスキーマの例は検証を通る', async () => {
        const research = await schema('research');
        assert.equal(
            validateResearch(research.examples[0], {
                topicId: 'r1',
                maxSources: 4,
            }).ok,
            true
        );
        const correction = await schema('correction');
        const t = buildTranscript([
            {
                sessionId: 's',
                channelName: null,
                startedAt: new Date(0),
                endedAt: new Date(1),
                rows: [row('A', 1, '画面距離でいい?'), row('A', 2, 'みよう')],
            },
        ]);
        assert.equal(
            validateCorrection(
                correction.examples[0],
                chunkLines(t.lines, 2, 0)[0]!
            ).ok,
            true
        );
    });
});

describe('CLI の起動方法', () => {
    const claude: AgentSettings = {
        kind: 'claude',
        model: 'claude-sonnet-5-5',
        effort: 'medium',
        maxBudgetUsd: 1.5,
    };

    const value = (args: readonly string[], flag: string) =>
        args[args.indexOf(flag) + 1];

    it('claude は Bash なしで、校正には Web のツールを渡さない', () => {
        const { args } = buildAgentCommand(claude, {
            cwd: '/t',
            prompt: 'p',
            web: false,
        });
        assert.equal(value(args, '--tools'), 'Read,Write');
        assert.equal(args.includes('--allowedTools'), false);
        assert.ok(args.includes('--restricted'));
        assert.equal(value(args, '--model'), 'claude-sonnet-5-5');
        assert.equal(value(args, '--effort'), 'medium');
        assert.equal(value(args, '--max-budget-usd'), '1.5');
        assert.equal(
            value(args, '--append-system-prompt-file'),
            '.claude/skills/proceedings-report/SKILL.md'
        );
        assert.ok(!args.some((arg) => /bash/i.test(arg)));
    });

    it('claude の調査タスクだけ Web のツールを許可する', () => {
        const { args } = buildAgentCommand(claude, {
            cwd: '/t',
            prompt: 'p',
            web: true,
        });
        assert.equal(value(args, '--tools'), 'Read,Write,WebSearch,WebFetch');
        assert.equal(value(args, '--allowedTools'), 'WebSearch,WebFetch');
    });

    it('codex の引数', () => {
        const built = buildAgentCommand(
            { kind: 'codex', model: 'gpt', effort: 'high', maxBudgetUsd: null },
            { cwd: '/t', prompt: 'p', web: false }
        );
        assert.equal(built.command, 'codex');
        assert.equal(built.args[0], 'exec');
        assert.equal(value(built.args, '-m'), 'gpt');
        assert.equal(value(built.args, '-c'), 'model_reasoning_effort="high"');
        assert.equal(value(built.args, '-C'), '/t');
        assert.ok('AGENTS.md' in built.files);
    });

    it('codex の調査では Web 検索を有効にする', () => {
        const built = buildAgentCommand(
            { kind: 'codex', model: null, effort: null, maxBudgetUsd: null },
            { cwd: '/t', prompt: 'p', web: true }
        );
        assert.equal(built.args[0], '--search');
    });

    it('opencode は設定ファイルで bash と web を拒否する', () => {
        const built = buildAgentCommand(
            {
                kind: 'opencode',
                model: 'p/m',
                effort: 'high',
                maxBudgetUsd: null,
            },
            { cwd: '/t', prompt: 'p', web: false }
        );
        assert.equal(value(built.args, '--variant'), 'high');
        const config = JSON.parse(built.files['opencode.json'] ?? '') as {
            permission: Record<string, string>;
        };
        assert.equal(config.permission['bash'], 'deny');
        assert.equal(config.permission['webfetch'], 'deny');
    });

    it('stream-json から実際に取得できた URL だけを集める', () => {
        const stdout = [
            JSON.stringify({
                type: 'assistant',
                message: {
                    content: [
                        {
                            type: 'tool_use',
                            id: 'a',
                            name: 'WebFetch',
                            input: { url: 'https://ok.example/page/#x' },
                        },
                        {
                            type: 'tool_use',
                            id: 'b',
                            name: 'WebFetch',
                            input: { url: 'https://blocked.example/' },
                        },
                    ],
                },
            }),
            JSON.stringify({
                type: 'user',
                message: {
                    content: [
                        { type: 'tool_result', tool_use_id: 'a' },
                        {
                            type: 'tool_result',
                            tool_use_id: 'b',
                            is_error: true,
                        },
                    ],
                },
            }),
            'not json',
        ].join('\n');
        assert.deepEqual(
            [...(fetchedUrls('claude', stdout) ?? [])],
            ['https://ok.example/page']
        );
        assert.equal(fetchedUrls('codex', stdout), null);
        assert.equal(normalizeUrl('nope'), null);
    });
});

describe('サンドボックス', () => {
    it('srt の設定はタスクのディレクトリだけを読み書きできる', () => {
        assert.deepEqual(
            srtSettings({
                taskDirectory: '/jobs/j/work/t',
                homeDirectory: '/tmp/h',
                allowedDomains: ['a.example', 'a.example'],
                denyRead: ['/jobs'],
            }),
            {
                network: { allowedDomains: ['a.example'], deniedDomains: [] },
                filesystem: {
                    denyRead: ['/jobs'],
                    allowRead: ['/jobs/j/work/t', '/tmp/h'],
                    allowWrite: ['/jobs/j/work/t', '/tmp/h'],
                    denyWrite: [],
                },
            }
        );
    });

    it('none のときは包まない', () => {
        assert.deepEqual(wrapCommand('none', '/s', 'claude', ['-p']), {
            command: 'claude',
            args: ['-p'],
        });
        assert.deepEqual(wrapCommand('srt', '/s', 'claude', ['-p']), {
            command: 'srt',
            args: ['--settings', '/s', 'claude', '-p'],
        });
    });

    it('環境変数は許可したものだけを渡す', () => {
        const env = childEnvironment(
            {
                PATH: '/bin',
                DISCORD_TOKEN: 'x',
                PAGER_GITHUB_TOKEN: 'y',
                CLAUDE_CODE_OAUTH_TOKEN: 'z',
                ANTHROPIC_API_KEY: '',
            },
            ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'],
            '/tmp/h'
        );
        assert.equal(env['HOME'], '/tmp/h');
        assert.equal(env['CLAUDE_CODE_OAUTH_TOKEN'], 'z');
        assert.equal('DISCORD_TOKEN' in env, false);
        assert.equal('PAGER_GITHUB_TOKEN' in env, false);
        assert.equal('ANTHROPIC_API_KEY' in env, false);
    });
});

describe('worker の設定', () => {
    it('既定は off', () => {
        assert.equal(loadWorkerConfig({}).agent, null);
    });

    it('.env の値を読む', () => {
        const config = loadWorkerConfig({
            REPORT_AGENT: 'claude',
            REPORT_AGENT_MODEL: 'm',
            REPORT_AGENT_EFFORT: 'medium',
            REPORT_AGENT_SANDBOX: 'none',
            REPORT_RESEARCH: 'off',
            REPORT_RESEARCH_ALLOWED_DOMAINS: 'a.example, b.example',
        });
        assert.deepEqual(config.agent, {
            kind: 'claude',
            model: 'm',
            effort: 'medium',
            maxBudgetUsd: null,
        });
        assert.equal(config.sandbox, 'none');
        assert.equal(config.research.enabled, false);
        assert.deepEqual(config.research.domains, ['a.example', 'b.example']);
    });

    it('未知の値はエラー', () => {
        assert.throws(() => loadWorkerConfig({ REPORT_AGENT: 'gemini' }));
        assert.throws(() =>
            loadWorkerConfig({ REPORT_AGENT_SANDBOX: 'docker' })
        );
    });

    it('既定の調査先は srt が受け付ける形だけにする', () => {
        for (const domain of loadWorkerConfig({}).research.domains) {
            assert.doesNotMatch(domain, /^\*(\.[a-z]+)?$/, domain);
        }
    });
});
