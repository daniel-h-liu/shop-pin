import { describe, expect, it } from "vitest";
import { dedupeListings, rankListings } from "@/lib/pipeline/rank";
import type { RetailerListing } from "@/lib/types";

function listing(overrides: Partial<RetailerListing>): RetailerListing {
  return {
    retailer: "Google Shopping",
    title: "Nike Air Max 90 White",
    price: 100,
    currency: "USD",
    url: "https://example.com/a",
    matchConfidence: 0.8,
    ...overrides,
  };
}

describe("dedupeListings", () => {
  it("drops exact URL duplicates from the same retailer", () => {
    const out = dedupeListings([listing({}), listing({ matchConfidence: 0.9 })]);
    expect(out).toHaveLength(1);
  });

  it("drops near-duplicates (same retailer, normalized title, price) with different URLs", () => {
    const out = dedupeListings([
      listing({ url: "https://example.com/a", title: "Nike Air Max 90 - White!" }),
      listing({ url: "https://example.com/b", title: "White Nike Air Max 90" }),
    ]);
    expect(out).toHaveLength(1);
  });

  it("keeps same title from different retailers", () => {
    const out = dedupeListings([
      listing({ retailer: "Amazon" }),
      listing({ retailer: "eBay", url: "https://example.com/b" }),
    ]);
    expect(out).toHaveLength(2);
  });
});

describe("rankListings", () => {
  it("filters low-confidence matches, sorts by price asc, takes top 5", () => {
    const out = rankListings([
      listing({ url: "u1", price: 90 }),
      listing({ url: "u2", price: 50 }),
      listing({ url: "u3", price: 70 }),
      listing({ url: "u4", price: 60 }),
      listing({ url: "u5", price: 10, matchConfidence: 0.2 }), // below threshold
      listing({ url: "u6", price: 80 }),
      listing({ url: "u7", price: 95 }),
    ]);
    expect(out.map((l) => l.price)).toEqual([50, 60, 70, 80, 90]);
  });

  it("returns [] for empty input", () => {
    expect(rankListings([])).toEqual([]);
  });

  it("breaks price ties by higher confidence", () => {
    const out = rankListings([
      listing({ url: "u1", price: 50, matchConfidence: 0.5, title: "A thing" }),
      listing({ url: "u2", price: 50, matchConfidence: 0.9, title: "Other thing" }),
    ]);
    expect(out[0].matchConfidence).toBe(0.9);
  });
});
