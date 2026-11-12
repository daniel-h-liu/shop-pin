import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithRetryOn429, scoreMatch } from "@/lib/retailers/types";
import { serpapiAdapter } from "@/lib/retailers/serpapi";
import { googleLensAdapter } from "@/lib/retailers/googleLens";
import type { ProductID } from "@/lib/types";

const product: ProductID = {
  pinId: "p1",
  productName: "Nike Air Max 90",
  category: "sneakers",
  brand: "Nike",
  attributes: ["white", "leather"],
  searchQuery: "nike air max 90 white",
  confidence: "high",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("scoreMatch for detected items", () => {
  const item = {
    ...product,
    brand: undefined,
    productName: "Navy cable knit sweater",
    attributes: ["navy", "wool"],
    itemId: "p1#0",
    itemType: "cable knit sweater",
    typeKeywords: ["sweater", "pullover", "jumper"],
    colors: ["navy"],
    pattern: "cable knit",
    search: { status: "idle" as const, deals: [] },
  };
  it("rewards right type + color over generic overlap", () => {
    const good = scoreMatch(item, "Men's Navy Cable-Knit Wool Pullover");
    const wrongColor = scoreMatch(item, "Men's Red Cable-Knit Wool Pullover");
    const wrongType = scoreMatch(item, "Navy cable knit wool beanie");
    expect(good).toBeGreaterThan(wrongColor);
    expect(good).toBeGreaterThan(wrongType);
    expect(good).toBeGreaterThan(0.8);
  });
});

describe("scoreMatch", () => {
  it("scores strong title overlap high", () => {
    expect(scoreMatch(product, "Nike Air Max 90 White Leather")).toBeGreaterThan(0.7);
  });
  it("scores unrelated titles low", () => {
    expect(scoreMatch(product, "Ceramic flower vase blue")).toBeLessThan(0.3);
  });
});

describe("fetchWithRetryOn429", () => {
  it("retries once with backoff on 429, then succeeds", async () => {
    const responses = [
      new Response("rate limited", { status: 429, headers: { "retry-after": "0" } }),
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    ];
    const fetchMock = vi.fn(async () => responses.shift()!);
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetchWithRetryOn429("https://example.com", undefined, 10);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after one retry and reports a rate-limit error", async () => {
    const fetchMock = vi.fn(
      async () => new Response("rate limited", { status: 429, headers: { "retry-after": "0" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("SERPAPI_KEY", "test-key");

    await expect(serpapiAdapter.search(product)).rejects.toMatchObject({ kind: "rate_limit" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("serpapiAdapter", () => {
  it("reports itself unconfigured without a key", async () => {
    vi.stubEnv("SERPAPI_KEY", "");
    expect(serpapiAdapter.isConfigured()).toBe(false);
  });

  it("explains an exhausted monthly quota", async () => {
    vi.stubEnv("SERPAPI_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "Your account has run out of searches." }), { status: 429 })),
    );
    await expect(serpapiAdapter.search(product)).rejects.toMatchObject({
      kind: "quota",
      message: expect.stringContaining("monthly search allowance is used up"),
    });
  });

  it("treats Google's 'no results' as an empty result, not an error", async () => {
    vi.stubEnv("SERPAPI_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "Google hasn't returned any results for this query." }), { status: 200 })),
    );
    expect(await serpapiAdapter.search(product)).toEqual([]);
  });

  it("normalizes shopping results and drops entries without price/url", async () => {
    vi.stubEnv("SERPAPI_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            shopping_results: [
              {
                title: "Nike Air Max 90 White",
                extracted_price: 89.99,
                product_link: "https://store.example/nike",
                source: "FootLocker",
              },
              { title: "No price item", product_link: "https://x.example" },
            ],
          }),
          { status: 200 },
        ),
      ),
    );

    const listings = await serpapiAdapter.search(product);
    expect(listings).toHaveLength(1);
    expect(listings[0]).toMatchObject({
      retailer: "FootLocker",
      price: 89.99,
      currency: "USD",
    });
    expect(listings[0].matchConfidence).toBeGreaterThan(0.5);
  });

  it("reports network failures as a readable error", async () => {
    vi.stubEnv("SERPAPI_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network down");
    }));
    await expect(serpapiAdapter.search(product)).rejects.toMatchObject({ kind: "network" });
  });
});

describe("googleLensAdapter", () => {
  it("searches the whole pin with a text hint; keeps priced in-stock results plus unpriced possible originals", async () => {
    vi.stubEnv("SERPAPI_KEY", "k");
    let called = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        called = url;
        return new Response(
          JSON.stringify({
            visual_matches: [
              { position: 1, title: "Nike Air Max 90 White", link: "https://a.example/1", source: "Nike", thumbnail: "https://a.example/1.jpg", price: { extracted_value: 120, currency: "$" }, in_stock: true },
              { position: 2, title: "Air Max 90 street style photo", link: "https://b.example/2", source: "Blog" },
              { position: 3, title: "Nike Air Max 90 (sold out)", link: "https://c.example/3", price: { extracted_value: 90, currency: "$" }, in_stock: false },
              { position: 4, title: "Nike Air Max 90 EU", link: "https://d.example/4", price: { extracted_value: 100, currency: "€" } },
            ],
          }),
          { status: 200 },
        );
      }),
    );
    const out = await googleLensAdapter.search(product, { imageUrl: "https://i.pinimg.com/736x/x.jpg" });
    expect(called).toContain("engine=google_lens");
    expect(called).toContain("url=https%3A%2F%2Fi.pinimg.com");
    expect(called).toContain("q=nike+air+max+90+white");
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ retailer: "Nike", price: 120, imageUrl: "https://a.example/1.jpg" });
    expect(out[1]).toMatchObject({ retailer: "Blog", price: 0 });
  });

  it("searches a crop of the item by image alone, and never treats social sites as the original", async () => {
    vi.stubEnv("SERPAPI_KEY", "k");
    let called = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        called = url;
        return new Response(
          JSON.stringify({
            visual_matches: [
              { position: 1, title: "Pin of the shoe", link: "https://www.pinterest.com/pin/1", source: "Pinterest" },
              { position: 2, title: "Nike Air Max 90", link: "https://www.nike.com/t/air-max-90", source: "Nike" },
              { position: 30, title: "Far-down unpriced page", link: "https://z.example/30", source: "Z" },
            ],
          }),
          { status: 200 },
        );
      }),
    );
    const out = await googleLensAdapter.search(product, {
      imageUrl: "https://i.pinimg.com/736x/x.jpg",
      cropUrl: "https://shop.example/api/crop?src=x&box=1,2,3,4",
    });
    expect(called).toContain("url=https%3A%2F%2Fshop.example%2Fapi%2Fcrop");
    expect(called).not.toContain("q=");
    expect(out.map((l) => l.retailer)).toEqual(["Nike"]);
  });

  it("refuses non-public images (uploads) with a readable reason", async () => {
    vi.stubEnv("SERPAPI_KEY", "k");
    await expect(googleLensAdapter.search(product, { imageUrl: "data:image/png;base64,AAAA" })).rejects.toMatchObject({
      kind: "config",
    });
  });

  it("reports SerpApi quota exhaustion", async () => {
    vi.stubEnv("SERPAPI_KEY", "k");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Your account has run out of searches." }), { status: 429 })));
    await expect(googleLensAdapter.search(product, { imageUrl: "https://x.example/a.jpg" })).rejects.toMatchObject({ kind: "quota" });
  });
});
