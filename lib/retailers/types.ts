import type { DetectedItem, ProductID, RetailerListing } from "@/lib/types";
import { networkError } from "@/lib/errors";

export type { RetailerListing };

/** Extra input for adapters that search by image. */
export type SearchContext = {
  imageUrl?: string;
  /** Public URL of just this item cropped from the pin; image adapters prefer it. */
  cropUrl?: string;
  /** Where the item sits in the pin photo (0-1000), for adapters that crop it themselves. */
  box?: [number, number, number, number];
};

export interface RetailerAdapter {
  name: string;
  /** False when this adapter's API keys aren't set; the orchestrator skips it. */
  isConfigured(): boolean;
  /**
   * "fallback" adapters only run when the primary ones return too few priced
   * listings (saves paid searches). Default: "primary".
   */
  tier?: "primary" | "fallback";
  /** Searches by the pin image (results are cached per image, not just per query). */
  usesImage?: boolean;
  /**
   * Search this retailer. Resolves [] when the retailer genuinely has no
   * results; throws a ServiceError (quota / auth / rate_limit / timeout …)
   * when the search couldn't be done, so the UI can say why.
   */
  search(product: ProductID, ctx?: SearchContext): Promise<RetailerListing[]>;
}

export const ADAPTER_TIMEOUT_MS = 8000;

/** Wrap a fetch in a per-adapter timeout so one slow retailer can't stall the batch. */
export async function fetchWithTimeout(
  url: string,
  init?: RequestInit,
  timeoutMs: number = ADAPTER_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Retry a request once with backoff when the retailer returns 429. Network failures become ServiceErrors. */
export async function fetchWithRetryOn429(
  url: string,
  init?: RequestInit,
  backoffMs = 1000,
  service = "Retailer",
  timeoutMs = ADAPTER_TIMEOUT_MS,
): Promise<Response> {
  try {
    const first = await fetchWithTimeout(url, init, timeoutMs);
    if (first.status !== 429) return first;
    const retryAfter = Number(first.headers.get("retry-after"));
    const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoffMs;
    await new Promise((r) => setTimeout(r, Math.min(delay, 5000)));
    return await fetchWithTimeout(url, init, timeoutMs);
  } catch (err) {
    throw networkError(service, err);
  }
}

const STOPWORDS = new Set(["the", "a", "an", "for", "with", "and", "or", "of", "in", "men", "mens", "women", "womens", "unisex"]);

export function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/'s\b/g, "")
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 1 && !STOPWORDS.has(t)),
  );
}

/** Loose plural/singular match: "boots" ~ "boot", "jeans" ~ "jean". */
function hasToken(tokens: Set<string>, word: string): boolean {
  const w = word.toLowerCase();
  return tokens.has(w) || tokens.has(w.replace(/e?s$/, "")) || tokens.has(`${w}s`);
}

/** Does the listing title name the right kind of item at all? */
export function titleHasItemType(item: Pick<DetectedItem, "typeKeywords">, title: string): boolean {
  const tokens = tokenize(title);
  return item.typeKeywords.some((k) => hasToken(tokens, k));
}

/**
 * Cheap title-based pre-score (0-1), used to pick which listings go to the
 * visual check and as the fallback ranking when that check is unavailable.
 * Item type and color words matter most; generic token overlap fills in.
 */
export function scoreMatch(product: ProductID | DetectedItem, listingTitle: string): number {
  const listingTokens = tokenize(listingTitle);
  if (listingTokens.size === 0) return 0;

  const productTokens = tokenize([product.productName, ...product.attributes].join(" "));
  if (productTokens.size === 0) return 0;
  let hits = 0;
  for (const t of productTokens) if (hasToken(listingTokens, t)) hits++;
  let score = hits / productTokens.size;

  if ("typeKeywords" in product) {
    const typeHit = product.typeKeywords.some((k) => hasToken(listingTokens, k));
    const colorWords = product.colors.flatMap((c) => [...tokenize(c)]);
    const colorHit = colorWords.length === 0 || colorWords.some((c) => hasToken(listingTokens, c));
    const patternWords = product.pattern === "solid" ? [] : [...tokenize(product.pattern)];
    const patternHit = patternWords.length === 0 || patternWords.some((p) => hasToken(listingTokens, p));
    score = 0.35 * (typeHit ? 1 : 0) + 0.25 * (colorHit ? 1 : 0) + 0.1 * (patternHit ? 1 : 0) + 0.3 * score;
  }

  if (product.brand) {
    const brandHit = [...tokenize(product.brand)].some((t) => listingTokens.has(t));
    score = score * 0.8 + (brandHit ? 0.2 : 0);
  }
  return Math.max(0, Math.min(1, score));
}
