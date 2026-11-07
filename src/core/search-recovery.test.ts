import { expect, test } from "bun:test";
import { DeepResearchEngine, type ResearchConfig, type ResearchState } from "./engine.ts";

const config: ResearchConfig = {
    depth: 1, breadth: 1, concurrency: 1, learningsPerChunk: 5,
    maxSearchResultsPerQuery: 5, maxReportLearnings: 20,
};

function internals(engine: DeepResearchEngine) {
    return engine as unknown as {
        state: ResearchState;
        llm: { generateObject: (message: string, schema: unknown, system: string) => Promise<{ object: { queries: string[] }; usage: undefined }> };
        search: { searchWithDiagnostics: (query: string, limit: number) => Promise<{
            results: Array<{ href: string; title: string; body: string }>;
            status: "results" | "empty" | "blocked" | "unparseable" | "request_failed";
        }> };
        generateQueries: (prompt: string, breadth: number) => Promise<string[]>;
        scraper: { fetchAndConvert: (url: string) => Promise<string> };
        screener: { isAllowed: (url: string) => boolean };
        processContent: (query: string, content: string) => Promise<{ learnings: string[]; followUpQuestions: string[] }>;
        researchQueries: (queries: string[]) => Promise<string[]>;
    };
}

test("query-generation instructions ask for independent facets and established vocabulary", async () => {
    const engine = new DeepResearchEngine(config);
    const internal = internals(engine);
    let userMessage = "";
    internal.llm = {
        generateObject: async message => {
            userMessage = message;
            return { object: { queries: ["algorithmic accountability"] }, usage: undefined };
        },
    };

    await internal.generateQueries("Council and Ledger governance plus agent ecology", 1);

    expect(userMessage).toContain("independent queries");
    expect(userMessage).toContain("established");
    expect(userMessage).toContain("Avoid unnecessary exact-phrase quotes");
});

test("zero-result queries get one broadened retry whose query becomes source provenance", async () => {
    const engine = new DeepResearchEngine(config);
    const internal = internals(engine);
    const attempted: string[] = [];
    internal.search = {
        searchWithDiagnostics: async query => {
            attempted.push(query);
            if (attempted.length === 1) return { results: [], status: "empty" };
            return { results: [{ href: "https://example.com/source", title: "Source", body: "" }], status: "results" };
        },
    };
    internal.generateQueries = async () => ["algorithmic accountability"];
    internal.scraper = { fetchAndConvert: async () => "x".repeat(120) };
    internal.screener = { isAllowed: () => true };
    internal.processContent = async () => ({ learnings: ["A relevant finding."], followUpQuestions: [] });

    const events: Array<Record<string, unknown>> = [];
    engine.on("event", event => events.push(event));
    await internal.researchQueries(["Council Ledger governance"]);

    expect(attempted).toEqual(["Council Ledger governance", "algorithmic accountability"]);
    expect(internal.state.learnings[0]?.sourceQuery).toBe("algorithmic accountability");
    expect(events.some(event => event.type === "search_retry" && event.retry_query === "algorithmic accountability")).toBe(true);
    expect(events.some(event => event.type === "search" && event.retry_of === "Council Ledger governance" && event.filtered_count === 0)).toBe(true);
});

test("an unsuccessful broadened query is not retried again", async () => {
    const engine = new DeepResearchEngine(config);
    const internal = internals(engine);
    const attempted: string[] = [];
    internal.search = {
        searchWithDiagnostics: async query => {
            attempted.push(query);
            return { results: [], status: "empty" };
        },
    };
    internal.generateQueries = async () => ["canonical broader term"];

    await internal.researchQueries(["original quoted phrase"]);

    expect(attempted).toEqual(["original quoted phrase", "canonical broader term"]);
});

test("search results with verification interstitials are skipped before extraction", async () => {
    const engine = new DeepResearchEngine(config);
    const internal = internals(engine);
    internal.search = {
        searchWithDiagnostics: async () => ({
            results: [{ href: "https://example.com/blocked", title: "Blocked", body: "" }], status: "results",
        }),
    };
    internal.scraper = {
        fetchAndConvert: async () => "The source URL was protected by a security verification page.\n" + "Please complete the verification to continue.\n".repeat(5),
    };
    internal.screener = { isAllowed: () => true };
    let extractionCalled = false;
    internal.processContent = async () => {
        extractionCalled = true;
        return { learnings: ["The source could not be accessed."], followUpQuestions: [] };
    };
    const events: Array<Record<string, unknown>> = [];
    engine.on("event", event => events.push(event));

    await internal.researchQueries(["example"]);

    expect(extractionCalled).toBe(false);
    expect(internal.state.sources).toHaveLength(0);
    expect(internal.state.learnings).toHaveLength(0);
    expect(events).toContainEqual({ type: "scrape", url: "https://example.com/blocked", status: "skipped", reason: "access or error page" });
});
