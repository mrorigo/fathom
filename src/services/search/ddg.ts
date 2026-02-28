export interface SearchResult {
    title: string;
    href: string;
    body: string;
}

export class SearchService {
    private headers: Record<string, string>;

    constructor() {
        this.headers = {
            // Keep headers minimal to avoid triggering DDG bot-challenge responses.
            "User-Agent": "fathom-cli/1.0 (+https://github.com/origo/fathom)",
        };
    }

    async search(
        query: string,
        limit: number = 5
    ): Promise<SearchResult[]> {
        const payload = new URLSearchParams({
            q: query,
            kl: "wt-wt", // No region
        });

        try {
            const pages = [
                `https://lite.duckduckgo.com/lite/?${payload.toString()}`,
                `https://duckduckgo.com/html/?${payload.toString()}`,
            ];

            for (const url of pages) {
                const response = await fetch(url, {
                    method: "GET",
                    headers: this.headers,
                });

                if (!response.ok) continue;

                const html = await response.text();
                if (this.isBotChallengeHtml(html)) continue;

                const parsed = this.parseLiteHtml(html, limit);
                if (parsed.length > 0) return parsed;
            }

            return [];
        } catch (error) {
            console.error("Error performing search:", error);
            return [];
        }
    }

    private parseLiteHtml(html: string, limit: number): SearchResult[] {
        const results: SearchResult[] = [];
        const linkRe = /<a\b[^>]*href=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
        const candidates: Array<{ href: string, title: string, index: number }> = [];

        let match: RegExpExecArray | null;
        while ((match = linkRe.exec(html)) !== null) {
            const rawHref = match[2];
            const rawTitle = match[3];
            if (!rawHref || !rawTitle) continue;

            const href = this.decodeHtml(rawHref.trim());
            const title = this.stripTags(this.decodeHtml(rawTitle)).trim();
            const index = match.index;

            if (!href || !title) continue;

            const looksLikeResult =
                /result-link|result__a|result-title/i.test(match[0]) ||
                /duckduckgo\.com\/l\/\?/.test(href) ||
                /^https?:\/\//i.test(href);

            if (!looksLikeResult) continue;
            candidates.push({ href, title, index });
        }

        for (let i = 0; i < candidates.length && results.length < limit; i++) {
            const current = candidates[i];
            if (!current) continue;

            const nextCandidate = candidates[i + 1];
            const nextIndex = nextCandidate ? nextCandidate.index : html.length;
            const between = html.slice(current.index, nextIndex);
            const snippet = this.extractSnippet(between);
            const normalizedHref = this.normalizeHref(current.href);

            if (!normalizedHref || !this.isOrganicResult(current.title, normalizedHref)) continue;
            results.push({
                title: current.title,
                href: normalizedHref,
                body: snippet,
            });
        }

        return results;
    }

    private extractSnippet(segment: string): string {
        const snippetPatterns = [
            /class=(["'])[^"']*result-snippet[^"']*\1[^>]*>([\s\S]*?)<\/(?:td|div|span)>/i,
            /class=(["'])[^"']*result__snippet[^"']*\1[^>]*>([\s\S]*?)<\/(?:td|div|span)>/i,
        ];

        for (const pattern of snippetPatterns) {
            const match = segment.match(pattern);
            const rawSnippet = match?.[2];
            if (rawSnippet) {
                return this.stripTags(this.decodeHtml(rawSnippet)).trim();
            }
        }

        return "";
    }

    private normalizeHref(rawHref: string): string {
        let href = rawHref.replace(/&amp;/g, "&").trim();
        if (!href) return "";

        if (href.startsWith("//")) {
            href = `https:${href}`;
        }

        try {
            const base = "https://duckduckgo.com";
            const url = new URL(href, base);
            const uddg = url.searchParams.get("uddg");

            if (uddg) {
                return this.safeDecodeURIComponent(uddg);
            }

            return url.toString();
        } catch {
            return href;
        }
    }

    private isOrganicResult(title: string, href: string): boolean {
        const cleanedTitle = title.trim().toLowerCase();
        if (!cleanedTitle || cleanedTitle === "more info" || cleanedTitle === "here") {
            return false;
        }

        try {
            const url = new URL(href);
            const host = url.hostname.toLowerCase();
            const path = url.pathname.toLowerCase();

            // Filter DDG internal navigation and sponsored click tracking.
            if (host === "duckduckgo.com" || host.endsWith(".duckduckgo.com")) {
                return path.startsWith("/l/");
            }

            return true;
        } catch {
            return false;
        }
    }

    private isBotChallengeHtml(html: string): boolean {
        return /anomaly-modal|challenge-form|bots use DuckDuckGo too/i.test(html);
    }

    private safeDecodeURIComponent(value: string): string {
        try {
            return decodeURIComponent(value);
        } catch {
            return value;
        }
    }

    private stripTags(value: string): string {
        return value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    }

    private decodeHtml(value: string): string {
        const decoded = value
            .replace(/&nbsp;/gi, " ")
            .replace(/&quot;/gi, "\"")
            .replace(/&apos;/gi, "'")
            .replace(/&lt;/gi, "<")
            .replace(/&gt;/gi, ">")
            .replace(/&amp;/gi, "&");

        return decoded
            .replace(/&#(\d+);/g, (_, code) => {
                const num = Number.parseInt(code, 10);
                return Number.isFinite(num) ? String.fromCharCode(num) : _;
            })
            .replace(/&#x([0-9a-f]+);/gi, (_, code) => {
                const num = Number.parseInt(code, 16);
                return Number.isFinite(num) ? String.fromCharCode(num) : _;
            });
    }
}
