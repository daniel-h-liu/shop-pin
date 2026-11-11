import type { ProductID } from "@/lib/types";
import { ServiceError } from "@/lib/errors";
import {
  type RetailerAdapter,
  type RetailerListing,
  fetchWithRetryOn429,
  scoreMatch,
} from "./types";

const SERVICE = "SerpApi (Google Shopping)";
// SerpApi scrapes Google live; Shopping searches regularly take 8-20s.
const SERPAPI_TIMEOUT_MS = 25_000;

type SerpShoppingResult = {
  title?: string;
  extracted_price?: number;
  price?: string;
  link?: string;
  product_link?: string;
  thumbnail?: string;
  serpapi_thumbnail?: string;
  source?: string;
};

/** SerpApi reports problems as {"error": "..."}; turn them into readable ServiceErrors. */
export function classifySerpApiError(status: number, error: string | undefined): ServiceError | null {
  const e = error ?? "";
  if (/run out of searches|plan.*searches|searches.*(left|limit)/i.test(e)) {
    return new ServiceError(
      SERVICE,
      "quota",
      "SerpApi's monthly search allowance is used up (free plan: 250/month). It renews on your plan's renewal date; see serpapi.com/dashboard.",
    );
  }
  if (/hourly|per hour|throughput/i.test(e)) {
    return new ServiceError(SERVICE, "rate_limit", "SerpApi's hourly search limit was hit. Try again later this hour.", 600);
  }
  if (status === 401 || /invalid api key/i.test(e)) {
    return new ServiceError(SERVICE, "auth", "SerpApi rejected the API key (SERPAPI_KEY).");
  }
  if (status === 429) {
    return new ServiceError(SERVICE, "rate_limit", "SerpApi is rate-limiting requests. Try again in a minute.", 60);
  }
  if (status >= 400) {
    return new ServiceError(SERVICE, "bad_response", `SerpApi search failed (HTTP ${status}${e ? `: ${e.slice(0, 120)}` : ""}).`);
  }
  return null;
}

/** Google Shopping via SerpApi — broadest coverage, good default. */
export const serpapiAdapter: RetailerAdapter = {
  name: "Google Shopping",

  isConfigured: () => !!process.env.SERPAPI_KEY,

  async search(product: ProductID): Promise<RetailerListing[]> {
    const key = process.env.SERPAPI_KEY;
    if (!key) throw new ServiceError(SERVICE, "auth", "SERPAPI_KEY isn't set.");

    const qs = new URLSearchParams({
      engine: "google_shopping",
      q: product.searchQuery,
      api_key: key,
      gl: "us",
      hl: "en",
    });

    const res = await fetchWithRetryOn429(
      `https://serpapi.com/search.json?${qs}`,
      undefined,
      1000,
      SERVICE,
      SERPAPI_TIMEOUT_MS,
    );
    let data: { shopping_results?: SerpShoppingResult[]; error?: string };
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
    // "Google hasn't returned any results for this query." comes back as a 200 + error: a genuine empty result.

    return (data.shopping_results ?? [])
      .map((r): RetailerListing | null => {
        const price = r.extracted_price ?? Number(String(r.price ?? "").replace(/[^0-9.]/g, ""));
        const url = r.product_link ?? r.link;
        if (!r.title || !url || !Number.isFinite(price) || price <= 0) return null;
        return {
          retailer: r.source || "Google Shopping",
          title: r.title,
          price,
          currency: "USD",
          url,
          imageUrl: r.serpapi_thumbnail ?? r.thumbnail,
          matchConfidence: scoreMatch(product, r.title),
        };
      })
      .filter((l): l is RetailerListing => l !== null);
  },
};
