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

/** Sites that repost photos rather than sell things: never "the original". */
const NOT_SELLERS =
  /(^|\.)(pinterest|instagram|facebook|tiktok|twitter|x|youtube|reddit|tumblr|threads|weheartit|lemon8-app|pinimg)\.[a-z.]+$/i;
/**
 * Resale marketplaces: everything sold there is secondhand. (eBay sells new
 * and used, so it's left out; its own adapter reports each item's condition.)
 */
const RESALE =
  /(^|\.)(poshmark|depop|mercari|vinted|thredup|therealreal|grailed|vestiairecollective|fashionphile|rebag|tradesy|curtsyapp|kidizen|swap)\.[a-z.]+$/i;

export function isResaleHost(host: string): boolean {
  return RESALE.test(host);
}

/** Unpriced matches this high in Lens's ranking may be the exact product's page. */
const ORIGINAL_MAX_POSITION = 12;
const MAX_UNPRICED = 4;

function hostOf(link: string): string {
  try {
    return new URL(link).hostname;
  } catch {
    return "";
  }
}

/**
 * Google Lens via SerpApi (1 search per call).
 *
 * With a crop of just this item (ctx.cropUrl) it searches purely by image,
 * like drawing a box in Lens. Without one it searches the whole pin photo
 * with the item's description as a text hint, which is less precise.
 *
 * Returns priced, in-stock products, plus a few top unpriced matches from
 * non-social sites (price 0): Lens often finds the exact product on a page
 * that doesn't show a price, and the visual check decides if it's the one.
 */
export const googleLensAdapter: RetailerAdapter = {
  name: "Google Lens",
  usesImage: true,

  isConfigured: () => !!process.env.SERPAPI_KEY,

  async search(product: ProductID, ctx?: SearchContext): Promise<RetailerListing[]> {
    const key = process.env.SERPAPI_KEY;
    if (!key) throw new ServiceError(SERVICE, "auth", "SERPAPI_KEY isn't set.");
    const imageUrl = ctx?.cropUrl ?? ctx?.imageUrl;
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
      type: "all",
      country: "us",
      hl: "en",
      api_key: key,
    });
    // A text hint only helps when Lens sees the whole outfit; with a crop it
    // pulls results toward things that merely sound similar.
    if (!ctx?.cropUrl) qs.set("q", product.searchQuery);
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
    let unpriced = 0;
    return matches
      .map((m, i): RetailerListing | null => {
        if (!m.title || !m.link) return null;
        const position = m.position ?? i + 1;
        // Lens orders results by visual similarity; blend that with the title match.
        const rank = 1 - Math.min(position, 60) / 60;
        const price = m.price?.extracted_value;
        const listing = (p: number): RetailerListing => ({
          retailer: m.source || hostOf(m.link!) || "Google Lens",
          title: m.title!,
          price: p,
          currency: "USD",
          url: m.link!,
          imageUrl: m.thumbnail ?? m.image,
          matchConfidence: Math.round((0.5 * rank + 0.5 * scoreMatch(product, m.title!)) * 100) / 100,
          condition: isResaleHost(hostOf(m.link!)) ? "Secondhand" : undefined,
        });
        if (!price || price <= 0) {
          // Possibly the exact product on a page without a price.
          if (position > ORIGINAL_MAX_POSITION || unpriced >= MAX_UNPRICED) return null;
          if (NOT_SELLERS.test(hostOf(m.link))) return null;
          unpriced++;
          return listing(0);
        }
        if (m.price?.currency && m.price.currency !== "$") return null;
        if (m.in_stock === false) return null;
        return listing(price);
      })
      .filter((l): l is RetailerListing => l !== null);
  },
};
