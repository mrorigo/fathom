import { expect, test } from "bun:test";
import { buildEvidenceArtifact, type ResearchConfig, type ResearchState } from "./engine.ts";

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
