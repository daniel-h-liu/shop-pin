import { afterEach, describe, expect, it, vi } from "vitest";
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

// getEbayAppToken caches its token at module scope; reset the module between
// tests (via a fresh dynamic import) so each test starts from a clean cache
// instead of inheriting state left over by an earlier test.
async function freshEbayAuth() {
  vi.resetModules();
  return import("@/lib/retailers/ebayAuth");
}
async function freshEbayAdapter() {
  vi.resetModules();
  return import("@/lib/retailers/ebay");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("getEbayAppToken", () => {
  it("returns null when EBAY_APP_ID or EBAY_CERT_ID is missing", async () => {
    vi.stubEnv("EBAY_APP_ID", "");
    vi.stubEnv("EBAY_CERT_ID", "");
    const { getEbayAppToken } = await freshEbayAuth();
    expect(await getEbayAppToken()).toBeNull();
  });

  it("exchanges App ID + Cert ID for a bearer token via client-credentials grant", async () => {
    vi.stubEnv("EBAY_APP_ID", "app-id");
    vi.stubEnv("EBAY_CERT_ID", "cert-id");
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://api.ebay.com/identity/v1/oauth2/token");
      expect(init?.method).toBe("POST");
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe(
        `Basic ${Buffer.from("app-id:cert-id").toString("base64")}`,
      );
      expect(String(init?.body)).toContain("grant_type=client_credentials");
      return new Response(
        JSON.stringify({ access_token: "app-token-123", expires_in: 7200 }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const { getEbayAppToken } = await freshEbayAuth();
    expect(await getEbayAppToken()).toBe("app-token-123");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("caches the token instead of re-requesting on every call", async () => {
    vi.stubEnv("EBAY_APP_ID", "app-id");
    vi.stubEnv("EBAY_CERT_ID", "cert-id");
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ access_token: "cached-token", expires_in: 7200 }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { getEbayAppToken } = await freshEbayAuth();
    await getEbayAppToken();
    await getEbayAppToken();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns null when the token endpoint rejects the credentials", async () => {
    vi.stubEnv("EBAY_APP_ID", "app-id");
    vi.stubEnv("EBAY_CERT_ID", "wrong-cert");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("invalid_client", { status: 401 })),
    );

    const { getEbayAppToken } = await freshEbayAuth();
    expect(await getEbayAppToken()).toBeNull();
  });
});

describe("ebayAdapter", () => {
  it("reports itself unconfigured without both keys", async () => {
    vi.stubEnv("EBAY_APP_ID", "app-id");
    vi.stubEnv("EBAY_CERT_ID", "");
    const { ebayAdapter } = await freshEbayAdapter();
    expect(ebayAdapter.isConfigured()).toBe(false);
  });

  it("fetches a token then normalizes item summaries", async () => {
    vi.stubEnv("EBAY_APP_ID", "app-id");
    vi.stubEnv("EBAY_CERT_ID", "cert-id");
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("oauth2/token")) {
        return new Response(
          JSON.stringify({ access_token: "app-token-123", expires_in: 7200 }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          itemSummaries: [
            {
              title: "Nike Air Max 90 White",
              itemWebUrl: "https://ebay.example/item/1",
              price: { value: "79.99", currency: "USD" },
              image: { imageUrl: "https://ebay.example/img/1.jpg" },
            },
            { title: "No price item", itemWebUrl: "https://ebay.example/item/2" },
          ],
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const { ebayAdapter } = await freshEbayAdapter();
    const listings = await ebayAdapter.search(product);
    expect(listings).toHaveLength(1);
    expect(listings[0]).toMatchObject({ retailer: "eBay", price: 79.99, currency: "USD" });
  });

  it("reports rejected credentials when the token exchange fails", async () => {
    vi.stubEnv("EBAY_APP_ID", "app-id");
    vi.stubEnv("EBAY_CERT_ID", "wrong-cert");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("invalid_client", { status: 401 })),
    );

    const { ebayAdapter } = await freshEbayAdapter();
    await expect(ebayAdapter.search(product)).rejects.toMatchObject({ kind: "auth" });
  });
});

describe("ebayAdapter image search", () => {
  const PIN = "https://i.pinimg.com/736x/x.jpg";
  const item = (n: number, extra: Record<string, unknown> = {}) => ({
    title: `Nike Air Max 90 White ${n}`,
    itemWebUrl: `https://ebay.example/item/${n}`,
    price: { value: String(50 + n), currency: "USD" },
    image: { imageUrl: `https://ebay.example/img/${n}.jpg` },
    ...extra,
  });

  async function setup(onApi: (url: string, init?: RequestInit) => Response) {
    vi.stubEnv("EBAY_APP_ID", "app-id");
    vi.stubEnv("EBAY_CERT_ID", "cert-id");
    const sharp = (await import("sharp")).default;
    const jpeg = await sharp({ create: { width: 200, height: 300, channels: 3, background: "#7a1f2b" } }).jpeg().toBuffer();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("oauth2/token")) return new Response(JSON.stringify({ access_token: "t", expires_in: 7200 }));
        if (url === PIN) return new Response(new Uint8Array(jpeg), { headers: { "content-type": "image/jpeg" } });
        calls.push({ url, init });
        return onApi(url, init);
      }),
    );
    const mod = await freshEbayAdapter();
    return { ...mod, calls };
  }

  it("searches by a crop of the piece, Buy It Now only, and keeps the condition of used items", async () => {
    const { ebayAdapter, calls } = await setup((url) =>
      url.includes("search_by_image")
        ? new Response(JSON.stringify({ itemSummaries: [1, 2, 3, 4, 5].map((n) => item(n, n === 1 ? { condition: "Pre-owned" } : { condition: "New" })) }))
        : new Response("unexpected", { status: 500 }),
    );
    const out = await ebayAdapter.search(product, { imageUrl: PIN, box: [100, 100, 600, 600] });
    expect(calls).toHaveLength(1); // enough image matches: no text search
    expect(calls[0].url).toContain("search_by_image");
    expect(decodeURIComponent(calls[0].url)).toContain("buyingOptions:{FIXED_PRICE}");
    expect(JSON.parse(String(calls[0].init?.body)).image).toMatch(/^\/9j\//); // base64 JPEG
    expect(out).toHaveLength(5);
    expect(out[0].condition).toBe("Pre-owned");
    expect(out[1].condition).toBeUndefined(); // "New" isn't worth a label
    expect(out[0].matchConfidence).toBeGreaterThan(out[4].matchConfidence); // visual order counts
  });

  it("tops up thin image results with a text search", async () => {
    const { ebayAdapter, calls } = await setup((url) =>
      url.includes("search_by_image")
        ? new Response(JSON.stringify({ itemSummaries: [item(1)] }))
        : new Response(JSON.stringify({ itemSummaries: [item(1), item(7)] })),
    );
    const out = await ebayAdapter.search(product, { imageUrl: PIN });
    expect(calls.map((c) => (c.url.includes("search_by_image") ? "image" : "text"))).toEqual(["image", "text"]);
    expect(out.map((l) => l.url)).toEqual(["https://ebay.example/item/1", "https://ebay.example/item/7"]);
  });

  it("falls back to text search when eBay refuses image search, and stops asking", async () => {
    const { ebayAdapter, calls } = await setup((url) =>
      url.includes("search_by_image")
        ? new Response("Insufficient permissions", { status: 403 })
        : new Response(JSON.stringify({ itemSummaries: [item(2)] })),
    );
    expect(await ebayAdapter.search(product, { imageUrl: PIN })).toHaveLength(1);
    expect(await ebayAdapter.search(product, { imageUrl: PIN })).toHaveLength(1);
    expect(calls.filter((c) => c.url.includes("search_by_image"))).toHaveLength(1);
  });
});
