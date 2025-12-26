
export class Screener {
    private blacklist: RegExp[];
    private whitelist: RegExp[];

    constructor(blacklistPatterns: string[] = [], whitelistPatterns: string[] = []) {
        this.blacklist = blacklistPatterns.map(p => new RegExp(p, "i"));
        this.whitelist = whitelistPatterns.map(p => new RegExp(p, "i"));
    }

    isAllowed(url: string): boolean {
        // 1. Check whitelist (if exists, URL must match AT LEAST one)
        if (this.whitelist.length > 0) {
            const permitted = this.whitelist.some(r => r.test(url));
            if (!permitted) return false;
        }

        // 2. Check blacklist (URL must NOT match ANY)
        // Default blacklist for usually garbage sites or loops
        const defaultBlacklist = [
            "youtube.com", "facebook.com", "instagram.com", "twitter.com", "x.com",
            "linkedin.com", "pinterest.com", "tiktok.com", "duckduckgo.com",
            "signup", "login", "register", "signin"
        ];

        if (defaultBlacklist.some(s => url.includes(s))) return false;

        if (this.blacklist.length > 0) {
            const forbidden = this.blacklist.some(r => r.test(url));
            if (forbidden) return false;
        }

        return true;
    }
}
