import { expect, test } from "bun:test";
import { DeepResearchEngine, buildEvidenceArtifact, buildKnowledgeEvidenceArtifact, extractSourceContext, rankLearningsForReport, type ResearchConfig, type ResearchState } from "./engine.ts";

test("evidence artifact preserves canonical source provenance", () => {
    const config: ResearchConfig = {
        depth: 1,
        breadth: 1,
        concurrency: 1,
        learningsPerChunk: 5,
        maxSearchResultsPerQuery: 5,
        maxReportLearnings: 20,
    };
    const state: ResearchState = {
        learnings: [{ text: "A checkable fact.", sourceId: 1, sourceQuery: "example" }],
        sources: [{ id: 1, url: "https://example.com/?utm_source=x", canonicalUrl: "https://example.com/", firstSeenQuery: "example" }],
        visitedUrls: new Set(["https://example.com/"]),
        tokenUsage: { prompt: 10, completion: 5, total: 15 },
    };

    const artifact = buildEvidenceArtifact("Example", state, config, { model: "model", baseURL: "https://api.example/v1" });

    expect(artifact.schema_version).toBe(1);
    expect(artifact.items).toEqual([{
        id: "E001",
        claim: "A checkable fact.",
        source_id: 1,
        source_url: "https://example.com/?utm_source=x",
        source_canonical_url: "https://example.com/",
        source_query: "example",
        origin: "fathom_learning",
    }]);
});

test("knowledge export uses durable source-claim IDs", () => {
    const state: ResearchState = {
        learnings: [
            { text: "A checkable fact.", sourceId: 1, sourceQuery: "example" },
            { text: "A  checkable fact.", sourceId: 1, sourceQuery: "example again" },
        ],
        sources: [{ id: 1, url: "https://example.com/?utm_source=x", canonicalUrl: "https://example.com/", firstSeenQuery: "example", title: "Example source" }],
        visitedUrls: new Set(["https://example.com/"]),
        tokenUsage: { prompt: 10, completion: 5, total: 15 },
    };

    const artifact = buildKnowledgeEvidenceArtifact(state, "blogger-run:discovery", "2026-09-26T10:00:00Z");

    expect(artifact).toMatchObject({
        schema_version: 1,
        producer: "fathom",
        contract: "blogger-knowledge-v1",
        fathom_run_id: "blogger-run:discovery",
    });
    expect(artifact.items).toHaveLength(1);
    expect(artifact.items[0]!).toMatchObject({
        type: "Evidence",
        title: "Example source",
        source_canonical_url: "https://example.com/",
        research_query: "example",
        tags: [],
        status: "active",
    });
    expect(artifact.items[0]!.evidence_id).toBe("ev_051f1674513232c1e77840010280fe394299d55aab452be50a15c819070c645a");
});

test("a supplied source report never triggers diversity web research", async () => {
    const config: ResearchConfig = {
        depth: 1, breadth: 1, concurrency: 1, learningsPerChunk: 5,
        maxSearchResultsPerQuery: 5, maxReportLearnings: 20,
    };
    const engine = new DeepResearchEngine(config);
    const internal = engine as unknown as {
        state: ResearchState;
        ensureMinimumSourceDiversity: () => Promise<void>;
        llm: { generateTextStream: () => Promise<{ content: string; usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }> };
    };
    internal.state = {
        learnings: [{ text: "A supplied-source fact.", sourceId: 1, sourceQuery: "file:///source.md" }],
        sources: [{ id: 1, url: "file:///source.md", canonicalUrl: "file:///source.md", firstSeenQuery: "file:///source.md" }],
        visitedUrls: new Set(), tokenUsage: { prompt: 0, completion: 0, total: 0 },
    };
    let diversityRequested = false;
    internal.ensureMinimumSourceDiversity = async () => { diversityRequested = true; };
    internal.llm = {
        generateTextStream: async () => ({
            content: "# Source report", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
    };

    await engine.generateReport("file:///source.md", { discoverSources: false });

    expect(diversityRequested).toBe(false);
});

test("source context uses the document title and opening paragraph", () => {
    expect(extractSourceContext("# Useful source\n\nThis is the opening context.\n\n## Details\nMore text.", "copy.md")).toEqual({
        title: "Useful source", excerpt: "This is the opening context.",
    });
});

test("report ranking favors direct relevance, preserves source diversity, and removes duplicates", () => {
    const result = rankLearningsForReport("multi agent coding critique", [
        { text: "Multi-agent coding uses targeted critique to improve patches.", sourceId: 1, sourceQuery: "multi agent coding" },
        { text: "Multi-agent coding uses targeted critique to improve patches in practice.", sourceId: 1, sourceQuery: "multi agent coding" },
        { text: "Independent reviewers catch security failures in generated code.", sourceId: 2, sourceQuery: "agent code review" },
        { text: "A distant claim about garden planning.", sourceId: 3, sourceQuery: "gardens" },
    ], 3);

    expect(result.learnings.map(learning => learning.sourceId)).toEqual([1, 2]);
    expect(result.deduplicated).toBe(1);
});
