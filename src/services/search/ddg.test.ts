import { expect, test } from "bun:test";
import { SearchService } from "./ddg.ts";

test("search diagnostics distinguish empty, blocked, and unparseable responses", async () => {
    const originalFetch = globalThis.fetch;
    const service = new SearchService();
    try {
        globalThis.fetch = (async () => new Response("<html><body>No results</body></html>")) as unknown as typeof fetch;
        expect((await service.searchWithDiagnostics("empty")).status).toBe("empty");

        globalThis.fetch = (async () => new Response("<html><body>bots use DuckDuckGo too</body></html>")) as unknown as typeof fetch;
        expect((await service.searchWithDiagnostics("blocked")).status).toBe("blocked");

        globalThis.fetch = (async () => new Response('<a class="result-link" href="https://example.com"> </a>')) as unknown as typeof fetch;
        expect((await service.searchWithDiagnostics("unparseable")).status).toBe("unparseable");

        globalThis.fetch = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
        const originalError = console.error;
        console.error = () => {};
        try {
            expect((await service.searchWithDiagnostics("offline")).status).toBe("request_failed");
        } finally {
            console.error = originalError;
        }
    } finally {
        globalThis.fetch = originalFetch;
    }
});
