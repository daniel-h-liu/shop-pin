import type { ProductID } from "@/lib/types";
import { ServiceError } from "@/lib/errors";
import { classifySerpApiError } from "./serpapi";
import {
  type RetailerAdapter,
  type RetailerListing,
  type SearchContext,
  fetchWithRetryOn429,
  scoreMatch,
} from "./types";

const SERVICE = "SerpApi (Google Lens)";
const LENS_TIMEOUT_MS = 30_000;

type LensMatch = {
  position?: number;
  title?: string;
  link?: string;
  source?: string;
  thumbnail?: string;
  image?: string;
  in_stock?: boolean;
  price?: { value?: string; extracted_value?: number; currency?: string };
};

/** Google Lens URL a person can open to see the same visual search. */
export function lensUrl(imageUrl: string): string {
  return `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(imageUrl)}`;
}

/**
 * Google Lens via SerpApi: searches by the pin photo itself, with the item's
 * description as a text hint ("men's brown zip jacket") so Lens focuses on
 * that one item in an outfit photo. Uses the same SerpApi allowance as
 * Google Shopping (1 search per call).
 */
export const googleLensAdapter: RetailerAdapter = {
  name: "Google Lens",
  usesImage: true,

  isConfigured: () => !!process.env.SERPAPI_KEY,

  async search(product: ProductID, ctx?: SearchContext): Promise<RetailerListing[]> {
    const key = process.env.SERPAPI_KEY;
    if (!key) throw new ServiceError(SERVICE, "auth", "SERPAPI_KEY isn't set.");
    const imageUrl = ctx?.imageUrl;
    if (!imageUrl || !/^https?:\/\//i.test(imageUrl)) {
      throw new ServiceError(
        SERVICE,
        "config",
        "Google Lens needs a public image URL; uploaded files can't be searched visually, so text search was used instead.",
      );
    }

    const qs = new URLSearchParams({
      engine: "google_lens",
      url: imageUrl,
      q: product.searchQuery,
      type: "all",
      country: "us",
      hl: "en",
      api_key: key,
    });
    const res = await fetchWithRetryOn429(`https://serpapi.com/search.json?${qs}`, undefined, 1000, SERVICE, LENS_TIMEOUT_MS);
    let data: { visual_matches?: LensMatch[]; error?: string };
    try {
      data = await res.json();
    } catch {
      throw (
        classifySerpApiError(res.status, undefined) ??
        new ServiceError(SERVICE, "bad_response", `SerpApi returned an unreadable response (HTTP ${res.status}).`)
      );
    }
    const err = classifySerpApiError(res.status, data.error);
    if (err) throw err;

    const matches = data.visual_matches ?? [];
    return matches
      .map((m, i): RetailerListing | null => {
        const price = m.price?.extracted_value;
        // Only shoppable results: a price in dollars and not marked out of stock.
        if (!m.title || !m.link || !price || price <= 0) return null;
        if (m.price?.currency && m.price.currency !== "$") return null;
        if (m.in_stock === false) return null;
        // Lens orders results by visual similarity; blend that with the title match.
        const rank = 1 - Math.min(m.position ?? i + 1, 60) / 60;
        return {
          retailer: m.source || "Google Lens",
          title: m.title,
          price,
          currency: "USD",
          url: m.link,
          imageUrl: m.thumbnail ?? m.image,
          matchConfidence: Math.round((0.5 * rank + 0.5 * scoreMatch(product, m.title)) * 100) / 100,
        };
      })
      .filter((l): l is RetailerListing => l !== null);
  },
};
