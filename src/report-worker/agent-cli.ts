/**
 * LLM の CLI ごとの起動方法の違いをここに閉じ込める。
 *
 * どの CLI でも Bash は使わせない。文字起こしを読むタスクには Web のツールも渡さない。
 */

export type AgentKind = 'claude' | 'codex' | 'opencode';

export interface AgentSettings {
    readonly kind: AgentKind;
    readonly model: string | null;
    readonly effort: string | null;
    readonly maxBudgetUsd: number | null;
}

export interface AgentInvocation {
    /** タスクのディレクトリ(CLI の作業ディレクトリ)。 */
    readonly cwd: string;
    readonly prompt: string;
    /** Web の検索と取得を許すか。 */
    readonly web: boolean;
}

export interface AgentCommand {
    readonly command: string;
    readonly args: readonly string[];
    /** cwd からの相対パスと内容。起動前に書く設定ファイル。 */
    readonly files: Readonly<Record<string, string>>;
}

const SKILL_NAME = 'proceedings-report';

/** SKILL をコピーする場所(cwd からの相対パス)。各 CLI が探索する場所に合わせる。 */
export function skillDirectory(kind: AgentKind): string {
    return kind === 'claude'
        ? `.claude/skills/${SKILL_NAME}`
        : `.agents/skills/${SKILL_NAME}`;
}

/** LLM の API に必要な接続先。 */
export function agentDomains(kind: AgentKind): readonly string[] {
    switch (kind) {
        case 'claude':
            return [
                'api.anthropic.com',
                'claude.ai',
                'platform.claude.com',
                'console.anthropic.com',
            ];
        case 'codex':
            return ['api.openai.com', 'chatgpt.com', 'auth.openai.com'];
        case 'opencode':
            return ['api.anthropic.com', 'api.openai.com', 'models.dev'];
    }
}

/** 子プロセスに渡してよい環境変数(認証情報)。これ以外は渡さない。 */
export function agentCredentialVariables(kind: AgentKind): readonly string[] {
    switch (kind) {
        case 'claude':
            return ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];
        case 'codex':
            return ['OPENAI_API_KEY'];
        case 'opencode':
            return [
                'ANTHROPIC_API_KEY',
                'OPENAI_API_KEY',
                'OPENROUTER_API_KEY',
                'OPENCODE_API_KEY',
            ];
    }
}

export function buildAgentCommand(
    settings: AgentSettings,
    invocation: AgentInvocation
): AgentCommand {
    switch (settings.kind) {
        case 'claude':
            return buildClaude(settings, invocation);
        case 'codex':
            return buildCodex(settings, invocation);
        case 'opencode':
            return buildOpencode(settings, invocation);
    }
}

function buildClaude(
    settings: AgentSettings,
    invocation: AgentInvocation
): AgentCommand {
    const tools = invocation.web
        ? 'Read,Write,WebSearch,WebFetch'
        : 'Read,Write';
    const args = [
        '-p',
        invocation.prompt,
        ...(settings.model ? ['--model', settings.model] : []),
        ...(settings.effort ? ['--effort', settings.effort] : []),
        // Bash などのコードを実行するツールを外し、ファイル操作を作業ディレクトリに閉じ込める。
        '--restricted',
        '--tools',
        tools,
        // Web のツールは事前に許可しないと、確認できる人がいないので拒否される。
        ...(invocation.web ? ['--allowedTools', 'WebSearch,WebFetch'] : []),
        '--permission-mode',
        'acceptEdits',
        '--permission-prompts',
        'none',
        '--no-session-persistence',
        '--strict-mcp-config',
        '--append-system-prompt-file',
        `${skillDirectory('claude')}/SKILL.md`,
        // 引用した URL を実際に取得したか確かめるため、ツールの記録を出力させる。
        '--output-format',
        'stream-json',
        '--verbose',
        ...(settings.maxBudgetUsd === null
            ? []
            : ['--max-budget-usd', String(settings.maxBudgetUsd)]),
    ];
    return { command: 'claude', args, files: {} };
}

/** codex と opencode は作業ディレクトリの AGENTS.md を読むので、そこから SKILL を指す。 */
function agentsFile(kind: AgentKind): string {
    return `${skillDirectory(kind)}/SKILL.md を読み、その規則に必ず従ってください。\n`;
}

function buildCodex(
    settings: AgentSettings,
    invocation: AgentInvocation
): AgentCommand {
    const args = [
        ...(invocation.web ? ['--search'] : []),
        'exec',
        ...(settings.model ? ['-m', settings.model] : []),
        ...(settings.effort
            ? ['-c', `model_reasoning_effort="${settings.effort}"`]
            : []),
        '--ephemeral',
        '--ignore-user-config',
        '--ignore-rules',
        '--skip-git-repo-check',
        '--sandbox',
        'workspace-write',
        '--json',
        '-C',
        invocation.cwd,
        invocation.prompt,
    ];
    return {
        command: 'codex',
        args,
        files: { 'AGENTS.md': agentsFile('codex') },
    };
}

function buildOpencode(
    settings: AgentSettings,
    invocation: AgentInvocation
): AgentCommand {
    const args = [
        'run',
        ...(settings.model ? ['-m', settings.model] : []),
        ...(settings.effort ? ['--variant', settings.effort] : []),
        '--dir',
        invocation.cwd,
        '--pure',
        '--format',
        'json',
        invocation.prompt,
    ];
    const web = invocation.web ? 'allow' : 'deny';
    return {
        command: 'opencode',
        args,
        files: {
            'AGENTS.md': agentsFile('opencode'),
            'opencode.json': `${JSON.stringify(
                {
                    $schema: 'https://opencode.ai/config.json',
                    permission: {
                        bash: 'deny',
                        webfetch: web,
                        websearch: web,
                        edit: 'allow',
                        external_directory: 'deny',
                    },
                },
                null,
                2
            )}\n`,
        },
    };
}

/** URL を比較できる形にする(フラグメントと末尾のスラッシュを落とす)。 */
export function normalizeUrl(url: string): string | null {
    try {
        const parsed = new URL(url);
        parsed.hash = '';
        return parsed.toString().replace(/\/$/, '');
    } catch {
        return null;
    }
}

/** その CLI の出力から、取得した URL を確かめられるか。 */
export function recordsFetches(kind: AgentKind): boolean {
    return kind === 'claude';
}

/**
 * CLI の出力から、実際に取得できた URL を集める。
 * 確かめられない CLI では null を返し、呼び出し側は到達確認で代用する。
 */
export function fetchedUrls(
    kind: AgentKind,
    stdout: string
): Set<string> | null {
    return recordsFetches(kind) ? claudeFetchedUrls(stdout) : null;
}

interface StreamContent {
    readonly type?: string;
    readonly id?: string;
    readonly name?: string;
    readonly input?: { readonly url?: unknown };
    readonly tool_use_id?: string;
    readonly is_error?: boolean;
}

function claudeFetchedUrls(stdout: string): Set<string> {
    const requested = new Map<string, string>();
    const fetched = new Set<string>();
    for (const line of stdout.split('\n')) {
        let event: { message?: { content?: unknown } };
        try {
            event = JSON.parse(line) as typeof event;
        } catch {
            continue;
        }
        const content = event.message?.content;
        if (!Array.isArray(content)) continue;
        for (const item of content as StreamContent[]) {
            if (
                item.type === 'tool_use' &&
                item.name === 'WebFetch' &&
                item.id !== undefined &&
                typeof item.input?.url === 'string'
            ) {
                requested.set(item.id, item.input.url);
            } else if (
                item.type === 'tool_result' &&
                item.tool_use_id !== undefined &&
                item.is_error !== true
            ) {
                const url = requested.get(item.tool_use_id);
                const normalized = url && normalizeUrl(url);
                if (normalized) fetched.add(normalized);
            }
        }
    }
    return fetched;
}
