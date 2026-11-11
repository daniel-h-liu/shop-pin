import type { ProductID } from "@/lib/types";
import {
  type RetailerAdapter,
  type RetailerListing,
  fetchWithRetryOn429,
  scoreMatch,
} from "./types";
import { getEbayAppToken } from "./ebayAuth";
import { ServiceError } from "@/lib/errors";

const SERVICE = "eBay";

type EbayItem = {
  title?: string;
  itemWebUrl?: string;
  image?: { imageUrl?: string };
  price?: { value?: string; currency?: string };
};

// eBay Browse API requires an OAuth 2.0 client-credentials application
// token (see ebayAuth.ts) — EBAY_APP_ID and EBAY_CERT_ID together, not the
// App ID alone.
export const ebayAdapter: RetailerAdapter = {
  name: "eBay",

  isConfigured: () => !!process.env.EBAY_APP_ID && !!process.env.EBAY_CERT_ID,

  async search(product: ProductID): Promise<RetailerListing[]> {
    let token: string | null;
    try {
      token = await getEbayAppToken();
    } catch {
      throw new ServiceError(SERVICE, "network", "Couldn't reach eBay to sign in.");
    }
    if (!token) {
      throw new ServiceError(SERVICE, "auth", "eBay rejected the app credentials (EBAY_APP_ID / EBAY_CERT_ID).");
    }

    const qs = new URLSearchParams({
      q: product.searchQuery,
      limit: "20",
    });

    {
      const res = await fetchWithRetryOn429(
        `https://api.ebay.com/buy/browse/v1/item_summary/search?${qs}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
          },
        },
        1000,
        SERVICE,
      );
      if (res.status === 429) {
        throw new ServiceError(SERVICE, "rate_limit", "eBay's daily API call limit was hit. It resets daily.", 3600);
      }
      if (res.status === 401 || res.status === 403) {
        throw new ServiceError(SERVICE, "auth", "eBay rejected the request (credentials or API access).");
      }
      if (!res.ok) throw new ServiceError(SERVICE, "bad_response", `eBay search failed (HTTP ${res.status}).`);
      const data = (await res.json()) as { itemSummaries?: EbayItem[] };

      return (data.itemSummaries ?? [])
        .map((r): RetailerListing | null => {
          const price = Number(r.price?.value);
          if (!r.title || !r.itemWebUrl || !Number.isFinite(price) || price <= 0) {
            return null;
          }
          return {
            retailer: "eBay",
            title: r.title,
            price,
            currency: r.price?.currency || "USD",
            url: r.itemWebUrl,
            imageUrl: r.image?.imageUrl,
            matchConfidence: scoreMatch(product, r.title),
          };
        })
        .filter((l): l is RetailerListing => l !== null);
    }
  },
};
