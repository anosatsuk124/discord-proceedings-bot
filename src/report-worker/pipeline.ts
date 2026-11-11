import {
    appendFile,
    copyFile,
    mkdir,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { SKILL_DIR } from '../report/assets.ts';
import {
    JOB_WORK_DIR,
    type JobRequest,
    type JobSuccess,
    type JobUsage,
} from '../report/job-files.ts';
import { writeJsonAtomic } from '../report/shared.ts';
import {
    fetchedUrls,
    inspectRun,
    normalizeUrl,
    recordsFetches,
    skillDirectory,
    type AgentKind,
    type RunUsage,
} from './agent-cli.ts';
import {
    compileReport,
    loadCompileAssets,
    type CompileAssets,
} from './compile.ts';
import { parseProceedingsCsv } from './csv.ts';
import type { AgentRun, AgentRunner } from './runner.ts';
import {
    buildTranscript,
    chunkLines,
    renderChunk,
    renderForOutline,
    type Chunk,
    type Line,
    type Transcript,
} from './transcript.ts';
import type {
    ConversationMap,
    CorrectionResult,
    LineCorrection,
    Outline,
    ResearchResult,
    ResearchTopic,
    TopicSources,
} from './types.ts';
import {
    isSafeSourceUrl,
    validateCorrection,
    validateMap,
    validateOutline,
    validateResearch,
    type Validation,
} from './validate.ts';

/**
 * CSV から HTML までの流れ。LLM を呼ぶのはタスクごとに新しいプロセスで、文脈を持ち越さない。
 * LLM の出力は検証を通ったものだけを使い、結果は保存するので、再起動してもやり直さない。
 */

const CORRECTION_CHUNK_LINES = 250;
const CORRECTION_CONTEXT_LINES = 15;
const MAX_ATTEMPTS = 3;
/** これを超える長さの会話は、区間ごとに章立てする。 */
const OUTLINE_MAX_CHARS = 180_000;
const MAX_SOURCES_PER_TOPIC = 4;
/** CLI を起動するたびに 1 行足す記録。再起動しても費用の合計が失われない。 */
const USAGE_FILE = 'usage.jsonl';

/** LLM の利用枠が尽きた。やり直しても進めないので、ページを作らずに中止する。 */
export class AgentQuotaError extends Error {
    override name = 'AgentQuotaError';

    constructor() {
        super(
            'LLM の利用枠(API の残高や利用上限)が足りないため中止しました。ページは公開していません。残高と利用上限を確認してから、もう一度実行してください。'
        );
    }
}

export interface PipelineOptions {
    readonly jobDirectory: string;
    readonly request: JobRequest;
    readonly agentKind: AgentKind;
    readonly runner: AgentRunner;
    readonly concurrency: number;
    /** Web に出るタスクの作業場所。ジョブのディレクトリの外に置く。 */
    readonly taskRoot: string;
    readonly research: {
        readonly enabled: boolean;
        readonly maxTopics: number;
        /** 取得の記録を得られない CLI のための到達確認。 */
        readonly isReachable: (url: string) => Promise<boolean>;
    };
    readonly assets?: CompileAssets;
    readonly logger?: Pick<Console, 'info' | 'warn'>;
}

export interface PipelineOutput {
    readonly html: string;
    readonly result: JobSuccess;
}

type TaskKind = 'outline' | 'research' | 'correct' | 'map';

interface TaskSpec<T> {
    readonly name: string;
    readonly kind: TaskKind;
    readonly directory: string;
    /** タスクのディレクトリに置く入力ファイル。 */
    readonly inputs: Readonly<Record<string, string>>;
    /** task.md の本文。 */
    readonly description: string;
    /** 成功した結果の保存先。 */
    readonly resultFile: string;
    readonly validate: (value: unknown, run: AgentRun) => Validation<T>;
}

export async function runPipeline(
    options: PipelineOptions
): Promise<PipelineOutput> {
    const pipeline = new Pipeline(options);
    return pipeline.run();
}

class Pipeline {
    readonly #options: PipelineOptions;
    readonly #logger: Pick<Console, 'info' | 'warn'>;
    readonly #workDirectory: string;
    readonly #warnings: string[] = [];

    constructor(options: PipelineOptions) {
        this.#options = options;
        this.#logger = options.logger ?? console;
        this.#workDirectory = path.join(options.jobDirectory, 'work');
    }

    async run(): Promise<PipelineOutput> {
        const { request } = this.#options;
        const transcript = await this.#loadTranscript();
        const outline = await this.#makeOutline(transcript);
        const research = await this.#research(outline);
        const { corrections, uncorrected } = await this.#correct(
            transcript,
            outline,
            research
        );
        const map = await this.#makeMap(transcript, outline, corrections);
        const assets = this.#options.assets ?? (await loadCompileAssets());
        const html = compileReport(assets, {
            guildName: request.guildName,
            timeZone: request.timeZone,
            periodLabel: request.periodLabel,
            transcript,
            outline,
            research,
            corrections,
            uncorrected,
            map,
        });
        const first = transcript.lines[0] as Line;
        const last = transcript.lines.at(-1) as Line;
        return {
            html,
            result: {
                status: 'ok',
                title: outline.title,
                lede: outline.lede,
                participants: transcript.participants,
                utteranceCount: transcript.lines.length,
                startedAt: first.at.toISOString(),
                endedAt: last.at.toISOString(),
                warnings: this.#warnings,
                usage: await readJobUsage(this.#options.jobDirectory),
            },
        };
    }

    async #loadTranscript(): Promise<Transcript> {
        const { request, jobDirectory } = this.#options;
        const inputs = await Promise.all(
            request.sessions.map(async (session) => ({
                sessionId: session.sessionId,
                channelName: session.channelName,
                startedAt: new Date(session.startedAt),
                endedAt: new Date(session.endedAt),
                rows: parseProceedingsCsv(
                    await readFile(path.join(jobDirectory, session.csv), 'utf8')
                ),
            }))
        );
        return buildTranscript(inputs);
    }

    async #makeOutline(transcript: Transcript): Promise<Outline> {
        const parts = splitForOutline(transcript.lines);
        const outlines: Outline[] = [];
        for (const [index, lines] of parts.entries()) {
            const outline = await this.#outlinePart(
                transcript,
                lines,
                index,
                parts.length
            );
            if (outline === null) {
                throw new Error('全体のまとめを作れませんでした');
            }
            outlines.push(outline);
        }
        return mergeOutlines(outlines);
    }

    #outlinePart(
        transcript: Transcript,
        lines: readonly Line[],
        index: number,
        count: number
    ): Promise<Outline | null> {
        const { request, research } = this.#options;
        const files = renderForOutline(transcript, lines, request.timeZone);
        const inputs = Object.fromEntries(
            files.map((text, i) => [
                `transcript-${String(i + 1).padStart(2, '0')}.txt`,
                text,
            ])
        );
        const name = count === 1 ? 'outline' : `outline-${index + 1}`;
        const first = lines[0] as Line;
        const last = lines.at(-1) as Line;
        const maxTopics = research.enabled ? research.maxTopics : 0;
        return this.#runTask<Outline>({
            name,
            kind: 'outline',
            directory: path.join(this.#workDirectory, name),
            inputs,
            resultFile: path.join(this.#workDirectory, `${name}.result.json`),
            description: [
                `対象の行は ${first.id} から ${last.id} まで、${lines.length} 行です。`,
                count > 1
                    ? `長い会話を分割したうちの ${index + 1} / ${count} 番目です。`
                    : '',
                `入力ファイルをすべて、順に読んでください: ${Object.keys(inputs).join(', ')}`,
                `research_topics は ${maxTopics} 個以下にしてください。`,
                `参加者の名前は次のとおりです(threads の speaker にはこの名前を書く): ${transcript.participants.join('、')}`,
            ]
                .filter((text) => text !== '')
                .join('\n'),
            validate: (value) =>
                validateOutline(value, {
                    transcript,
                    lines,
                    maxResearchTopics: maxTopics,
                }),
        });
    }

    async #research(outline: Outline): Promise<TopicSources[]> {
        const { research, concurrency } = this.#options;
        if (!research.enabled || outline.research_topics.length === 0) {
            return [];
        }
        const results = await mapLimit(
            outline.research_topics,
            concurrency,
            (topic) => this.#researchTopic(topic)
        );
        const entries: TopicSources[] = [];
        let failed = 0;
        results.forEach((result, i) => {
            const topic = outline.research_topics[i] as ResearchTopic;
            if (result === null) failed += 1;
            else entries.push({ topic, sources: result.sources });
        });
        if (failed > 0) {
            this.#warnings.push(`関連資料を調べられなかった話題 ${failed} 件`);
        }
        return entries;
    }

    async #researchTopic(topic: ResearchTopic): Promise<ResearchResult | null> {
        const { research, agentKind, taskRoot, request } = this.#options;
        const name = `${request.jobId}-research-${topic.id}`;
        const result = await this.#runTask<
            ResearchResult & { readonly unverified?: readonly string[] }
        >({
            name,
            kind: 'research',
            // Web に出るタスクは、文字起こしのあるジョブの外で動かす。
            directory: path.join(taskRoot, name),
            // ここに渡すのは調査トピックだけ。文字起こしは渡さない。
            inputs: {
                'topic.json': `${JSON.stringify(
                    {
                        id: topic.id,
                        query: topic.query,
                        question: topic.question,
                    },
                    null,
                    2
                )}\n`,
            },
            resultFile: path.join(this.#workDirectory, `${name}.result.json`),
            description: `入力は topic.json だけです。topic は "${topic.id}" としてください。sources は ${MAX_SOURCES_PER_TOPIC} 件以下にしてください。`,
            validate: (value, run) => {
                const validation = validateResearch(value, {
                    topicId: topic.id,
                    maxSources: MAX_SOURCES_PER_TOPIC,
                });
                if (!validation.ok) return validation;
                return {
                    ok: true,
                    value: dropUnfetched(
                        validation.value,
                        fetchedUrls(agentKind, run.stdout)
                    ),
                };
            },
        });
        if (result === null) return null;
        if (!recordsFetches(agentKind)) {
            // 取得の記録がない CLI では、URL に実際に到達できることだけは確かめる。
            const reachable = await Promise.all(
                result.sources.map((s) => research.isReachable(s.url))
            );
            return {
                topic: result.topic,
                sources: result.sources.filter((_, i) => reachable[i]),
            };
        }
        return result;
    }

    async #correct(
        transcript: Transcript,
        outline: Outline,
        research: readonly TopicSources[]
    ): Promise<{
        readonly corrections: Map<string, LineCorrection>;
        readonly uncorrected: Set<string>;
    }> {
        const chunks = chunkLines(
            transcript.lines,
            CORRECTION_CHUNK_LINES,
            CORRECTION_CONTEXT_LINES
        );
        const context = renderCorrectionContext(outline, research);
        const results = await mapLimit(
            chunks,
            this.#options.concurrency,
            (chunk) => this.#correctChunk(chunk, context)
        );
        const corrections = new Map<string, LineCorrection>();
        const uncorrected = new Set<string>();
        let failed = 0;
        results.forEach((result, i) => {
            if (result === null) {
                failed += 1;
                for (const line of (chunks[i] as Chunk).target) {
                    uncorrected.add(line.id);
                }
                return;
            }
            for (const line of result.lines) corrections.set(line.id, line);
        });
        if (failed > 0) {
            this.#warnings.push(
                `校正できなかった区間 ${failed} 件(原文のまま掲載)`
            );
        }
        return { corrections, uncorrected };
    }

    #correctChunk(
        chunk: Chunk,
        context: string
    ): Promise<CorrectionResult | null> {
        const name = `correct-${chunk.id}`;
        const first = chunk.target[0] as Line;
        const last = chunk.target.at(-1) as Line;
        return this.#runTask<CorrectionResult>({
            name,
            kind: 'correct',
            directory: path.join(this.#workDirectory, name),
            inputs: { 'chunk.txt': renderChunk(chunk), 'context.md': context },
            resultFile: path.join(this.#workDirectory, `${name}.result.json`),
            description: `入力は chunk.txt と context.md です。chunk は "${chunk.id}"、校正対象は ${first.id} から ${last.id} までです。`,
            validate: (value) => validateCorrection(value, chunk),
        });
    }

    /** 校正済みの全文から議論マップを作る。作れなくてもページは作る。 */
    async #makeMap(
        transcript: Transcript,
        outline: Outline,
        corrections: ReadonlyMap<string, LineCorrection>
    ): Promise<ConversationMap | null> {
        const { request } = this.#options;
        const lines = transcript.lines.flatMap((line): Line[] => {
            const correction = corrections.get(line.id);
            if (correction?.kind === 'drop') return [];
            return [{ ...line, raw: correction?.text ?? line.raw }];
        });
        if (splitForOutline(lines).length > 1) {
            this.#warnings.push('会話が長すぎるため議論マップを省略');
            return null;
        }
        const files = renderForOutline(transcript, lines, request.timeZone);
        const transcriptFiles = Object.fromEntries(
            files.map((text, i) => [
                `transcript-${String(i + 1).padStart(2, '0')}.txt`,
                text,
            ])
        );
        const chapterCount = outline.chapters.length;
        const map = await this.#runTask<ConversationMap>({
            name: 'map',
            kind: 'map',
            directory: path.join(this.#workDirectory, 'map'),
            inputs: {
                'context.md': renderMapContext(outline),
                ...transcriptFiles,
            },
            resultFile: path.join(this.#workDirectory, 'map.result.json'),
            description: [
                `入力ファイルをすべて、順に読んでください: context.md, ${Object.keys(transcriptFiles).join(', ')}`,
                `章は全部で ${chapterCount} 章です。phases は 1 章から ${chapterCount} 章までを隙間なく覆ってください。`,
                `参加者の名前は次のとおりです(speaker にはこの名前を書く): ${transcript.participants.join('、')}`,
            ].join('\n'),
            validate: (value) =>
                validateMap(value, { transcript, chapterCount }),
        });
        if (map === null) {
            this.#warnings.push('議論マップを作れませんでした');
        }
        return map;
    }

    /** タスクを実行して検証を通った結果を返す。何度やってもだめなら null。 */
    async #runTask<T>(spec: TaskSpec<T>): Promise<T | null> {
        const cached = await readJsonIfExists(spec.resultFile);
        if (cached !== undefined) return cached as T;

        let errors: readonly string[] = [];
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
            await this.#prepareTask(spec, errors);
            const run = await this.#options.runner({
                name: spec.name,
                cwd: spec.directory,
                prompt: 'このディレクトリの task.md を読み、そこに書かれた SKILL の手順に従って out.json を書いてください。',
                web: spec.kind === 'research',
            });
            const inspection = inspectRun(this.#options.agentKind, run.stdout);
            await this.#recordRun(spec.kind, inspection.usage);
            if (inspection.quotaExhausted) {
                await rm(spec.directory, { recursive: true, force: true });
                throw new AgentQuotaError();
            }
            let problem = 'out.json が書かれていません';
            const output = await readJsonIfExists(
                path.join(spec.directory, 'out.json')
            ).catch((error: unknown) => {
                problem = `out.json が JSON として読めません: ${String(error)}`;
                return undefined;
            });
            if (output === undefined) {
                errors = [problem];
                this.#logger.warn(
                    `[${spec.name}] attempt ${attempt}: no output (exit ${run.exitCode}${run.timedOut ? ', timed out' : ''})`
                );
                continue;
            }
            const validation = spec.validate(output, run);
            if (validation.ok) {
                await writeJsonAtomic(spec.resultFile, validation.value);
                await rm(spec.directory, { recursive: true, force: true });
                this.#logger.info(`[${spec.name}] done`);
                return validation.value;
            }
            errors = validation.errors;
            this.#logger.warn(
                `[${spec.name}] attempt ${attempt}: ${errors.length} validation error(s)`
            );
        }
        await rm(spec.directory, { recursive: true, force: true });
        return null;
    }

    async #recordRun(kind: TaskKind, usage: RunUsage | null): Promise<void> {
        await mkdir(this.#workDirectory, { recursive: true });
        const entry: UsageEntry = { kind, usage };
        await appendFile(
            path.join(this.#workDirectory, USAGE_FILE),
            `${JSON.stringify(entry)}\n`
        );
    }

    async #prepareTask(
        spec: TaskSpec<unknown>,
        errors: readonly string[]
    ): Promise<void> {
        const { agentKind } = this.#options;
        await rm(spec.directory, { recursive: true, force: true });
        await mkdir(spec.directory, { recursive: true });
        const skillRelative = skillDirectory(agentKind);
        const skillTarget = path.join(spec.directory, skillRelative);
        await mkdir(path.join(skillTarget, 'references'), { recursive: true });
        await mkdir(path.join(skillTarget, 'schemas'), { recursive: true });
        await copyFile(
            path.join(SKILL_DIR, 'SKILL.md'),
            path.join(skillTarget, 'SKILL.md')
        );
        const reference = `references/${spec.kind}.md`;
        const schema = `schemas/${spec.kind === 'correct' ? 'correction' : spec.kind}.schema.json`;
        await copyFile(
            path.join(SKILL_DIR, reference),
            path.join(skillTarget, reference)
        );
        await copyFile(
            path.join(SKILL_DIR, schema),
            path.join(skillTarget, schema)
        );
        for (const [file, content] of Object.entries(spec.inputs)) {
            await writeFile(path.join(spec.directory, file), content);
        }
        const retry =
            errors.length === 0
                ? ''
                : `\n## 前回の出力の問題(すべて直してください)\n\n${errors.map((error) => `- ${error}`).join('\n')}\n`;
        await writeFile(
            path.join(spec.directory, 'task.md'),
            `# タスク: ${spec.kind}

手順: ${skillRelative}/SKILL.md と ${skillRelative}/${reference}
出力の形式: ${skillRelative}/${schema}
出力先: このディレクトリの out.json(ほかのファイルは作らない)

${spec.description}
${retry}`
        );
    }
}

function renderCorrectionContext(
    outline: Outline,
    research: readonly TopicSources[]
): string {
    const glossary = outline.glossary
        .map(
            (g) =>
                `- ${g.term}(聞き取り例: ${g.heard.join('、') || 'なし'}): ${g.note}`
        )
        .join('\n');
    const chapters = outline.chapters
        .map((c) => `- ${c.start}〜${c.end} ${c.title}: ${c.summary}`)
        .join('\n');
    const sources = research
        .flatMap((entry) =>
            entry.sources.map((s) => `- ${s.title}: ${s.summary}`)
        )
        .join('\n');
    return `# 会話の概要

${outline.title}

${outline.lede}

# 章の流れ

${chapters}

# 用語集

${glossary || '(なし)'}

# 調べた資料(用語の正しい表記の参考)

${sources || '(なし)'}
`;
}

function renderMapContext(outline: Outline): string {
    const chapters = outline.chapters
        .map(
            (c, i) => `${i + 1}. ${c.start}〜${c.end} ${c.title}: ${c.summary}`
        )
        .join('\n');
    const threads = outline.threads
        .map((t) => `- ${t.topic}: ${t.question}`)
        .join('\n');
    const glossary = outline.glossary
        .map((g) => `- ${g.term}: ${g.note}`)
        .join('\n');
    return `# 会話の概要

${outline.title}

${outline.lede}

# 章(番号は phases と chapters で使う)

${chapters}

# 論点の候補

${threads || '(なし)'}

# 用語集

${glossary || '(なし)'}
`;
}

function splitForOutline(lines: readonly Line[]): Array<readonly Line[]> {
    const parts: Line[][] = [];
    let current: Line[] = [];
    let chars = 0;
    for (const line of lines) {
        const size = line.raw.length + 10;
        const newSession =
            current.at(-1) !== undefined &&
            current.at(-1)?.session !== line.session;
        if (
            chars + size > OUTLINE_MAX_CHARS ||
            (newSession && chars > OUTLINE_MAX_CHARS / 2)
        ) {
            parts.push(current);
            current = [];
            chars = 0;
        }
        current.push(line);
        chars += size;
    }
    if (current.length > 0) parts.push(current);
    return parts;
}

/** 長い会話を分けて作った章立てをつなぐ。章番号の参照は通し番号に直す。 */
function mergeOutlines(outlines: readonly Outline[]): Outline {
    const [first, ...rest] = outlines;
    if (first === undefined) throw new Error('no outline');
    if (rest.length === 0) return first;
    let chapterOffset = 0;
    const topics: ResearchTopic[] = [];
    outlines.forEach((outline, index) => {
        for (const topic of outline.research_topics) {
            topics.push({
                ...topic,
                id: `${topic.id}-${index + 1}`,
                chapters: topic.chapters.map((n) => n + chapterOffset),
            });
        }
        chapterOffset += outline.chapters.length;
    });
    return {
        title: first.title,
        lede: outlines
            .map((o) => o.lede)
            .join(' ')
            .slice(0, 500),
        key_points: outlines.flatMap((o) => o.key_points).slice(0, 12),
        decisions: outlines.flatMap((o) => o.decisions).slice(0, 12),
        open_questions: outlines.flatMap((o) => o.open_questions).slice(0, 12),
        chapters: outlines.flatMap((o) => o.chapters),
        threads: outlines.flatMap((o) => o.threads).slice(0, 12),
        glossary: outlines.flatMap((o) => o.glossary),
        research_topics: topics.slice(0, 20),
    };
}

/** 実際に取得できなかった URL の資料を除く(LLM が作った URL を載せないため)。 */
function dropUnfetched(
    result: ResearchResult,
    fetched: ReadonlySet<string> | null
): ResearchResult {
    return {
        topic: result.topic,
        sources: result.sources.filter((source) => {
            if (!isSafeSourceUrl(source.url)) return false;
            if (fetched === null) return true;
            const normalized = normalizeUrl(source.url);
            return normalized !== null && fetched.has(normalized);
        }),
    };
}

async function readJsonIfExists(file: string): Promise<unknown> {
    let text: string;
    try {
        text = await readFile(file, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return undefined;
        }
        throw error;
    }
    return JSON.parse(text) as unknown;
}

interface UsageEntry {
    readonly kind: TaskKind;
    readonly usage: RunUsage | null;
}

/** ジョブで CLI を起動した記録を集計する。費用の報告が 1 件もなければ undefined。 */
export async function readJobUsage(
    jobDirectory: string
): Promise<JobUsage | undefined> {
    let text: string;
    try {
        text = await readFile(
            path.join(jobDirectory, JOB_WORK_DIR, USAGE_FILE),
            'utf8'
        );
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return undefined;
        }
        throw error;
    }
    const entries = text
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as UsageEntry);
    const reported = entries.filter((entry) => entry.usage !== null);
    if (reported.length === 0) return undefined;
    const sum = (field: keyof RunUsage): number =>
        reported.reduce((total, entry) => total + entry.usage![field], 0);
    const costByKind: Record<string, number> = {};
    for (const { kind, usage } of reported) {
        costByKind[kind] = roundUsd((costByKind[kind] ?? 0) + usage!.costUsd);
    }
    return {
        costUsd: roundUsd(sum('costUsd')),
        costByKind,
        runs: entries.length,
        unreportedRuns: entries.length - reported.length,
        inputTokens: sum('inputTokens'),
        cacheWriteTokens: sum('cacheWriteTokens'),
        cacheReadTokens: sum('cacheReadTokens'),
        outputTokens: sum('outputTokens'),
        webSearches: sum('webSearches'),
    };
}

function roundUsd(value: number): number {
    return Math.round(value * 1e6) / 1e6;
}

/**
 * 同時に limit 個まで実行する。1 つが例外を投げたら新しいものは始めず、
 * 動いているものが終わるのを待ってから失敗を返す。
 */
export async function mapLimit<T, R>(
    items: readonly T[],
    limit: number,
    task: (item: T) => Promise<R>
): Promise<R[]> {
    const results = new Array<R>(items.length);
    let next = 0;
    let failed = false;
    const worker = async (): Promise<void> => {
        while (next < items.length && !failed) {
            const index = next;
            next += 1;
            try {
                results[index] = await task(items[index] as T);
            } catch (error) {
                failed = true;
                throw error;
            }
        }
    };
    const settled = await Promise.allSettled(
        Array.from({ length: Math.min(limit, items.length) }, worker)
    );
    for (const outcome of settled) {
        if (outcome.status === 'rejected') throw outcome.reason;
    }
    return results;
}
