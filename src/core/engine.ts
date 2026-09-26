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
    | { type: "report_selection", total_learnings: number, selected_learnings: number, sources: number }
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
    learningsPerChunk: number;
    maxSearchResultsPerQuery: number;
    maxReportLearnings: number;
}

export interface Learning {
    text: string;
    sourceId: number;
    sourceQuery: string;
}

export interface SourceRecord {
    id: number;
    url: string;
    canonicalUrl: string;
    firstSeenQuery: string;
    title?: string;
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
        source_excerpt: null;
        status: "active";
    }>;
}

function evidenceId(sourceCanonicalUrl: string, claim: string): string {
    const normalizedClaim = claim.trim().replace(/\s+/g, " ").toLowerCase();
    return `ev_${new Bun.CryptoHasher("sha256").update(`${sourceCanonicalUrl}\x1f${normalizedClaim}\x1f`).digest("hex")}`;
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
        if (!source) return [];
        const evidence_id = evidenceId(source.canonicalUrl, learning.text);
        if (seen.has(evidence_id)) return [];
        seen.add(evidence_id);
        return [{
            schema_version: 1 as const,
            type: "Evidence" as const,
            evidence_id,
            title: source.title?.trim() || learning.text.trim(),
            claim: learning.text.trim(),
            tags: [],
            source_url: source.url,
            source_canonical_url: source.canonicalUrl,
            source_title: source.title?.trim() || null,
            source_published_at: null,
            retrieved_at: createdAt,
            research_query: learning.sourceQuery,
            fathom_run_id: fathomRunId,
            source_excerpt: null,
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
        items: state.learnings.flatMap((learning, index) => {
            const source = sourcesById.get(learning.sourceId);
            if (!source) return [];
            return [{
                id: `E${String(index + 1).padStart(3, "0")}`,
                claim: learning.text,
                source_id: learning.sourceId,
                source_url: source.url,
                source_canonical_url: source.canonicalUrl,
                source_query: learning.sourceQuery,
                origin: "fathom_learning" as const,
            }];
        }),
    };
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
    private limit: ReturnType<typeof pLimit>;
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
        this.limit = pLimit(config.concurrency);
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

    private getOrCreateSource(rawUrl: string, sourceQuery: string, title?: string): SourceRecord {
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
        };

        this.state.sources.push(source);
        this.sourceByCanonicalUrl.set(canonicalUrl, source);
        return source;
    }

    private getSourceUrlById(sourceId: number): string {
        return this.state.sources.find(source => source.id === sourceId)?.url ?? "unknown";
    }

    private selectReportLearnings(topic: string): Learning[] {
        const terms = [...new Set(topic.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? [])]
            .filter(term => !new Set(["the", "and", "for", "with", "from", "that", "this", "into", "not", "are", "is"]).has(term));
        const score = (learning: Learning) => {
            const text = `${learning.text} ${learning.sourceQuery}`.toLowerCase();
            return terms.reduce((total, term) => total + (text.includes(term) ? 1 : 0), 0);
        };
        const ranked = this.state.learnings
            .map((learning, index) => ({ learning, index, score: score(learning) }))
            .filter(item => item.score > 0)
            .sort((left, right) => right.score - left.score || left.index - right.index);
        const limit = Math.max(1, this.config.maxReportLearnings);
        const selected: Learning[] = [];
        const usedSources = new Set<number>();
        for (const item of ranked) {
            if (selected.length >= limit) break;
            if (usedSources.has(item.learning.sourceId)) continue;
            selected.push(item.learning);
            usedSources.add(item.learning.sourceId);
        }
        for (const item of ranked) {
            if (selected.length >= limit) break;
            if (!selected.includes(item.learning)) selected.push(item.learning);
        }
        return selected.length ? selected : this.state.learnings.slice(0, limit);
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
            const { object: result, usage } = await this.llm.generateObject(userMessage, SerpQueriesSchema, systemPrompt);
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
            const { object: result, usage } = await this.llm.generateObject(userMessage, LearningsSchema, systemPrompt);
            this.updateUsage(usage);
            return result;
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
            this.limit(async () => {
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
                this.limit(async () => {
                    console.log(`   ⬇️ Fetching: ${result.href} `);
                    const content = await this.scraper.fetchAndConvert(result.href);
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
                        sourceTitle: result.title,
                    };
                })
            )
        );

        const processedResults = await Promise.all(contentPromises);
        const newFollowUps: string[] = [];

        for (const res of processedResults) {
            if (!res) continue;
            const source = this.getOrCreateSource(res.sourceUrl, res.sourceQuery, res.sourceTitle);
            const newLearnings: Learning[] = res.learnings.map(text => ({
                text,
                sourceId: source.id,
                sourceQuery: res.sourceQuery,
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
            await Promise.all(nextPrompts.map(p => this.limit(() =>
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

    async generateReport(prompt: string): Promise<string> {
        const targetUniqueSources = 3;
        const hardMinimumSources = 2;
        await this.ensureMinimumSourceDiversity(prompt, targetUniqueSources);
        if (this.state.sources.length < hardMinimumSources) {
            throw new Error(`Insufficient source diversity to generate report (${this.state.sources.length} unique source).`);
        }

        const currentDate = new Date().toUTCString();
        const selectedLearnings = this.selectReportLearnings(prompt);
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
        });
        const systemPrompt = "You are a professional report writer. Current Date: " + currentDate;

        const userMessage = `Topic: ${prompt}
      Unique Sources:
      ${uniqueSources || "None"}

      Research Learnings (each learning references a source ID):
      ${selectedLearnings.map(l => `- [${l.sourceId}] ${l.text}\n  Context: Found via "${l.sourceQuery}"`).join("\n")}

      Write a comprehensive, professional Markdown report roughly 3-5 pages long. 
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
        const { content: report, usage } = await this.llm.generateTextStream(userMessage, systemPrompt, (_, characters) => {
            if (characters - lastProgress >= 1_000) {
                lastProgress = characters;
                this.log({ type: "report_progress", characters });
            }
        });
        this.updateUsage(usage);
        return report;
    }

    getEvidenceArtifact(topic: string): EvidenceArtifact {
        return buildEvidenceArtifact(topic, this.state, this.config, this.llmOptions);
    }

    /** Return durable knowledge-store evidence for this completed research run. */
    getKnowledgeEvidenceArtifact(fathomRunId: string): KnowledgeEvidenceArtifact {
        return buildKnowledgeEvidenceArtifact(this.state, fathomRunId);
    }
}
