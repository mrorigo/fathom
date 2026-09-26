import { expect, test } from "bun:test";
import { buildEvidenceArtifact, buildKnowledgeEvidenceArtifact, type ResearchConfig, type ResearchState } from "./engine.ts";

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
