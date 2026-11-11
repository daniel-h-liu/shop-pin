/**
 * In-memory TTL cache so re-running the same board doesn't re-spend API calls.
 * Item detections are keyed by imageUrl; RetailerListing[] by adapter+searchQuery;
 * visually-verified deals by imageUrl+item+query.
 *
 * Single-process only — swap for Redis if this ever runs multi-instance.
 */

const DEFAULT_TTL_MS = 60 * 60 * 1000; // ~1hr

type Entry<T> = { value: T; expiresAt: number };

export class TTLCache<T> {
  private store = new Map<string, Entry<T>>();

  constructor(private ttlMs: number = DEFAULT_TTL_MS) {}

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  /** Get from cache, or compute + store on miss. */
  async getOrCompute(key: string, compute: () => Promise<T>): Promise<T> {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    const value = await compute();
    this.set(key, value);
    return value;
  }

  clear(): void {
    this.store.clear();
  }
}

import type { RetailerListing } from "@/lib/types";
import type { Detection } from "@/lib/vision/detectItems";

// Persist across dev hot-reloads via globalThis (same trick as the job store)
const g = globalThis as unknown as {
  __pdfDetectionCache?: TTLCache<Detection>;
  __pdfListingsCache?: TTLCache<RetailerListing[]>;
  __pdfVerifiedCache?: TTLCache<RetailerListing[]>;
};

export const detectionCache: TTLCache<Detection> =
  g.__pdfDetectionCache ?? (g.__pdfDetectionCache = new TTLCache());

export const listingsCache: TTLCache<RetailerListing[]> =
  g.__pdfListingsCache ?? (g.__pdfListingsCache = new TTLCache());

export const verifiedCache: TTLCache<RetailerListing[]> =
  g.__pdfVerifiedCache ?? (g.__pdfVerifiedCache = new TTLCache());
