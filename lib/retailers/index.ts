import type { RetailerAdapter } from "./types";
import { serpapiAdapter } from "./serpapi";
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
 * Google Lens (visual search by the pin photo) is the primary source; Google
 * Shopping text search is a fallback that only spends a second SerpApi search
 * when Lens finds too few priced products.
 */
export const adapters: RetailerAdapter[] = [
  googleLensAdapter,
  { ...serpapiAdapter, tier: "fallback" },
  ebayAdapter,
];

export type { RetailerAdapter } from "./types";
