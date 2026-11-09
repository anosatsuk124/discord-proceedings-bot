/** LLM が書く JSON の型。形は skills/proceedings-report/schemas と揃える。 */

export interface Point {
    readonly text: string;
    readonly refs: readonly string[];
}

export interface FlowStep {
    readonly label: string;
    readonly text: string;
}

export interface Chapter {
    readonly title: string;
    readonly start: string;
    readonly end: string;
    readonly summary: string;
    readonly flow: readonly FlowStep[];
    readonly point: string;
}

export interface Position {
    readonly speaker: string;
    readonly text: string;
    readonly refs: readonly string[];
}

export interface Thread {
    readonly topic: string;
    readonly question: string;
    readonly positions: readonly Position[];
}

export interface GlossaryItem {
    readonly term: string;
    readonly heard: readonly string[];
    readonly note: string;
}

export interface ResearchTopic {
    readonly id: string;
    readonly query: string;
    readonly question: string;
    /** 関連する章の番号(1 から)。 */
    readonly chapters: readonly number[];
}

export interface Outline {
    readonly title: string;
    readonly lede: string;
    readonly key_points: readonly Point[];
    readonly decisions: readonly Point[];
    readonly open_questions: readonly Point[];
    readonly chapters: readonly Chapter[];
    readonly threads: readonly Thread[];
    readonly glossary: readonly GlossaryItem[];
    readonly research_topics: readonly ResearchTopic[];
}

export const SOURCE_KINDS = [
    'paper',
    'encyclopedia',
    'article',
    'other',
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export interface Source {
    readonly title: string;
    readonly url: string;
    readonly kind: SourceKind;
    readonly summary: string;
    readonly relevance: string;
}

export interface ResearchResult {
    readonly topic: string;
    readonly sources: readonly Source[];
}

export type CorrectionKind = 'fix' | 'infer' | 'drop';

export interface LineCorrection {
    readonly id: string;
    readonly kind: CorrectionKind;
    readonly text?: string;
    readonly note?: string;
}

export interface CorrectionResult {
    readonly chunk: string;
    readonly lines: readonly LineCorrection[];
}

export const MOVE_KINDS = [
    'claim',
    'reason',
    'example',
    'objection',
    'reply',
    'question',
    'concession',
] as const;
export type MoveKind = (typeof MOVE_KINDS)[number];

/** 議論の中の 1 つの動き。主張、理由、反論など。 */
export interface Move {
    readonly kind: MoveKind;
    readonly speaker: string;
    readonly text: string;
    readonly refs: readonly string[];
}

export interface Branch {
    readonly stance: string;
    readonly moves: readonly Move[];
}

export const OUTCOME_STATUSES = [
    'agreed',
    'partial',
    'unresolved',
    'shifted',
] as const;
export type OutcomeStatus = (typeof OUTCOME_STATUSES)[number];

export interface Outcome {
    readonly status: OutcomeStatus;
    readonly text: string;
    readonly refs: readonly string[];
}

export interface DebateLink {
    readonly to: string;
    readonly text: string;
}

/** 問いから枝に分かれ、結果に行き着く 1 つの議論。 */
export interface Debate {
    readonly id: string;
    readonly title: string;
    readonly question: string;
    readonly chapters: readonly number[];
    readonly branches: readonly Branch[];
    readonly outcome: Outcome;
    readonly links: readonly DebateLink[];
}

/** 章をまとめた、会話の大きな局面。 */
export interface Phase {
    readonly title: string;
    readonly first_chapter: number;
    readonly last_chapter: number;
    readonly summary: string;
    readonly keywords: readonly string[];
    /** 次の局面に移ったきっかけ。最後の局面は null。 */
    readonly transition: string | null;
}

export interface ConversationMap {
    readonly through_line: string | null;
    readonly phases: readonly Phase[];
    readonly debates: readonly Debate[];
}

/** 関連資料。どのトピックのものかを付けて持つ。 */
export interface TopicSources {
    readonly topic: ResearchTopic;
    readonly sources: readonly Source[];
}
