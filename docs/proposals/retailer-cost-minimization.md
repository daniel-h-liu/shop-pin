# Proposal: Cost-Minimize the Retailer Search Layer (SerpApi, Rainforest, eBay)

**Status:** Draft for review
**Date:** 2026-07-11
**Scope:** `lib/retailers/` only — no changes to vision, orchestration, ranking, or the frontend.
**Follow-up to:** `gemini-vision-migration.md` (§5 flagged this as a natural next target)

---

## 1. Summary

The retailer layer is a clean, already-extensible design: `RetailerAdapter { name, search(product) }`, registered in `lib/retailers/index.ts`, each adapter reading its own env key and returning `[]` — never throwing — when unconfigured. That design is exactly what makes cost-minimization easy here: **every recommendation below is a file-level swap or an env-var change, not a pipeline change.**

Of the three configured adapters, they land in three very different cost buckets:

| Adapter | Cost reality |
|---|---|
| **eBay Browse** | Genuinely free at hobby volume — but the current token handling is likely broken (see §4) |
| **SerpApi** (Google Shopping) | Free up to 250 searches/month, then paid — usable as-is for solo volume |
| **Rainforest** (Amazon) | **No free tier at all** — cheapest plan is $23/month starting from request #1 |

**Recommendation:** fix eBay's auth (it's free — it should be doing more work), keep SerpApi on its free tier as the default, and drop Rainforest's always-on paid dependency in favor of getting Amazon coverage indirectly through Google Shopping results, which already include Amazon listings by source.

---

## 2. Current Retailer Layer

```
lib/retailers/
  types.ts     — RetailerAdapter interface, fetchWithTimeout, fetchWithRetryOn429, scoreMatch
  serpapi.ts   — Google Shopping, keyed on SERPAPI_KEY
  rainforest.ts— Amazon, keyed on RAINFOREST_API_KEY
  ebay.ts      — eBay Browse, keyed on EBAY_APP_ID
  index.ts     — adapters: RetailerAdapter[] = [serpapiAdapter, rainforestAdapter, ebayAdapter]
```

`runPipeline` fans a search out to **every** adapter in the array concurrently via `Promise.allSettled` (`orchestrator.ts:56-64`), and results are cached per `${adapterName}::${searchQuery}` (`lib/pipeline/cache.ts`) — so re-running the same board, or two pins that resolve to the same search query, only spends once. That caching already blunts a meaningful chunk of the cost problem before any provider swap.

---

## 3. SerpApi (Google Shopping)

| Plan | Monthly cost | Searches | $/search |
|---|---:|---:|---:|
| **Free** | $0 | 250/month | $0 |
| Starter | $25 | 1,000 | $0.025 |
| Developer | $75 | 5,000 | $0.015 |
| Production | $150 | 15,000 | $0.010 |
| Big Data | $275 | 30,000 | $0.0092 |

*(Fetched live from `serpapi.com/pricing`, 2026-07-11.)*

SerpApi is the broadest-coverage adapter — Google Shopping aggregates listings across many retailers in one call, which is why it's a good default. At solo/hobby volume the **free 250 searches/month tier likely covers this project outright**, especially combined with the existing per-query cache. A rough sanity check: ~10 board runs/month at ~25 unique post-cache searches/run is ~250/month — right at the free-tier edge. If usage runs a bit hotter than that (more boards, less cache reuse, testing/iteration), it tips into the $25/month tier.

### Alternative: Serper.dev

If the free tier gets tight, **Serper.dev** is a drop-in-shaped alternative — same job (Google-powered shopping search-as-a-service), same integration shape (one HTTP call, JSON response, map to `RetailerListing`).

- Confirmed: dedicated **Shopping** endpoint returning title, price, retailer/source, and a purchase link — the same fields `serpapi.ts` already maps.
- Confirmed free allotment: **2,500 free queries, no credit card** — but this reads as a one-time signup credit, not a recurring monthly allowance like SerpApi's 250/month. Good for an initial burst (e.g. bulk-testing many boards during development) but not something to plan ongoing usage around without checking their current terms at signup.
- Paid pricing wasn't published on the pages I could reach — verify at signup before committing, but it's commonly cited in the market as cheaper per-query than SerpApi at volume. Confirm the actual number before treating it as the deciding factor.

**Recommendation:** don't switch preemptively. Keep SerpApi as the default (free tier is real and recurring), and hold Serper.dev in reserve as a second adapter to add if the free tier is consistently exceeded — see §6 for how cheaply that slots into the existing adapter array.

### Not recommended: scraping Google Shopping directly

Skipping both paid services and scraping `google.com/shopping` directly would be free, but it's a ToS violation, fragile (CAPTCHAs, markup churn, IP blocking), and would need a whole proxy/headless-browser subsystem to be reliable — the opposite of this project's "make shopping incredibly easy" goal, and a poor trade against $0–25/month.

---

## 4. eBay Browse API — already free, but likely not working correctly

eBay's Browse API is free within generous rate limits for the default application tier, and requires no per-search cost at any volume relevant here. That makes it the best adapter in the stack economically — which makes it worth getting right.

**The current implementation has a gap.** `ebay.ts:24` reads `EBAY_APP_ID` and sends it directly as a bearer token:

```typescript
const token = process.env.EBAY_APP_ID;
// ...
headers: { Authorization: `Bearer ${token}` }
```

eBay's Browse API requires an **OAuth 2.0 client-credentials application token**, not the raw App ID. The real flow is: exchange an App ID *and* Cert ID (client secret) for a short-lived access token (~2 hours) via `POST https://api.ebay.com/identity/v1/oauth2/token` with `grant_type=client_credentials` and scope `https://api.ebay.com/oauth/api_scope`, then use *that* token as the bearer and refresh it before it expires. The code comment already flags this as a known v1 shortcut ("a production build should exchange client credentials for an OAuth app token and refresh it") — so this isn't a surprise, just a gap worth closing given eBay is the free option you want leaning on hardest.

**Fix shape**, staying inside the existing pattern (a module-level cached client is already the pattern used in `lib/vision/identifyProduct.ts:35-39`):

```typescript
// lib/retailers/ebayAuth.ts
let cachedToken: { value: string; expiresAt: number } | null = null;

async function getAppToken(): Promise<string | null> {
  const appId = process.env.EBAY_APP_ID;
  const certId = process.env.EBAY_CERT_ID;
  if (!appId || !certId) return null;

  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.value;
  }

  const res = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${appId}:${certId}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope",
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cachedToken.value;
}
```

Then `ebay.ts` calls `getAppToken()` instead of reading `EBAY_APP_ID` directly. This needs a second env var, `EBAY_CERT_ID` (the client secret from the eBay Developer Portal, alongside the existing App ID) — update the README's key table accordingly. Zero cost impact; this is strictly "make the free adapter actually work reliably," which indirectly *is* a cost-minimization move, since every successful eBay result is one that doesn't need to come from a paid adapter.

---

## 5. Rainforest (Amazon)

| Plan | Monthly cost | Credits | $/request |
|---|---:|---:|---:|
| Hobbyist | $23 | 500 | $0.0460 |
| Starter | $83 | 10,000 | $0.0083 |
| Production | $375 | 250,000 | $0.0015 |

*(Fetched live from `trajectdata.com/pricing/rainforest-api`, 2026-07-11 — Rainforest is sold under the Traject Data brand.)*

Unlike SerpApi, **there is no ongoing free tier** — only a time-limited free trial. Every request after the trial costs money starting from the very first one, and the entry-level Hobbyist plan is the most expensive per-request tier of the three ($0.046/request), because it's priced for low commitment rather than low cost. At the same ~250 searches/month estimate used for SerpApi above, Rainforest alone would run **~$23/month minimum** — the single biggest line item in the whole retailer stack, for the retailer with the narrowest coverage (Amazon only).

### Alternative: Amazon Product Advertising API (PA-API) — free, but gated

Amazon's own PA-API has no per-request charge, but access requires an active **Amazon Associates** (affiliate) account, and — this is the part that matters for a solo project — **access is revoked if the account doesn't generate qualifying sales within a rolling window** (historically 3 qualifying sales in 180 days; confirm the current threshold on the Associates Program page, as Amazon adjusts these terms). For a personal deal-finder that isn't itself an affiliate storefront driving purchases, that's a real barrier, not a formality — it's realistic to lose API access a few months in. Only worth pursuing if there's already an active, qualifying Associates account.

### Recommended: drop the always-on Amazon adapter

Because `runPipeline` fans out to every configured adapter and Google Shopping results already surface Amazon listings under `source: "Amazon"` in a meaningful share of searches, **the cheapest move is simply not setting `RAINFOREST_API_KEY`.** The adapter's existing `if (!key) return [];` guard (`rainforest.ts:22`) means this requires **zero code changes** — it's a deployment/config decision, not a migration. You lose Amazon-specific structured data (Prime badge, exact current price, verified-purchase signals) and any Amazon listings SerpApi's crawl happens to miss, but you keep eBay + Google Shopping (which itself aggregates dozens of retailers, Amazon included) at no incremental cost.

If Amazon coverage turns out to matter enough to pay for, the fallback isn't all-or-nothing: Rainforest can be re-enabled **only for high-value pins** (e.g. only call it when SerpApi/eBay turn up zero results, or only for pins above some price threshold worth double-checking) rather than for every single product — a targeted-gating change inside `rainforest.ts` rather than a full removal, if partial Amazon coverage is wanted without the full per-search cost.

---

## 6. Recommended Target Stack

| Adapter | Action | Monthly cost at hobby volume |
|---|---|---:|
| eBay Browse | **Fix** the OAuth client-credentials flow (§4) | $0 |
| SerpApi (Google Shopping) | **Keep**, on the free tier | $0 (likely; $25 if usage runs hot) |
| Rainforest (Amazon) | **Disable** — unset `RAINFOREST_API_KEY` | $0 (was ~$23+) |
| Serper.dev | **Hold in reserve** — add only if SerpApi's free tier is consistently exceeded | $0 until needed |

**Estimated current-stack cost** at the ~250-searches/month hobby estimate used throughout: **~$23/month**, almost entirely from Rainforest. **Estimated target-stack cost: $0/month**, with a known, cheap escape hatch (SerpApi's paid tiers, or adding Serper.dev) if real usage turns out higher than estimated.

---

## 7. Compatibility with the Existing Codebase

Every change above fits the pattern already in place, which is why this is a low-effort follow-up rather than a redesign:

- **Disabling Rainforest** is a config change — the adapter already treats a missing key as "return no results," exactly like the README's existing "required vs. optional" key table describes for every other optional provider.
- **Adding Serper.dev** later means one new file shaped like `serpapi.ts` (same `RetailerAdapter` interface, same `fetchWithRetryOn429` + `scoreMatch` helpers) and one line in `index.ts`'s `adapters` array — the exact seam the codebase comment already calls out: *"add new retailers here without touching orchestration code."*
- **Fixing eBay's auth** is scoped entirely inside `lib/retailers/` (one new helper file, one new env var) and touches nothing in `orchestrator.ts`, `rank.ts`, or the frontend.
- No changes to `PinResult`, `RetailerListing`, the ranking/dedupe logic, the job polling API, or the UI — they only ever see the adapters' already-normalized output.

---

## 8. Open Questions

1. Confirm current Amazon Associates qualifying-sales threshold before ruling out PA-API entirely — if there's already an Associates account in good standing, free Amazon coverage becomes available without Rainforest or the "drop it" tradeoff.
2. What's the actual real-world search volume per month? The ~250/month estimate throughout this doc is illustrative — worth instrumenting (a simple log line or counter alongside the existing cache) for a week or two to replace the estimate with real numbers before deciding whether SerpApi's free tier is enough long-term.
3. Is partial/gated Rainforest re-enablement (only call it when other adapters return nothing) worth the added complexity, or is "Amazon coverage via Google Shopping only" an acceptable permanent tradeoff for a solo tool?
