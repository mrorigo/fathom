
import TurndownService from "turndown";
import * as cheerio from "cheerio";

export class ScraperService {
    private turndown: TurndownService;
    private headers: Record<string, string>;
    private jinaPrefix: string;

    constructor() {
        this.turndown = new TurndownService({
            headingStyle: "atx",
            codeBlockStyle: "fenced",
        });
        // Remove scripts, styles, etc.
        this.turndown.remove(["script", "style", "noscript", "iframe", "svg"]);

        this.headers = {
            "User-Agent":
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        };
        this.jinaPrefix = "https://r.jina.ai/";
    }

    private isLikelyPdfUrl(url: string): boolean {
        const normalized = url.toLowerCase();
        return normalized.includes(".pdf") || normalized.includes("application/pdf");
    }

    private async fetchViaJinaMarkdown(url: string): Promise<string> {
        const proxyUrl = `${this.jinaPrefix}${url}`;
        const response = await fetch(proxyUrl, { headers: this.headers });
        if (!response.ok) {
            console.warn(`Failed to fetch via jina proxy ${proxyUrl}: ${response.status}`);
            return "";
        }
        return (await response.text()).trim();
    }

    async fetchAndConvert(url: string): Promise<string> {
        try {
            if (this.isLikelyPdfUrl(url)) {
                return await this.fetchViaJinaMarkdown(url);
            }

            const response = await fetch(url, { headers: this.headers });

            if (!response.ok) {
                console.warn(`Failed to fetch ${url}: ${response.status}`);
                return "";
            }

            const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
            if (contentType.includes("application/pdf")) {
                return await this.fetchViaJinaMarkdown(url);
            }

            const html = await response.text();

            // Sanitization step: use cheerio to remove unwanted elements before turndown
            const $ = cheerio.load(html);
            $("script").remove();
            $("style").remove();
            $("nav").remove();
            $("footer").remove();
            $("header").remove();

            // Get the main content if possible, or body
            const contentHtml = $("main").html() || $("body").html() || html;

            const markdown = this.turndown.turndown(contentHtml);
            return markdown;
        } catch (error) {
            console.error(`Error scraping ${url}:`, error);
            return "";
        }
    }
}
