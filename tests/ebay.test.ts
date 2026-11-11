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
