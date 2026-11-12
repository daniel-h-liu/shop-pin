import type { RetailerAdapter } from "./types";
import { googleLensAdapter } from "./googleLens";
import { ebayAdapter } from "./ebay";

// rainforestAdapter (Amazon, via Rainforest API) is intentionally excluded
// from the default registry: Rainforest has no free tier (unlike SerpApi's
// 250 free searches/month), so Amazon coverage for now comes indirectly
// through Google Shopping results, which already include Amazon listings by
// source. The adapter is kept in rainforest.ts and can be added back below
// if Amazon-specific data (Prime badge, exact price, review signals) turns
// out to be worth paying for.
// import { rainforestAdapter } from "./rainforest";

/**
 * Adapter registry — add new retailers here without touching orchestration code.
 * Google Lens (visual search by the item's photo) is the main source.
 *
 * Google Shopping text search (serpapiAdapter) is deliberately not listed:
 * searching by words alone surfaced pieces that merely sound similar, and it
 * cost a second SerpApi search. It can come back as a `tier: "fallback"`
 * adapter, which only runs when the primary ones find too few listings.
 */
export const adapters: RetailerAdapter[] = [googleLensAdapter, ebayAdapter];

export type { RetailerAdapter } from "./types";
