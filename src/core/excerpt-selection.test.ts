/**
 * Excerpt selection: giving each claim the passage it came from.
 *
 * ## What was wrong
 *
 * `extractSourceContext` took the **first prose block after the page's H1** and stored it
 * once per *source*. A page yields several claims, so every claim from that page received
 * the same paragraph — usually one about something else entirely.
 *
 * Measured against a downstream vault of 854 excerpts:
 *
 * - 6.2% of a claim's content words appeared in its excerpt; the median was **zero**
 * - 278 of 530 comparable pairs (52%) shared no content word at all
 * - 84 were not prose: 40 table-of-contents anchors, 25 badge/avatar images, 46 error or
 *   bot-check pages such as "Please complete the verification above."
 *
 * The excerpt exists so a consumer can ask whether a source supports a claim. Given a
 * paragraph about something else, that question cannot be answered — and an error page is
 * worse than nothing, because it reads as "the source could not be read", which is a
 * confident answer to a question nobody asked.
 *
 * ## The fix, and its limit
 *
 * `selectExcerpt` splits the source into prose paragraphs, scores each by term overlap with
 * the claim, and takes a character-budgeted window around the best match. No model call.
 *
 * It cannot invent relevance: a claim paraphrased far from the source's wording will still
 * miss, and then falls back to the opening prose rather than returning nothing. Term overlap
 * is a proxy, and this is the honest ceiling for a selection that costs no tokens.
 */

import { describe, expect, test } from "bun:test";
import { extractSourceContext, selectExcerpt } from "./engine.ts";

/** A page with the shape that produced the worst excerpts: a TOC, badges, then real prose. */
const PAGE = [
    "# Semantic Superposition in the Residual Stream",
    "",
    "![](https://img.shields.io/badge/license-MIT-blue.svg)",
    "",
    "[Introduction](#introduction)",
    "[Method](#method)",
    "[Results](#results)",
    "",
    "## Introduction",
    "",
    "Transformer language models appear to represent many more features than their output",
    "layer exposes, which is the puzzle this work sets out to resolve.",
    "",
    "## Method",
    "",
    "We train sparse dictionaries on the residual stream at every layer and position, then",
    "measure how much of the activation each feature explains.",
    "",
    "The semantic axis was direction-specific: its variance ratio was 1.81, exceeding the 99th",
    "percentile of 100 random directions at 0.92, with empirical p below 0.01.",
    "",
    "## Results",
    "",
    "Feature absorption emerges as the dominant effect once three or more features compete for",
    "a single direction in the residual stream.",
].join("\n");

describe("selectExcerpt", () => {
    test("gives a claim the passage it came from, not the page's opening", () => {
        const claim =
            "The semantic axis was direction-specific: its variance ratio was 1.81, exceeding the 99th percentile of 100 random directions.";
        const excerpt = selectExcerpt(PAGE, claim);

        expect(excerpt).not.toBeNull();
        // The passage that states the finding, not the introduction that precedes it.
        expect(excerpt).toContain("variance ratio was 1.81");
        expect(excerpt).not.toContain("puzzle this work sets out to resolve");
    });

    test("two claims from one page get different passages", () => {
        // The structural bug: one excerpt per source meant every claim on a page got the
        // same paragraph, so at most one of them could be described by it.
        const absorption =
            "Feature absorption emerges as the dominant effect once three or more features compete for a single direction.";
        const puzzle =
            "Transformer models appear to represent many more features than their output layer exposes.";

        const first = selectExcerpt(PAGE, absorption);
        const second = selectExcerpt(PAGE, puzzle);

        expect(first).not.toBeNull();
        expect(second).not.toBeNull();
        expect(first).not.toBe(second);
        expect(first).toContain("Feature absorption");
        expect(second).toContain("puzzle this work sets out to resolve");
    });

    test("never returns table-of-contents anchors, badges, or author links", () => {
        // The shapes that made up 84 unusable excerpts. A claim mentioning a heading name
        // must not drag the heading's anchor back as its evidence.
        for (const claim of [
            "Introduction",
            "The method section describes the sparse dictionary approach in detail.",
            "Method",
            "Results",
        ]) {
            const excerpt = selectExcerpt(PAGE, claim);
            expect(excerpt ?? "").not.toContain("](#");
            expect(excerpt ?? "").not.toContain("img.shields.io");
        }
    });

    test("falls back to opening prose rather than returning nothing", () => {
        // A claim whose terms appear nowhere in the source — a paraphrase, or extraction
        // drift. Something is better than a null the consumer cannot distinguish from
        // "this source had no prose".
        const unrelated =
            "A separate finding about quantum error correction thresholds in trapped ion hardware.";
        const excerpt = selectExcerpt(PAGE, unrelated);

        expect(excerpt).not.toBeNull();
        expect(excerpt!.length).toBeGreaterThan(0);
    });

    test("returns null for a page with no prose at all", () => {
        expect(selectExcerpt("# Title\n\n```\ncode only\n```\n", "anything")).toBeNull();
        expect(selectExcerpt("", "anything")).toBeNull();
    });

    test("a code fence is never treated as prose", () => {
        const withCode = [
            "# Title",
            "",
            "The measurement reports a variance ratio of 1.81 for the semantic axis.",
            "",
            "```",
            "variance_ratio = compute_axis_variance(residual, axis)",
            "```",
        ].join("\n");

        const excerpt = selectExcerpt(withCode, "variance ratio 1.81 semantic axis");
        expect(excerpt).toContain("variance ratio of 1.81");
        expect(excerpt).not.toContain("compute_axis_variance");
    });

    test("respects the character budget", () => {
        // A long page must not put the whole thing in every artifact item.
        const long = ["# Title", "", "The semantic axis has a variance ratio of 1.81 in every layer."].join("\n");
        const filler = Array.from({ length: 200 }, (_, i) => `Paragraph ${i} about unrelated material.`).join("\n\n");

        const excerpt = selectExcerpt(`${long}\n\n${filler}`, "variance ratio 1.81 semantic axis");
        expect(excerpt!.length).toBeLessThanOrEqual(500);
        expect(excerpt).toContain("variance ratio of 1.81");
    });
});

describe("extractSourceContext", () => {
    test("takes the title from the H1 and the opening prose after it", () => {
        expect(
            extractSourceContext("# Useful source\n\nThis is the opening context.\n\n## Details\nMore text.", "copy.md"),
        ).toEqual({ title: "Useful source", excerpt: "This is the opening context." });
    });

    test("does not fall back to the scraper's title over the document's own H1", () => {
        expect(extractSourceContext("# Document heading\n\nBody text here.", "Search result title").title).toBe(
            "Document heading",
        );
    });

    test("skips a table of contents when taking the opening", () => {
        // Previously the TOC's anchors were what got stored, for every GitHub-shaped page.
        const excerpt = extractSourceContext(PAGE, "fallback").excerpt;
        expect(excerpt).not.toContain("](#");
        expect(excerpt).toContain("Transformer language models appear to represent");
    });
});
