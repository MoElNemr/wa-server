/**
 * In-memory Cache Manager with TTL support and invalidation on update.
 */
class MemoryCache {
    constructor() {
        this.store = new Map();
        this.stats = {
            hits: 0,
            misses: 0,
        };
    }

    /**
     * Store item in cache with optional TTL in seconds.
     * Default TTL: 300 seconds (5 minutes).
     */
    set(key, value, ttlSeconds = 300) {
        const expiresAt = ttlSeconds ? Date.now() + (ttlSeconds * 1000) : null;
        this.store.set(key, { value, expiresAt });
    }

    /**
     * Retrieve item from cache if exists and not expired.
     */
    get(key) {
        const item = this.store.get(key);
        if (!item) {
            this.stats.misses++;
            return null;
        }

        if (item.expiresAt && Date.now() > item.expiresAt) {
            this.store.delete(key);
            this.stats.misses++;
            return null;
        }

        this.stats.hits++;
        return item.value;
    }

    /**
     * Delete item from cache immediately on update.
     */
    del(key) {
        return this.store.delete(key);
    }

    /**
     * Delete all items matching a prefix (e.g. "session:").
     */
    delPattern(prefix) {
        let count = 0;
        for (const key of this.store.keys()) {
            if (key.startsWith(prefix)) {
                this.store.delete(key);
                count++;
            }
        }
        return count;
    }

    /**
     * Clear all cached items.
     */
    flush() {
        this.store.clear();
    }

    /**
     * Get current cache stats and size.
     */
    getStats() {
        return {
            keysCount: this.store.size,
            hits: this.stats.hits,
            misses: this.stats.misses,
        };
    }
}

const cache = new MemoryCache();

module.exports = cache;
