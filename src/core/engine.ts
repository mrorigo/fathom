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
}

export interface Learning {
    text: string;
    sourceUrl: string;
    sourceQuery: string;
}

export interface ResearchState {
    learnings: Learning[];
    visitedUrls: Set<string>;
    tokenUsage: TokenUsage;
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

    constructor(
        config: ResearchConfig,
        llmOptions?: { apiKey?: string; baseURL?: string; model?: string }
    ) {
        super();
        this.config = config;
        this.llm = new LLMClient(llmOptions);
        this.search = new SearchService();
        this.scraper = new ScraperService();
        this.screener = new Screener();
        this.limit = pLimit(config.concurrency);
        this.state = {
            learnings: [],
            visitedUrls: new Set(),
            tokenUsage: { prompt: 0, completion: 0, total: 0 },
        };
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
    ${this.state.learnings.length > 0 ? this.state.learnings.map(l => `- ${l.text} (Source: ${l.sourceUrl})`).join("\n") : "None"}
    
    Generate ${numQueries} unique search queries to find more information.
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

    private async _researchRecursive(prompt: string, currentDepth: number): Promise<void> {
        if (currentDepth <= 0) return;

        console.log(`\n🔍 Researching(Depth ${currentDepth}): "${prompt}"`);

        const queries = await this.generateQueries(prompt, this.config.breadth);
        this.log({ type: "query_generated", depth: currentDepth, count: queries.length, queries });
        console.log(`   Generanted queries: ${queries.join(", ")} `);

        const searchPromises = queries.map(query =>
            this.limit(async () => {
                const results = await this.search.search(query);
                this.log({ type: "search", query, results_count: results.length });

                // URL Screening & Deduplication
                const newResults = results
                    .filter(r => !this.state.visitedUrls.has(r.href) && this.screener.isAllowed(r.href))
                    .slice(0, this.config.maxSearchResultsPerQuery);

                for (const r of newResults) {
                    this.state.visitedUrls.add(r.href);
                }
                return { query, results: newResults };
            })
        );

        const searchResults = await Promise.all(searchPromises);

        // Flatten results to process contents
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
                        sourceQuery: query
                    };
                })
            )
        );

        const processedResults = await Promise.all(contentPromises);

        // Collect new learnings and follow-up questions
        const newFollowUps: string[] = [];
        for (const res of processedResults) {
            if (res) {
                const newLearnings: Learning[] = res.learnings.map(text => ({
                    text,
                    sourceUrl: res.sourceUrl,
                    sourceQuery: res.sourceQuery
                }));
                this.state.learnings.push(...newLearnings);
                newFollowUps.push(...res.followUpQuestions);
            }
        }

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

    async generateReport(prompt: string): Promise<string> {
        const currentDate = new Date().toUTCString();
        const systemPrompt = "You are a professional report writer. Current Date: " + currentDate;
        const userMessage = `Topic: ${prompt}
      Research Learnings:
      ${this.state.learnings.map(l => `- ${l.text}\n  Source: ${l.sourceUrl}\n  Context: Found via "${l.sourceQuery}"`).join("\n")}

      Write a comprehensive, professional Markdown report roughly 3-5 pages long. 
      Use H1 for title, H2 for sections. 
      Include an Executive Summary at the start.

      CITATION RULES:
      - You MUST include a "References" section at the very end of the report.
      - You MUST list every source URL used in the References section.
      - You MUST cite sources in the text using [1], [2], etc.
      - DO NOT say "bibliography available upon request". You must provide the full list of sources here.
      `;
        this.log({ type: "report_generation", prompt, systemPrompt, userMessage });
        const { content: report, usage } = await this.llm.generateText(userMessage, systemPrompt);
        this.updateUsage(usage);
        return report;
    }
}
