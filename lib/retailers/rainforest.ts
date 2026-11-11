import type { ProductID } from "@/lib/types";
import {
  type RetailerAdapter,
  type RetailerListing,
  fetchWithRetryOn429,
  scoreMatch,
} from "./types";
import { ServiceError } from "@/lib/errors";

const SERVICE = "Rainforest (Amazon)";

type RainforestResult = {
  title?: string;
  link?: string;
  image?: string;
  price?: { value?: number; currency?: string };
};

/** Amazon results via Rainforest API. Optional — returns [] when unconfigured. */
export const rainforestAdapter: RetailerAdapter = {
  name: "Amazon",

  isConfigured: () => !!process.env.RAINFOREST_API_KEY,

  async search(product: ProductID): Promise<RetailerListing[]> {
    const key = process.env.RAINFOREST_API_KEY;
    if (!key) throw new ServiceError(SERVICE, "auth", "RAINFOREST_API_KEY isn't set.");

    const qs = new URLSearchParams({
      api_key: key,
      type: "search",
      amazon_domain: "amazon.com",
      search_term: product.searchQuery,
    });

    {
      const res = await fetchWithRetryOn429(
        `https://api.rainforestapi.com/request?${qs}`,
        undefined,
        1000,
        SERVICE,
      );
      if (res.status === 401) throw new ServiceError(SERVICE, "auth", "Rainforest rejected the API key.");
      if (res.status === 402 || res.status === 429) {
        throw new ServiceError(SERVICE, "quota", "Rainforest credits are used up or rate-limited.");
      }
      if (!res.ok) throw new ServiceError(SERVICE, "bad_response", `Rainforest search failed (HTTP ${res.status}).`);
      const data = (await res.json()) as {
        search_results?: RainforestResult[];
      };

      return (data.search_results ?? [])
        .map((r): RetailerListing | null => {
          const price = r.price?.value;
          if (!r.title || !r.link || !price || price <= 0) return null;
          return {
            retailer: "Amazon",
            title: r.title,
            price,
            currency: r.price?.currency || "USD",
            url: r.link,
            imageUrl: r.image,
            matchConfidence: scoreMatch(product, r.title),
          };
        })
        .filter((l): l is RetailerListing => l !== null);
    }
  },
};
