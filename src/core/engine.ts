import { EventEmitter } from "events";
import pLimit from "p-limit";
import { z } from "zod";
import { LLMClient } from "../services/llm/openai_client.ts";
import { SearchService, type SearchResult } from "../services/search/ddg.ts";
import { ScraperService } from "../services/scraper/fetcher.ts";
import { Screener } from "../utils/screener.ts";

/**
 * Token usage statistics for LLM operations.
 */
export interface TokenUsage {
    prompt: number;
    completion: number;
    total: number;
}

/**
 * Structured log event for tracking research progress.
 */
export type LogEvent =
    | { type: "report_generation", prompt: string, systemPrompt: string, userMessage: string }
    | { type: "report_selection", total_learnings: number, selected_learnings: number, sources: number, deduplicated: number, strategy: string }
    | { type: "report_generation_started", selected_learnings: number, estimated_prompt_chunks: number }
    | { type: "report_progress", characters: number }
    | { type: "query_generated", depth: number, count: number, queries: string[] }
    | { type: "search", query: string, results_count: number }
    | { type: "scrape", url: string, status: "success" | "skipped" | "failed" }
    | { type: "learnings", url: string, count: number, learnings: string[] }
    | { type: "error", message: string };

/**
 * Configuration for the Deep Research Engine.
 */
export interface ResearchConfig {
    depth: number;
    breadth: number;
    concurrency: number;
    networkConcurrency?: number;
    llmConcurrency?: number;
    learningsPerChunk: number;
    maxSearchResultsPerQuery: number;
    maxReportLearnings: number;
}

export interface Learning {
    text: string;
    sourceId: number;
    sourceQuery: string;
    /**
     * The passage of the source this claim was extracted from.
     *
     * Per-learning rather than per-source, because a page yields several claims and one
     * opening paragraph cannot be the passage behind all of them. Selected without a model
     * call by term overlap — see `selectExcerpt`.
     */
    excerpt?: string | null;
}

export interface SourceRecord {
    id: number;
    url: string;
    canonicalUrl: string;
    firstSeenQuery: string;
    title?: string;
    excerpt?: string;
}

export interface ResearchState {
    learnings: Learning[];
    sources: SourceRecord[];
    visitedUrls: Set<string>;
    tokenUsage: TokenUsage;
}

/** Versioned, machine-readable research handoff for downstream consumers. */
export interface EvidenceArtifact {
    schema_version: 1;
    producer: "fathom";
    created_at: string;
    topic: string;
    config: ResearchConfig;
    model?: string;
    api_endpoint?: string;
    token_usage: TokenUsage;
    sources: SourceRecord[];
    items: Array<{
        id: string;
        claim: string;
        source_id: number;
        source_url: string;
        source_canonical_url: string;
        source_query: string;
        origin: "fathom_learning";
    }>;
}

/** Durable evidence documents compatible with Blogger's knowledge-v1 contract. */
export interface KnowledgeEvidenceArtifact {
    schema_version: 1;
    producer: "fathom";
    contract: "blogger-knowledge-v1";
    created_at: string;
    fathom_run_id: string;
    items: Array<{
        schema_version: 1;
        type: "Evidence";
        evidence_id: string;
        title: string;
        claim: string;
        tags: string[];
        source_url: string;
        source_canonical_url: string;
        source_title: string | null;
        source_published_at: null;
        retrieved_at: string;
        research_query: string;
        fathom_run_id: string;
        source_excerpt: string | null;
        status: "active";
    }>;
}

function evidenceId(sourceCanonicalUrl: string, claim: string): string {
    const normalizedClaim = claim.trim().replace(/\s+/g, " ").toLowerCase();
    return `ev_${new Bun.CryptoHasher("sha256").update(`${sourceCanonicalUrl}\x1f${normalizedClaim}\x1f`).digest("hex")}`;
}

/**
 * Terms used to match a claim against the passages of its source.
 *
 * Deliberately shorter than the ranker's stop list: a claim's distinctive words are what
 * identify the passage it came from, and dropping anything longer than three characters
 * would throw away exactly the terms that do that work.
 */
const EXCERPT_STOP_WORDS = new Set([
    "about", "after", "also", "and", "are", "because", "been", "before", "being", "between", "both", "but", "can", "could",
    "does", "doing", "done", "during", "each", "either", "else", "even", "every", "from", "further", "had", "has", "have",
    "having", "here", "however", "into", "its", "itself", "just", "like", "make", "many", "more", "most", "much", "must",
    "neither", "only", "other", "over", "own", "rather", "same", "should", "since", "some", "such", "than", "that", "the",
    "their", "them", "then", "there", "these", "they", "this", "those", "through", "thus", "under", "until", "very", "were",
    "what", "when", "where", "which", "while", "who", "whom", "why", "will", "with", "within", "without", "would", "your",
]);

function excerptTerms(value: string): Set<string> {
    return new Set(
        (value.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? [])
            .filter(term => !EXCERPT_STOP_WORDS.has(term)),
    );
}

/**
 * Whether a line is prose, or furniture.
 *
 * The opening-prose extractor was taking the first non-blank lines after the title, which on
 * most pages is not prose. Measured over a downstream vault of 854 excerpts: 40 were a bare
 * table-of-contents anchor, 25 a badge or avatar image, and 46 more were an interstitial or
 * error page ("Please complete the verification above"). Those are worse than no excerpt —
 * an error page reads to a consumer as "the source could not be read", which is a confident
 * answer to a question nobody asked.
 *
 * Rejected rather than cleaned: a line of pure furniture carries no meaning that a partial
 * repair would recover.
 */
function isProseLine(line: string): boolean {
    const trimmed = line.trim();
    if (trimmed.length < 12) return false;
    // Images and badges: `![alt](url)`, or an avatar/link line from a paper's header.
    if (/^!?\[[^\]]*\]\([^)]*\)\s*$/.test(trimmed)) return false;
    // A run of links with almost no prose between them: an author list, a citation strip.
    const links = trimmed.match(/\[[^\]]*\]\([^)]*\)/g);
    if (links && links.join("").length / trimmed.length > 0.6) return false;
    // A bare anchor, or a bare URL rendered without its markdown.
    if (/^\(?#[^)]*\)?$/.test(trimmed)) return false;
    if (/^(?:https?:\/\/|www\.)\S+$/.test(trimmed)) return false;
    // Bot checks and error pages. Matched loosely so a reworded variant still fails.
    if (/please\s+(?:complete|verify|prove)\b/i.test(trimmed)) return false;
    if (/\b(?:checking|verifying)\s+your\s+browser\b/i.test(trimmed)) return false;
    if (/couldn(?:'|\u2019|’)t\s+load\b/i.test(trimmed)) return false;
    if (/\bjavascript\s+is\s+(?:required|disabled)\b/i.test(trimmed)) return false;
    if (/\baccess\s+denied\b/i.test(trimmed)) return false;
    if (/\b(?:are you a robot|verify you are human)\b/i.test(trimmed)) return false;
    if (/\b404\b.*\bnot\s+found\b/i.test(trimmed)) return false;
    return true;
}

/** A page's prose, as paragraphs of cleaned text. */
function proseParagraphs(content: string): string[] {
    const lines = content.replace(/\r\n/g, "\n").split("\n");
    const paragraphs: string[] = [];
    let current: string[] = [];
    let inFence = false;

    const flush = () => {
        if (current.length === 0) return;
        const text = current.join(" ").replace(/\s+/g, " ").trim();
        if (text !== "") paragraphs.push(text);
        current = [];
    };

    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("```")) {
            inFence = !inFence;
            flush();
            continue;
        }
        if (inFence) continue;
        // A heading ends the paragraph above it and is structure, not prose. A horizontal
        // rule or a list marker likewise: a table of contents is a list of anchors.
        if (/^#{1,6}\s/.test(trimmed) || /^\s*([-*_])\s*(?:\1\s*){2,}$/.test(trimmed) || /^\s*[-*+]\s+/.test(trimmed) || /^\s*\d+[.)]\s+/.test(trimmed)) {
            flush();
            continue;
        }
        if (trimmed === "") {
            flush();
            continue;
        }
        if (isProseLine(trimmed)) current.push(trimmed);
        else flush();
    }
    flush();
    return paragraphs;
}

/** Content words, used to decide whether a passage says anything at all. */
function contentWords(text: string): string[] {
    return (text.toLowerCase().match(/[a-z][a-z'-]{2,}/g) ?? []).filter(word => !EXCERPT_STOP_WORDS.has(word));
}

const MAX_EXCERPT_CHARS = 500;
const MIN_EXCERPT_CHARS = 40;

/**
 * Choose the passage of a source that a claim came from.
 *
 * The excerpt used to be the page's opening prose, stored once per source and copied onto
 * every claim from that page. A five-claim page therefore gave all five the same paragraph,
 * usually about something else entirely. Measured against a downstream vault: 6.2% of a
 * claim's content words appeared in its excerpt, the median was zero, and half the pairs
 * shared no content word at all — so the excerpt could not answer "does this source support
 * this claim", which is the only reason it exists.
 *
 * Scored on term overlap with the claim, with no model call: split the source into
 * paragraphs, score each by how many of the claim's distinctive terms it contains, and take
 * the best. Ties and misses fall back to the opening prose, so a claim whose terms do not
 * appear verbatim still gets something rather than nothing.
 *
 * A window is taken around the match rather than a single paragraph, because the sentence
 * that states a finding is usually next to the one that qualifies it.
 */
export function selectExcerpt(content: string, claim: string): string | null {
    const paragraphs = proseParagraphs(content);
    if (paragraphs.length === 0) return null;

    const claimTerms = excerptTerms(claim);
    const opening = paragraphs[0] ?? null;

    if (claimTerms.size === 0) return opening;

    let bestIndex = -1;
    let bestScore = 0;
    for (const [index, paragraph] of paragraphs.entries()) {
        const terms = excerptTerms(paragraph);
        if (terms.size === 0) continue;
        let shared = 0;
        for (const term of claimTerms) if (terms.has(term)) shared++;
        if (shared > bestScore) {
            bestScore = shared;
            bestIndex = index;
        }
    }

    // No paragraph shares a single distinctive term with the claim. The opening prose is a
    // better guess than an unrelated paragraph that happened to be scored.
    if (bestIndex < 0) return opening;

    // A window: the matching paragraph, extended backwards and forwards for context while
    // there is room, and cut on a character budget.
    const window: string[] = [paragraphs[bestIndex]!];
    let length = window[0]!.length;
    for (let offset = 1; offset < paragraphs.length; offset++) {
        const before = paragraphs[bestIndex - offset];
        if (before === undefined || length + before.length + 1 > MAX_EXCERPT_CHARS) break;
        window.unshift(before);
        length += before.length + 1;
        const after = paragraphs[bestIndex + offset];
        if (after !== undefined && length + after.length + 1 <= MAX_EXCERPT_CHARS) {
            window.push(after);
            length += after.length + 1;
        }
    }

    const excerpt = window.join(" ").trim();
    if (excerpt.length < MIN_EXCERPT_CHARS) return opening;
    return excerpt.slice(0, MAX_EXCERPT_CHARS);
}

/**
 * Extract durable, human-readable source context without another model call.
 *
 * `excerpt` is the page's opening prose, kept for callers that want the document rather than
 * a claim — the title, and the source-record fallback. Per-claim excerpts come from
 * `selectExcerpt`, because one opening paragraph cannot serve every claim on a page.
 */
export function extractSourceContext(content: string, fallbackTitle?: string): { title: string; excerpt: string | null } {
    const lines = content.replace(/\r\n/g, "\n").split("\n");
    const heading = lines.find(line => /^#\s+\S/.test(line.trim()));
    const title = heading?.replace(/^#\s+/, "").trim() || fallbackTitle?.trim() || "Supplied source";
    const opening = proseParagraphs(content)[0] ?? null;
    return { title, excerpt: opening ? opening.slice(0, MAX_EXCERPT_CHARS) : null };
}

/** Build durable source-claim documents for an external knowledge store. */
export function buildKnowledgeEvidenceArtifact(
    state: ResearchState,
    fathomRunId: string,
    createdAt = new Date().toISOString(),
): KnowledgeEvidenceArtifact {
    const sourcesById = new Map(state.sources.map(source => [source.id, source]));
    const seen = new Set<string>();
    const items = state.learnings.flatMap(learning => {
        const source = sourcesById.get(learning.sourceId);
        const claim = learning.text.trim();
        if (!source || !claim || !source.url.trim() || !source.canonicalUrl.trim()) return [];
        const evidence_id = evidenceId(source.canonicalUrl, claim);
        if (seen.has(evidence_id)) return [];
        seen.add(evidence_id);
        return [{
            schema_version: 1 as const,
            type: "Evidence" as const,
            evidence_id,
            title: source.title?.trim() || claim,
            claim,
            tags: [],
            source_url: source.url,
            source_canonical_url: source.canonicalUrl,
            source_title: source.title?.trim() || null,
            source_published_at: null,
            retrieved_at: createdAt,
            research_query: learning.sourceQuery,
            fathom_run_id: fathomRunId,
            // The claim's own passage first. A source-level excerpt is only a fallback: on
            // a page with several claims it describes whichever one happened to be stored.
            source_excerpt: learning.excerpt?.trim() || source.excerpt?.trim() || null,
            status: "active" as const,
        }];
    });
    return { schema_version: 1, producer: "fathom", contract: "blogger-knowledge-v1", created_at: createdAt, fathom_run_id: fathomRunId, items };
}

export function buildEvidenceArtifact(
    topic: string,
    state: ResearchState,
    config: ResearchConfig,
    llmOptions?: { baseURL?: string; model?: string },
): EvidenceArtifact {
    const sourcesById = new Map(state.sources.map(source => [source.id, source]));
    return {
        schema_version: 1,
        producer: "fathom",
        created_at: new Date().toISOString(),
        topic,
        config,
        model: llmOptions?.model,
        api_endpoint: llmOptions?.baseURL,
        token_usage: state.tokenUsage,
        sources: state.sources,
        items: state.learnings.flatMap(learning => {
            const source = sourcesById.get(learning.sourceId);
            const claim = learning.text.trim();
            if (!source || !claim || !source.url.trim() || !source.canonicalUrl.trim()) return [];
            return [{
                claim,
                source_id: learning.sourceId,
                source_url: source.url,
                source_canonical_url: source.canonicalUrl,
                source_query: learning.sourceQuery,
                origin: "fathom_learning" as const,
            }];
        }).map((item, index) => ({ ...item, id: `E${String(index + 1).padStart(3, "0")}` })),
    };
}

const RANKING_STOP_WORDS = new Set([
    "about", "after", "also", "and", "are", "but", "for", "from", "into", "its", "not", "that", "the", "their", "then", "this", "those", "through", "with",
]);

function rankingTerms(value: string): string[] {
    return [...new Set(
        (value.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? [])
            .filter(term => !RANKING_STOP_WORDS.has(term)),
    )];
}

function jaccard(left: Set<string>, right: Set<string>): number {
    if (!left.size || !right.size) return 0;
    let intersection = 0;
    for (const term of left) if (right.has(term)) intersection++;
    return intersection / (left.size + right.size - intersection);
}

/**
 * Select report learnings without a second model call.
 *
 * The ranker values direct topic matches over query-only matches, keeps one
 * strong claim per source first, removes near-duplicates, then uses a bounded
 * redundancy penalty while filling the remaining report slots.
 */
export function rankLearningsForReport(
    topic: string,
    learnings: Learning[],
    maxLearnings: number,
): { learnings: Learning[]; deduplicated: number } {
    const topicTerms = rankingTerms(topic);
    const normalizedTopic = topic.toLowerCase().replace(/\s+/g, " ").trim();
    const candidates = learnings.map((learning, index) => {
        const claimTerms = new Set(rankingTerms(learning.text));
        const queryTerms = new Set(rankingTerms(learning.sourceQuery));
        const claimMatches = topicTerms.filter(term => claimTerms.has(term)).length;
        const queryMatches = topicTerms.filter(term => queryTerms.has(term)).length;
        const coverage = topicTerms.length ? claimMatches / topicTerms.length : 0;
        const words = learning.text.trim().split(/\s+/).filter(Boolean).length;
        const specificity = (words >= 8 && words <= 90 ? 1 : 0)
            + (/\d/.test(learning.text) ? 0.5 : 0);
        const phraseBonus = normalizedTopic.length >= 12 && learning.text.toLowerCase().includes(normalizedTopic) ? 3 : 0;
        return {
            learning, index, claimTerms,
            score: claimMatches * 4 + queryMatches + coverage * 2 + specificity + phraseBonus,
        };
    }).filter(candidate => candidate.score > 0);

    const ranked = (candidates.length ? candidates : learnings.map((learning, index) => ({
        learning, index, claimTerms: new Set(rankingTerms(learning.text)), score: 0,
    }))).sort((left, right) => right.score - left.score || left.index - right.index);

    const unique: typeof ranked = [];
    for (const candidate of ranked) {
        // Keep the higher-ranked representative of semantically overlapping
        // extraction atoms. A high threshold avoids collapsing related claims.
        if (unique.some(existing => jaccard(candidate.claimTerms, existing.claimTerms) >= 0.82)) continue;
        unique.push(candidate);
    }

    const limit = Math.max(1, maxLearnings);
    const selected: typeof unique = [];
    const selectedSources = new Set<number>();
    for (const candidate of unique) {
        if (selected.length >= limit) break;
        if (selectedSources.has(candidate.learning.sourceId)) continue;
        selected.push(candidate);
        selectedSources.add(candidate.learning.sourceId);
    }

    while (selected.length < limit) {
        const remaining = unique.filter(candidate => !selected.includes(candidate));
        if (!remaining.length) break;
        const next = remaining.sort((left, right) => {
            const leftRedundancy = Math.max(0, ...selected.map(item => jaccard(left.claimTerms, item.claimTerms)));
            const rightRedundancy = Math.max(0, ...selected.map(item => jaccard(right.claimTerms, item.claimTerms)));
            const leftScore = left.score - leftRedundancy * 5;
            const rightScore = right.score - rightRedundancy * 5;
            return rightScore - leftScore || right.score - left.score || left.index - right.index;
        })[0]!;
        selected.push(next);
    }
    return { learnings: selected.map(item => item.learning), deduplicated: ranked.length - unique.length };
}

const SerpQueriesSchema = z.object({
    queries: z.array(z.string()),
});

const LearningsSchema = z.object({
    learnings: z.array(z.string()),
    followUpQuestions: z.array(z.string()),
});


/**
 * Core engine for orchestrating deep recursive research.
 * Manages the loop of: Query Generation -> Search -> Scraping -> Learning Extraction -> Recursion.
 */
export class DeepResearchEngine extends EventEmitter {
    private llm: LLMClient;
    private search: SearchService;
    private scraper: ScraperService;
    private screener: Screener;
    private branchLimit: ReturnType<typeof pLimit>;
    private networkLimit: ReturnType<typeof pLimit>;
    private llmLimit: ReturnType<typeof pLimit>;
    private config: ResearchConfig;
    private state: ResearchState;
    private sourceByCanonicalUrl: Map<string, SourceRecord>;
    private llmOptions?: { apiKey?: string; baseURL?: string; model?: string };

    constructor(
        config: ResearchConfig,
        llmOptions?: { apiKey?: string; baseURL?: string; model?: string }
    ) {
        super();
        this.config = config;
        this.llmOptions = llmOptions;
        this.llm = new LLMClient(llmOptions);
        this.search = new SearchService();
        this.scraper = new ScraperService();
        this.screener = new Screener();
        this.branchLimit = pLimit(config.concurrency);
        this.networkLimit = pLimit(config.networkConcurrency ?? config.concurrency);
        this.llmLimit = pLimit(config.llmConcurrency ?? config.concurrency);
        this.state = {
            learnings: [],
            sources: [],
            visitedUrls: new Set(),
            tokenUsage: { prompt: 0, completion: 0, total: 0 },
        };
        this.sourceByCanonicalUrl = new Map();
    }

    private updateUsage(usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }) {
        if (!usage) return;
        this.state.tokenUsage.prompt += usage.prompt_tokens;
        this.state.tokenUsage.completion += usage.completion_tokens;
        this.state.tokenUsage.total += usage.total_tokens;
    }

    private log(event: LogEvent) {
        this.emit("event", event, this.state.tokenUsage);
    }

    private canonicalizeUrl(rawUrl: string): string {
        try {
            const url = new URL(rawUrl);
            url.hostname = url.hostname.toLowerCase();
            url.hash = "";

            const trackingParams = new Set(["fbclid", "gclid", "mc_cid", "mc_eid"]);
            const paramsToDelete: string[] = [];

            for (const [key] of url.searchParams.entries()) {
                if (key.toLowerCase().startsWith("utm_") || trackingParams.has(key.toLowerCase())) {
                    paramsToDelete.push(key);
                }
            }
            for (const key of paramsToDelete) {
                url.searchParams.delete(key);
            }
            url.searchParams.sort();

            if (url.pathname !== "/" && url.pathname.endsWith("/")) {
                url.pathname = url.pathname.replace(/\/+$/, "");
            }

            return url.toString();
        } catch {
            return rawUrl.trim();
        }
    }

    private getOrCreateSource(rawUrl: string, sourceQuery: string, title?: string, excerpt?: string | null): SourceRecord {
        const canonicalUrl = this.canonicalizeUrl(rawUrl);
        const existing = this.sourceByCanonicalUrl.get(canonicalUrl);
        if (existing) {
            return existing;
        }

        const source: SourceRecord = {
            id: this.state.sources.length + 1,
            url: rawUrl,
            canonicalUrl,
            firstSeenQuery: sourceQuery,
            title,
            excerpt: excerpt || undefined,
        };

        this.state.sources.push(source);
        this.sourceByCanonicalUrl.set(canonicalUrl, source);
        return source;
    }

    private getSourceUrlById(sourceId: number): string {
        return this.state.sources.find(source => source.id === sourceId)?.url ?? "unknown";
    }

    private selectReportLearnings(topic: string): { learnings: Learning[]; deduplicated: number } {
        return rankLearningsForReport(topic, this.state.learnings, this.config.maxReportLearnings);
    }

    // Generate research queries based on the current prompt and previous learnings
    private async generateQueries(
        prompt: string,
        numQueries: number
    ): Promise<string[]> {
        const currentDate = new Date().toUTCString();
        const systemPrompt = "You are an expert researcher. Current Date: " + currentDate + ". Generate search queries to investigate the given topic.";
        const userMessage = `
Topic: ${prompt}
    
    Previous Learnings:
    ${this.state.learnings.length > 0 ? this.state.learnings.map(l => `- ${l.text} (Source #${l.sourceId}: ${this.getSourceUrlById(l.sourceId)})`).join("\n") : "None"}
    
    Generate ${numQueries} unique search queries to find more information.
    Preserve the named entities and scope in the topic. Do not introduce a programming language,
    framework, platform, industry, or use case that the topic does not name.
    Turn a thesis into searchable keyword phrases: use the named entities plus one or two concrete
    concepts from the thesis. Do not quote the entire topic, do not copy parenthetical punctuation,
    and do not add a year unless the topic explicitly requires a time-bound result.
    Return strictly JSON: { "queries": ["query1", "query2", ...] }
`;

        try {
            const { object: result, usage } = await this.llmLimit(() =>
                this.llm.generateObject(userMessage, SerpQueriesSchema, systemPrompt)
            );
            this.updateUsage(usage);
            return result.queries.slice(0, numQueries);
        } catch (e: unknown) {
            const errorMessage = e instanceof Error ? e.message : String(e);
            this.log({ type: "error", message: `Failed to generate queries: ${errorMessage} ` });
            console.warn("Failed to generate structured queries, falling back to basic list parsing or skipping", e);
            return [prompt]; // Fallback
        }
    }

    // Extract learnings from a scraped page content
    private async processContent(
        query: string,
        content: string
    ): Promise<{ learnings: string[]; followUpQuestions: string[] }> {
        const currentDate = new Date().toUTCString();
        const systemPrompt = "You are a research assistant. Current Date: " + currentDate + ". Extract key facts and follow-up questions from the text.";
        const userMessage = `
Query: ${query}

Content:
    ${content.substring(0, 25000)} // Truncate to avoid context overflow
    
    Extract up to ${this.config.learningsPerChunk} unique key learnings / facts and up to 3 follow - up research questions.
    Return strictly JSON: { "learnings": ["..."], "followUpQuestions": ["..."] }
`;

        try {
            const { object: result, usage } = await this.llmLimit(() =>
                this.llm.generateObject(userMessage, LearningsSchema, systemPrompt)
            );
            this.updateUsage(usage);
            return {
                learnings: result.learnings
                    .filter(learning => typeof learning === "string")
                    .map(learning => learning.trim())
                    .filter(Boolean),
                followUpQuestions: result.followUpQuestions
                    .filter(question => typeof question === "string")
                    .map(question => question.trim())
                    .filter(Boolean),
            };
        } catch (e: unknown) {
            const errorMessage = e instanceof Error ? e.message : String(e);
            this.log({ type: "error", message: `Failed to process content: ${errorMessage} ` });
            return { learnings: [], followUpQuestions: [] };
        }
    }

    // Main recursive research loop
    async run(prompt: string): Promise<ResearchState> {
        await this._researchRecursive(prompt, this.config.depth);
        return this.state;
    }

    private async researchQueries(queries: string[]): Promise<string[]> {
        const searchPromises = queries.map(query =>
            this.networkLimit(async () => {
                const results = await this.search.search(query);
                this.log({ type: "search", query, results_count: results.length });

                const seenCanonicalUrls = new Set<string>();
                const newResults = results
                    .filter(result => this.screener.isAllowed(result.href))
                    .filter(result => {
                        const canonicalUrl = this.canonicalizeUrl(result.href);
                        if (seenCanonicalUrls.has(canonicalUrl) || this.state.visitedUrls.has(canonicalUrl)) {
                            return false;
                        }
                        seenCanonicalUrls.add(canonicalUrl);
                        return true;
                    })
                    .slice(0, this.config.maxSearchResultsPerQuery);

                for (const result of newResults) {
                    this.state.visitedUrls.add(this.canonicalizeUrl(result.href));
                }

                return { query, results: newResults };
            })
        );

        const searchResults = await Promise.all(searchPromises);

        const contentPromises = searchResults.flatMap(({ query, results }) =>
            results.map(result =>
                (async () => {
                    console.log(`   ⬇️ Fetching: ${result.href} `);
                    const content = await this.networkLimit(() => this.scraper.fetchAndConvert(result.href));
                    if (!content || content.length < 100) {
                        this.log({ type: "scrape", url: result.href, status: "failed" });
                        return null;
                    }

                    this.log({ type: "scrape", url: result.href, status: "success" });

                    const processed = await this.processContent(query, content);
                    if (processed.learnings.length > 0) {
                        console.log(`   💡 Extracted ${processed.learnings.length} learnings from ${result.title} `);
                        this.log({ type: "learnings", url: result.href, count: processed.learnings.length, learnings: processed.learnings });
                    }

                    return {
                        ...processed,
                        sourceUrl: result.href,
                        sourceQuery: query,
                        // Deliberately `result.title` rather than the context's heading: the
                        // excerpt is additive, and changing which title wins would silently
                        // alter every source title in every artifact.
                        sourceTitle: result.title,
                        // The source's own opening prose, so a downstream consumer can check a
                        // claim against the document it came from rather than against a
                        // one-line extraction of it. Only `ingestSource()` supplied this
                        // before, so `source_excerpt` was always null on the research path —
                        // and a consumer holding just the claim had no way to judge whether
                        // the source supported it.
                        sourceExcerpt: extractSourceContext(content, result.title).excerpt,
                        // The page text, kept so each claim can be given the passage it came
                        // from rather than the page's opening. Held on the result and dropped
                        // after use — it is the largest thing in scope and nothing else needs it.
                        pageContent: content,
                    };
                })()
            )
        );

        const processedResults = await Promise.all(contentPromises);
        const newFollowUps: string[] = [];

        for (const res of processedResults) {
            if (!res) continue;
            const source = this.getOrCreateSource(res.sourceUrl, res.sourceQuery, res.sourceTitle, res.sourceExcerpt);
            const newLearnings: Learning[] = res.learnings.map(text => ({
                text,
                sourceId: source.id,
                sourceQuery: res.sourceQuery,
                // Per claim, from the page text: one opening paragraph for a page with five
                // claims describes none of them reliably.
                excerpt: selectExcerpt(res.pageContent, text),
            }));
            this.state.learnings.push(...newLearnings);
            newFollowUps.push(...res.followUpQuestions);
        }

        return newFollowUps;
    }

    private async _researchRecursive(prompt: string, currentDepth: number): Promise<void> {
        if (currentDepth <= 0) return;

        console.log(`\n🔍 Researching(Depth ${currentDepth}): "${prompt}"`);

        const queries = await this.generateQueries(prompt, this.config.breadth);
        this.log({ type: "query_generated", depth: currentDepth, count: queries.length, queries });
        console.log(`   Generanted queries: ${queries.join(", ")} `);
        const newFollowUps = await this.researchQueries(queries);

        // Prepare for next depth
        if (currentDepth > 1 && newFollowUps.length > 0) {
            // Pick best follow-ups (naive approach: just take specific number or aggregate)
            // Ideally we would cluster them. For now, we just pass the original prompt + combined context to next iteration
            // OR we recursively call on sub-questions. 
            // The previous implementation did: recursive call on "Next Query" generated from context.

            // Let's grab one unified "next step" prompt to keep tree clean or iterate on a few branches.
            // To prevent explosion, let's just pick top 2 follow ups if we have breadth > 1

            const nextPrompts = newFollowUps.slice(0, this.config.breadth);

            // Wait for sub-branches
            await Promise.all(nextPrompts.map(p => this.branchLimit(() =>
                this._researchRecursive(p, currentDepth - 1)
            )));
        }
    }

    private async ensureMinimumSourceDiversity(topic: string, minimumSources: number): Promise<void> {
        if (this.state.sources.length >= minimumSources) return;

        const maxAttempts = 2;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            if (this.state.sources.length >= minimumSources) break;

            const diversityPrompt = `${topic}\nFind independent and diverse primary sources about this topic.`;
            const queries = await this.generateQueries(diversityPrompt, this.config.breadth);
            this.log({ type: "query_generated", depth: 0, count: queries.length, queries });
            await this.researchQueries(queries);
        }

        if (this.state.sources.length < minimumSources) {
            this.log({
                type: "error",
                message: `Low source diversity: only ${this.state.sources.length} unique sources collected after retries.`,
            });
        }
    }

    async generateReport(prompt: string, options: { discoverSources?: boolean } = {}): Promise<string> {
        const discoverSources = options.discoverSources ?? true;
        if (discoverSources) {
            const targetUniqueSources = 3;
            const hardMinimumSources = 2;
            await this.ensureMinimumSourceDiversity(prompt, targetUniqueSources);
            if (this.state.sources.length < hardMinimumSources) {
                throw new Error(`Insufficient source diversity to generate report (${this.state.sources.length} unique source).`);
            }
        } else if (this.state.sources.length === 0) {
            throw new Error("Cannot generate a source report without an ingested source.");
        }

        const currentDate = new Date().toUTCString();
        const selection = this.selectReportLearnings(prompt);
        const selectedLearnings = selection.learnings;
        const selectedSourceIds = new Set(selectedLearnings.map(learning => learning.sourceId));
        const uniqueSources = this.state.sources
            .filter(source => selectedSourceIds.has(source.id))
            .map(source => `[${source.id}] ${source.url}`)
            .join("\n");
        this.log({
            type: "report_selection",
            total_learnings: this.state.learnings.length,
            selected_learnings: selectedLearnings.length,
            sources: selectedSourceIds.size,
            deduplicated: selection.deduplicated,
            strategy: "weighted-lexical+diversity+redundancy-penalty",
        });
        const systemPrompt = "You are a professional report writer. Current Date: " + currentDate;

        const userMessage = `Topic: ${prompt}
      Unique Sources:
      ${uniqueSources || "None"}

      Research Learnings (each learning references a source ID):
      ${selectedLearnings.map(l => `- [${l.sourceId}] ${l.text}\n  Context: Found via "${l.sourceQuery}"`).join("\n")}

      Write a ${discoverSources ? "comprehensive, professional Markdown report roughly 3-5 pages long" : "concise Markdown source report that faithfully summarizes this one supplied source"}.
      Use H1 for title, H2 for sections. 
      Include an Executive Summary at the start.

      CITATION RULES:
      - You MUST include a "References" section at the very end of the report.
      - You MUST list each source from "Unique Sources" exactly once in the References section.
      - You MUST cite sources in the text using [1], [2], etc., matching the provided source IDs.
      - DO NOT say "bibliography available upon request". You must provide the full list of sources here.
      `;
        this.log({ type: "report_generation", prompt, systemPrompt, userMessage });
        this.log({ type: "report_generation_started", selected_learnings: selectedLearnings.length, estimated_prompt_chunks: Math.max(1, Math.ceil(userMessage.length / 4_000)) });
        let lastProgress = 0;
        const { content: report, usage } = await this.llmLimit(() =>
            this.llm.generateTextStream(userMessage, systemPrompt, (_, characters) => {
                if (characters - lastProgress >= 1_000) {
                    lastProgress = characters;
                    this.log({ type: "report_progress", characters });
                }
            })
        );
        this.updateUsage(usage);
        return report;
    }

    getEvidenceArtifact(topic: string): EvidenceArtifact {
        return buildEvidenceArtifact(topic, this.state, this.config, this.llmOptions);
    }

    /** Extract evidence from one caller-supplied source without web discovery. */
    async ingestSource(url: string, content: string, title?: string): Promise<ResearchState> {
        const processed = await this.processContent(url, content);
        const sourceContext = extractSourceContext(content, title);
        const source = this.getOrCreateSource(url, url, sourceContext.title, sourceContext.excerpt);
        this.state.learnings.push(...processed.learnings.map(text => ({
            text,
            sourceId: source.id,
            sourceQuery: url,
            excerpt: selectExcerpt(content, text),
        })));
        return this.state;
    }

    /** Read a caller-supplied remote URL through the configured scraper. */
    async readUrl(url: string): Promise<string> { return this.scraper.fetchAndConvert(url); }

    /** Read a caller-supplied local file through the configured scraper. */
    async readFile(path: string): Promise<string> { return this.scraper.readLocalFile(path); }

    /** Return durable knowledge-store evidence for this completed research run. */
    getKnowledgeEvidenceArtifact(fathomRunId: string): KnowledgeEvidenceArtifact {
        return buildKnowledgeEvidenceArtifact(this.state, fathomRunId);
    }
}
