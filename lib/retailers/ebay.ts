import type { ProductID } from "@/lib/types";
import {
  type RetailerAdapter,
  type RetailerListing,
  type SearchContext,
  fetchWithRetryOn429,
  scoreMatch,
} from "./types";
import { getEbayAppToken } from "./ebayAuth";
import { itemImageBase64 } from "@/lib/crop";
import { ServiceError } from "@/lib/errors";

const SERVICE = "eBay";
const BASE = "https://api.ebay.com/buy/browse/v1/item_summary";
const LIMIT = "20";
/** Buy It Now only: an auction's current bid isn't the price you'd pay. */
const FIXED_PRICE = "buyingOptions:{FIXED_PRICE}";
/** Fewer image matches than this → also run a text search (free; eBay's daily limit is generous). */
const MIN_IMAGE_RESULTS = 5;

type EbayItem = {
  title?: string;
  itemWebUrl?: string;
  image?: { imageUrl?: string };
  price?: { value?: string; currency?: string };
  condition?: string;
};

/**
 * Some eBay developer accounts aren't allowed to use search-by-image. Once
 * eBay refuses it, stop asking for the life of the process and search by text.
 */
let imageSearchRefused = false;

function headers(token: string, json = false): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
    ...(json ? { "Content-Type": "application/json" } : {}),
  };
}

/** `ranked`: results are ordered by visual similarity (image search), so position counts too. */
function normalize(product: ProductID, items: EbayItem[] | undefined, ranked = false): RetailerListing[] {
  return (items ?? [])
    .map((r, i): RetailerListing | null => {
      const price = Number(r.price?.value);
      if (!r.title || !r.itemWebUrl || !Number.isFinite(price) || price <= 0) return null;
      if (r.price?.currency && r.price.currency !== "USD") return null;
      return {
        retailer: "eBay",
        title: r.title,
        price,
        currency: "USD",
        url: r.itemWebUrl,
        imageUrl: r.image?.imageUrl,
        matchConfidence: ranked
          ? Math.round((0.5 * (1 - Math.min(i, 20) / 20) + 0.5 * scoreMatch(product, r.title)) * 100) / 100
          : scoreMatch(product, r.title),
        condition: r.condition && !/^new$/i.test(r.condition) ? r.condition : undefined,
      };
    })
    .filter((l): l is RetailerListing => l !== null);
}

function check(res: Response): void {
  if (res.status === 429) {
    throw new ServiceError(SERVICE, "rate_limit", "eBay's daily API call limit was hit. It resets daily.", 3600);
  }
  if (res.status === 401) {
    throw new ServiceError(SERVICE, "auth", "eBay rejected the request (credentials or API access).");
  }
  if (!res.ok) throw new ServiceError(SERVICE, "bad_response", `eBay search failed (HTTP ${res.status}).`);
}

async function searchByText(product: ProductID, token: string): Promise<RetailerListing[]> {
  const qs = new URLSearchParams({ q: product.searchQuery, limit: LIMIT, filter: FIXED_PRICE });
  const res = await fetchWithRetryOn429(`${BASE}/search?${qs}`, { headers: headers(token) }, 1000, SERVICE);
  check(res);
  const data = (await res.json()) as { itemSummaries?: EbayItem[] };
  return normalize(product, data.itemSummaries);
}

/** null = eBay won't do image search for this account (or the image couldn't be prepared). */
async function searchByImage(product: ProductID, token: string, ctx: SearchContext): Promise<RetailerListing[] | null> {
  if (imageSearchRefused || !ctx.imageUrl) return null;
  let image: string;
  try {
    image = await itemImageBase64(ctx.imageUrl, ctx.box);
  } catch {
    return null;
  }
  const qs = new URLSearchParams({ limit: LIMIT, filter: FIXED_PRICE });
  const res = await fetchWithRetryOn429(
    `${BASE}/search_by_image?${qs}`,
    { method: "POST", headers: headers(token, true), body: JSON.stringify({ image }) },
    1000,
    SERVICE,
  );
  if (res.status === 403 || res.status === 404) {
    imageSearchRefused = true; // not enabled for this app; text search from now on
    return null;
  }
  check(res);
  const data = (await res.json()) as { itemSummaries?: EbayItem[] };
  return normalize(product, data.itemSummaries, true);
}

/**
 * eBay Browse API (free; needs EBAY_APP_ID + EBAY_CERT_ID, exchanged for an
 * application token in ebayAuth.ts). Searches by a crop of the piece first,
 * like Google Lens, and tops up with a text search when that finds little.
 * Buy It Now listings only; used items carry their condition.
 */
export const ebayAdapter: RetailerAdapter = {
  name: "eBay",
  usesImage: true,

  isConfigured: () => !!process.env.EBAY_APP_ID && !!process.env.EBAY_CERT_ID,

  async search(product: ProductID, ctx: SearchContext = {}): Promise<RetailerListing[]> {
    let token: string | null;
    try {
      token = await getEbayAppToken();
    } catch {
      throw new ServiceError(SERVICE, "network", "Couldn't reach eBay to sign in.");
    }
    if (!token) {
      throw new ServiceError(SERVICE, "auth", "eBay rejected the app credentials (EBAY_APP_ID / EBAY_CERT_ID).");
    }

    const byImage = await searchByImage(product, token, ctx);
    if (byImage && byImage.length >= MIN_IMAGE_RESULTS) return byImage;
    const byText = await searchByText(product, token);
    if (!byImage?.length) return byText;
    const seen = new Set(byImage.map((l) => l.url));
    return [...byImage, ...byText.filter((l) => !seen.has(l.url))];
  },
};

/** For tests. */
export function _resetEbayImageSearch() {
  imageSearchRefused = false;
}
