
import TurndownService from "turndown";
import * as cheerio from "cheerio";

export class ScraperService {
    private turndown: TurndownService;
    private headers: Record<string, string>;

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
    }

    async fetchAndConvert(url: string): Promise<string> {
        try {
            const response = await fetch(url, { headers: this.headers });

            if (!response.ok) {
                console.warn(`Failed to fetch ${url}: ${response.status}`);
                return "";
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
