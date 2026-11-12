import type { DetectedItem, RetailerListing } from "@/lib/types";
import { titleHasItemType } from "@/lib/retailers/types";

export const MIN_MATCH_CONFIDENCE = 0.4;
export const TOP_N = 5;

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(" ");
}

/**
 * Drop duplicate / near-duplicate listings: same retailer + same URL, or same
 * retailer + same normalized title at the same price. Keeps the first
 * occurrence (callers sort by price first, so the cheapest survives).
 */
export function dedupeListings(listings: RetailerListing[]): RetailerListing[] {
  const seen = new Set<string>();
  const out: RetailerListing[] = [];
  for (const l of listings) {
    const urlKey = `${l.retailer}::${l.url}`;
    const titleKey = `${l.retailer}::${normalizeTitle(l.title)}::${l.price.toFixed(2)}`;
    if (seen.has(urlKey) || seen.has(titleKey)) continue;
    seen.add(urlKey);
    seen.add(titleKey);
    out.push(l);
  }
  return out;
}

/**
 * Rank one pin's listings: filter to plausible matches, sort by price asc
 * (ties broken by higher confidence), dedupe, take the top N.
 */
export function rankListings(
  listings: RetailerListing[],
  {
    minConfidence = MIN_MATCH_CONFIDENCE,
    topN = TOP_N,
  }: { minConfidence?: number; topN?: number } = {},
): RetailerListing[] {
  const sorted = listings
    .filter((l) => l.matchConfidence > minConfidence && l.price > 0)
    .sort(
      (a, b) => a.price - b.price || b.matchConfidence - a.matchConfidence,
    );
  return dedupeListings(sorted).slice(0, topN);
}

/** Unpriced listings (possible exact-product pages) given a visual check slot. */
export const MAX_UNPRICED_CANDIDATES = 3;

/**
 * Choose which listings get the visual check: a few top unpriced matches
 * (Lens often finds the exact product on a page without a price), then
 * priced ones, right item type in the title first, best score first,
 * deduped, at most `max`.
 */
export function pickCandidates(
  item: DetectedItem,
  listings: RetailerListing[],
  max: number,
): RetailerListing[] {
  const usable = dedupeListings(listings.filter((l) => l.imageUrl));
  const byScore = (a: RetailerListing, b: RetailerListing) => b.matchConfidence - a.matchConfidence;
  const unpriced = usable.filter((l) => l.price <= 0).sort(byScore).slice(0, Math.min(MAX_UNPRICED_CANDIDATES, max));
  const priced = usable.filter((l) => l.price > 0);
  const typed = priced.filter((l) => titleHasItemType(item, l.title));
  const pool = typed.length >= Math.min(4, max) ? typed : priced;
  return [...unpriced, ...[...pool].sort(byScore)].slice(0, max);
}

/**
 * Split visually checked listings into the original (the best listing judged
 * to be the exact product, at any price, priced ones preferred) and the
 * look-alikes: cheapest first, and only cheaper than the original when it
 * has a price. Other listings of the exact product stay among the deals.
 */
export function splitOriginal(
  passed: RetailerListing[],
  topN = TOP_N,
): { original?: RetailerListing; deals: RetailerListing[] } {
  const original = passed
    .filter((l) => l.exact)
    .sort((a, b) => b.matchConfidence - a.matchConfidence || Number(b.price > 0) - Number(a.price > 0))[0];
  const rest = passed.filter((l) => l !== original && l.url !== original?.url);
  const cheaper = original && original.price > 0 ? rest.filter((l) => l.price < original.price) : rest;
  return { original, deals: rankListings(cheaper, { minConfidence: 0, topN }) };
}

/** Fallback when the visual check is unavailable: right item type + title score, then price. */
export function rankByText(item: DetectedItem, listings: RetailerListing[], topN = TOP_N): RetailerListing[] {
  return rankListings(
    listings.filter((l) => titleHasItemType(item, l.title)),
    { minConfidence: 0.55, topN },
  );
}
