# Pinterest Deal Finder

Paste a Pinterest board URL (or upload images), and the app identifies every
product-like pin with Gemini vision, searches multiple retailers in parallel,
and shows the top 5 cheapest verified matches per item — with price, retailer,
link, and a match-confidence badge.

## Quick start

```bash
npm install
cp .env.local.example .env.local   # fill in keys (see table below)
npm run dev                        # http://localhost:3000
```

## API keys — required vs optional

| Key | Required? | Without it |
|---|---|---|
| `GEMINI_API_KEY` (+ optional `GEMINI_MODEL`, `GEMINI_RPM`) | **Required** | No product identification — the pipeline can't run at all. Free tier at [aistudio.google.com](https://aistudio.google.com/apikey) is enough for solo/hobby use. |
| `SERPAPI_KEY` (Google Lens + Google Shopping) | Strongly recommended | No Google Lens or Google Shopping results, so without eBay keys there are no deal results at all. Free tier: 250 searches/month. |
| `EBAY_APP_ID` + `EBAY_CERT_ID` (eBay Browse API: the production keyset's App ID / Client ID and Cert ID / Client Secret) | Optional, recommended | No eBay results. Free (eBay's default limit is 5,000 calls/day) and doesn't touch the SerpApi allowance. Searches eBay by a crop of each piece, Buy It Now only, and tops up with a text search; if eBay doesn't allow image search for your developer account, it uses text search alone. Keys: developer.ebay.com → Application Keys → create a Production keyset. |
| `RAINFOREST_API_KEY` (Amazon) | Optional, **disabled by default** | Amazon-specific results won't appear via this adapter, though Amazon listings often still surface through SerpApi's Google Shopping results. Rainforest has no free tier (from ~$23/month), so `rainforestAdapter` is present in `lib/retailers/rainforest.ts` but intentionally left out of the default adapter registry in `lib/retailers/index.ts` — uncomment it there (and set this key) to re-enable. |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` + `TURNSTILE_SECRET_KEY` (+ recommended `TURNSTILE_HOSTNAMES`) (Cloudflare Turnstile) | **Required for a public deployment** | No bot check: anyone (or any script) can start boards and spend your Gemini and SerpApi allowance. Free at [dash.cloudflare.com](https://dash.cloudflare.com/?to=/:account/turnstile). Leave both unset for local development; the check is then skipped on both client and server. |
| `MAX_SEARCHES_PER_BOARD` | Optional (default 30) | Caps the paid SerpApi searches one board can spend, so one visitor can't use the whole month's allowance. Repeat searches served from cache don't count. |
| `PUBLIC_BASE_URL` | Optional (automatic on Render) | The site's public `https://` address. Google Lens is sent a crop of just the piece being searched, served from `/api/crop`, which SerpApi must be able to reach. Render sets `RENDER_EXTERNAL_URL` itself, so this is only needed elsewhere. Without either (e.g. on localhost), Lens searches the whole pin photo with a text hint, which is less precise. |

All keys are read from `process.env` only — nothing is hardcoded.

## Public board scraping (no API key)

Pasting a public board link (`pinterest.com/<user>/<board>/`, regional domains
and `pin.it` short links included) works with no Pinterest credentials.
`lib/pinterest/scrapeBoard.ts` calls the same unauthenticated JSON endpoints
pinterest.com's web client uses for logged-out visitors:

1. `BoardResource` → board id, `pin_count`, privacy
2. `BoardFeedResource` → pins in one request (most recent first), capped at
   `MAX_PINS` (50). Logged-out bookmark pagination returns empty pages, so the
   page is sized to `min(MAX_PINS, pin_count)`. Pinterest sometimes returns a
   short ~25-item page instead, so it retries up to 4× and keeps the fullest.
3. If those endpoints break, it falls back to the board RSS feed
   (`/<user>/<board>.rss`, ~25 most recent pins).

Images use the 736px variant. Non-pin feed items (stories, modules) are dropped.
These endpoints are undocumented and may change. Private boards aren't
supported: there's no Pinterest sign-in (the official developer API was
dropped), so only boards visible to logged-out visitors work.

## How it works

```
Board URL or uploaded images
        │
        ▼
[Board Ingestion]            lib/pinterest/scrapeBoard.ts — no-auth scrape of a
        │                    public board (capped at 50 pins); or a
        │                    fallback that normalizes pasted URLs/uploads into
        │                    the same Pin[]
        ▼
[1. Item detection — automatic]   lib/vision/detectItems.ts
        │   One Gemini call per pin (gemini-3.5-flash-lite; override with
        │   GEMINI_MODEL) lists EVERY purchasable item separately — for an outfit:
        │   jacket, top, jeans, shoes, hat… — with type, colors, pattern,
        │   details, title keywords and a Google Shopping query. Non-product
        │   images are skipped. No retailer searches happen at this stage.
        │   Requests are paced to GEMINI_RPM (default 15/min, the free tier).
        ▼
[2. Item search — on demand]      POST /api/board/[jobId]/search {pinId,itemId}
        │   When you click "Find deals" on an item: Google Lens (via SerpApi)
        │   searches by the pin photo, with the item description as a text
        │   hint, + eBay in parallel. Only if they return fewer than 3 priced
        │   listings does Google Shopping text search run as a fallback (a
        │   2nd SerpApi search). Title pre-filter → up to 10 candidates →
        ▼
[3. Visual check]                 lib/vision/verifyMatches.ts
        │   One Gemini call: pin photo + candidate thumbnails; Gemini scores
        │   each on item type, color, pattern and silhouette. Only matches
        │   ≥ 0.6 are kept, cheapest first, top 5. If Gemini is unavailable,
        │   falls back to title matching and says so.
        ▼
[API + collage UI]                POST /api/board (bot-checked) → jobId; GET …/status polled
                                  every 1.5s; POST …/rerun retries deferred pins
```

Cost per board: 1 Gemini call per pin automatically; then per item you click,
1 SerpApi search (Google Lens; 2 if the Google Shopping
fallback runs) + 1 eBay call + 1 Gemini call. The UI shows a live usage
panel per board, plus SerpApi's remaining monthly searches (`GET /api/usage`,
which uses SerpApi's free account endpoint).

Design notes:

- **Errors say why.** Every external failure becomes a `ServiceError`
  (`lib/errors.ts`) with a kind (`quota`, `rate_limit`, `auth`, `timeout`, …)
  and a plain-English message. An item with no results says whether retailers
  had nothing, a quota was used up, or listings existed but failed the visual
  check.
- **Quotas.** Gemini per-minute 429s are waited out (using Google's
  `retryDelay`) and retried. If the *daily* quota runs out mid-board, the
  remaining pins are marked "deferred" (still shown), with the reset time and
  a "Retry remaining pins" button.
- **Caching**: detections by image URL, retailer results by adapter+query, and
  visual-check results by pin+item (in-memory, ~1h TTL). Repeats cost nothing.
- **Scaling**: queues are in-process (`p-queue`) and job state is an
  in-memory `Map`. To run beyond a single server process, swap to
  BullMQ + Redis.

## Deploying (Render, free)

`render.yaml` describes one free Render web service (`npm ci && npm run build`,
then `npm start`, health check at `/api/health`).

1. Push the repo to GitHub, then in Render choose **New → Blueprint** and pick it.
2. Fill in the prompted keys (`GEMINI_API_KEY`, `SERPAPI_KEY`, and the two
   Turnstile keys; add your Render URL as an allowed hostname in Cloudflare's
   Turnstile settings). eBay keys are optional; leave them blank.
3. Every push to the default branch redeploys.

Free-plan behavior: the service sleeps after ~15 idle minutes and takes
roughly 30–60s to wake on the next visit. Boards in progress live in memory,
so a sleep or redeploy drops them (visitors just run the board again).

## Scripts

```bash
npm run dev     # dev server
npm run build   # production build
npm test        # vitest suite (scraping, adapters + error classification,
                # Gemini quota handling, detection/search/rerun orchestration)
npm run smoke   # live smoke test over 3 sample images: detects items and
                # searches the first item of each (uses ~3 SerpApi searches).
                # Needs GEMINI_API_KEY (and SERPAPI_KEY for deal results).
```

## Covered edge cases (tested)

- Board with zero pins.
- Non-product pins (text graphics, memes, abstract art) → skipped with a reason.
- Every retailer failing for an item → the item says why (quota used up, bad
  key, timeout); other items and pins unaffected.
- Gemini daily quota exhausted mid-board → remaining pins deferred with reset
  time and a retry button; per-minute limits are waited out automatically.
- Visual check unavailable → title-matched fallback, labeled as such.
- Pinterest app not configured, or visitor not connected → public boards are scraped; upload/URL fallback still available.
- Private / missing board → clear 404 error ("only public boards can be scraped").
- 429 from a retailer → retried once with backoff, then reported as rate-limited.
- Duplicate/near-duplicate listings from the same retailer → deduped before ranking.
