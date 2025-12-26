
import * as cheerio from "cheerio";

export interface SearchResult {
    title: string;
    href: string;
    body: string;
}

export class SearchService {
    private headers: Record<string, string>;

    constructor() {
        this.headers = {
            Accept:
                "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
            "Accept-Language": "en-GB,en-US;q=0.9,en;q=0.8",
            "Cache-Control": "max-age=0",
            Connection: "keep-alive",
            "User-Agent":
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        };
    }

    async search(
        query: string,
        limit: number = 5
    ): Promise<SearchResult[]> {
        const results: SearchResult[] = [];
        let start = 0;

        // We might need multiple requests if limit is large, but for now let's assume one page (approx 10-15 results) is enough if limit is small.
        // If limit > 20 we might need paging.

        const payload = new URLSearchParams({
            q: query,
            kl: "wt-wt", // No region
        });

        try {
            // Improved: Use simple fetch with form-urlencoded body for POST
            const response = await fetch("https://lite.duckduckgo.com/lite/", {
                method: "POST",
                headers: {
                    ...this.headers,
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                body: payload.toString(),
            });

            if (!response.ok) {
                throw new Error(`DDG Lite responded with ${response.status}`);
            }

            const html = await response.text();
            const $ = cheerio.load(html);

            const rows = $("table:last-of-type tr");

            rows.each((i, row) => {
                if (results.length >= limit) return false;

                const linkEl = $(row).find("a.result-link");
                if (linkEl.length > 0) {
                    const href = linkEl.attr("href");
                    const title = linkEl.text().trim();
                    const snippet = $(row).next().find(".result-snippet").text().trim();

                    if (href) {
                        results.push({
                            title: title,
                            href: decodeURIComponent(href),
                            body: snippet
                        });
                    }
                }
            });

            return results;
        } catch (error) {
            console.error("Error performing search:", error);
            return [];
        }
    }
}
