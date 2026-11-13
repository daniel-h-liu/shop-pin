import PQueue from "p-queue";
import type {
  AdapterOutcome,
  DetectedItem,
  JobState,
  Pin,
  PinResult,
  RetailerListing,
} from "@/lib/types";
import { ServiceError, describeError } from "@/lib/errors";
import { detectItems, type Detection } from "@/lib/vision/detectItems";
import { MAX_CANDIDATES, verifyMatches } from "@/lib/vision/verifyMatches";
import type { GeminiHooks } from "@/lib/vision/gemini";
import { adapters as defaultAdapters, type RetailerAdapter } from "@/lib/retailers";
import { cropUrlFor } from "@/lib/crop";
import { detectionCache, listingsCache, verifiedCache } from "./cache";
import { TOP_N, dedupeListings, pickCandidates, rankByText, splitOriginal } from "./rank";

// Gemini pacing (requests/minute) is enforced globally in lib/vision/gemini.ts;
// this only bounds how many pins are in flight at once.
const DETECT_CONCURRENCY = 4;
const SEARCH_CONCURRENCY = 8;
/** Fewer priced listings than this from primary sources → also run fallback sources. */
const MIN_PRIMARY_LISTINGS = 3;
/**
 * Paid (SerpApi) searches one board may spend, so one visitor can't use up
 * the shared monthly allowance. Repeat searches served from cache are free.
 */
export const MAX_PAID_SEARCHES_PER_BOARD = Number(process.env.MAX_SEARCHES_PER_BOARD) || 30;
const PAID_ADAPTERS = ["Google Lens", "Google Shopping"];

export function paidSearchCount(job: JobState): number {
  return PAID_ADAPTERS.reduce((n, a) => n + (job.usage.retailerCalls[a] ?? 0), 0);
}

const g = globalThis as unknown as { __pdfSearchQueue?: PQueue };
const searchQueue: PQueue =
  g.__pdfSearchQueue ?? (g.__pdfSearchQueue = new PQueue({ concurrency: SEARCH_CONCURRENCY }));

export type PipelineOptions = {
  detect?: (pin: Pin, hooks: GeminiHooks) => Promise<Detection>;
  detectConcurrency?: number;
};

const TERMINAL: PinResult["status"][] = ["done", "skipped", "deferred", "error"];

export function countProcessed(job: JobState): number {
  return Object.values(job.results).filter((r) => TERMINAL.includes(r.status)).length;
}

function geminiHooks(job: JobState, purpose: "identify" | "verify"): GeminiHooks {
  return {
    onCall: () => {
      if (purpose === "identify") job.usage.geminiIdentify++;
      else job.usage.geminiVerify++;
    },
    onRateLimitWait: () => job.usage.geminiRateLimitWaits++,
    // Someone is waiting on an item search; pin reading can wait a few seconds.
    priority: purpose === "verify" ? 1 : 0,
  };
}

/**
 * Stage 1 (automatic): one Gemini call per pin detects every purchasable item.
 * No retailer searches happen here — items are searched on demand
 * (searchItem) so SerpApi's monthly quota is only spent on what you click.
 *
 * If Gemini's daily quota runs out mid-board, the remaining pins are marked
 * "deferred" (with the reset time) instead of erroring; rerunPins() picks them
 * up later.
 */
export async function runPipeline(
  pins: Pin[],
  job: JobState,
  opts: PipelineOptions = {},
): Promise<void> {
  const detect = opts.detect ?? detectItems;
  const queue = new PQueue({ concurrency: opts.detectConcurrency ?? DETECT_CONCURRENCY });

  for (const pin of pins) {
    job.results[pin.pinId] = { pin, status: "pending", items: [] };
  }

  const processPin = async (pin: Pin): Promise<void> => {
    const result = job.results[pin.pinId];
    if (job.halt) {
      result.status = "deferred";
      result.deferredReason = job.halt.message;
      return;
    }
    try {
      result.status = "identifying";
      let detection = detectionCache.get(pin.imageUrl);
      if (detection) job.usage.cacheHits++;
      else {
        detection = await detect(pin, geminiHooks(job, "identify"));
        detectionCache.set(pin.imageUrl, detection);
      }
      result.confidence = detection.confidence;
      // Cache is keyed by imageUrl; re-stamp ids in case the image repeats under another pin.
      result.items = detection.items.map((it, i) => ({
        ...it,
        pinId: pin.pinId,
        itemId: `${pin.pinId}#${i}`,
        cropUrl: cropUrlFor(pin.imageUrl, it.box),
        search: { status: "idle", deals: [] },
      }));
      if (detection.confidence === "low" || result.items.length === 0) {
        result.status = "skipped";
        result.skipReason =
          "No purchasable product found in this image (looks like a text graphic, mood board, scenery or similar).";
        return;
      }
      result.status = "done";
    } catch (err) {
      if (err instanceof ServiceError && (err.kind === "quota" || err.kind === "rate_limit")) {
        result.status = "deferred";
        result.deferredReason = err.message;
        if (err.kind === "quota") {
          job.halt = {
            service: err.service,
            message: err.message,
            retryAt: err.retryAfterSec ? Date.now() + err.retryAfterSec * 1000 : undefined,
          };
        }
        return;
      }
      result.status = "error";
      result.error = describeError(err, "Analyzing this pin");
    }
  };

  await Promise.allSettled(pins.map((pin) => queue.add(() => processPin(pin))));
  job.processedPins = countProcessed(job);
  job.status = "done";
}

/** Retry the pins that were deferred (quota) or errored. Returns how many were queued. */
export function rerunPins(job: JobState, opts: PipelineOptions = {}): number {
  const pins = Object.values(job.results)
    .filter((r) => r.status === "deferred" || r.status === "error")
    .map((r) => r.pin);
  if (pins.length === 0) return 0;
  job.halt = undefined;
  job.status = "running";
  for (const p of pins) {
    job.results[p.pinId] = { pin: p, status: "pending", items: [] };
  }
  job.processedPins = countProcessed(job);
  runPipeline(pins, job, opts).catch((err) => {
    job.status = "error";
    job.error = describeError(err, "Pipeline");
  });
  return pins.length;
}

export type SearchOptions = {
  adapters?: RetailerAdapter[];
  verify?: typeof verifyMatches;
  /** Called with the item when first results are in, before the visual check. */
  onProgress?: (item: DetectedItem) => void;
};

/**
 * Stage 2 (on demand): search retailers for one detected item, then have
 * Gemini visually check the best candidates against the pin photo.
 *
 * Results come in two steps: as soon as the searches return, item.search is
 * "checking" with the closest-looking listings (onProgress fires); after the
 * visual check it is "done" with `original` (the exact piece, at any price)
 * and `deals` (similar pieces, cheapest first).
 * Mutates item.search and returns it. Never throws.
 */
export async function searchItem(
  job: JobState,
  pinId: string,
  itemId: string,
  opts: SearchOptions = {},
): Promise<DetectedItem | undefined> {
  const pin = job.results[pinId];
  const item = pin?.items.find((i) => i.itemId === itemId);
  if (!pin || !item) return undefined;

  const verify = opts.verify ?? verifyMatches;
  const adapters = (opts.adapters ?? defaultAdapters).filter((a) => a.isConfigured());
  item.search = { status: "searching", deals: [] };

  if (adapters.length === 0) {
    item.search = {
      status: "error",
      deals: [],
      note: "No retailer API keys are configured (SERPAPI_KEY, or EBAY_APP_ID + EBAY_CERT_ID), so nothing can be searched.",
    };
    return item;
  }

  // 1. Primary adapters in parallel (Google Lens + eBay); fallback adapters
  //    (Google Shopping text search) only if those found too few priced
  //    listings. Record how each one did.
  const sources: AdapterOutcome[] = [];
  const listings: RetailerListing[] = [];
  const ctx = { imageUrl: pin.pin.imageUrl, cropUrl: item.cropUrl, box: item.box };
  const cacheKey = (a: RetailerAdapter) =>
    `${a.name}::${a.usesImage ? `${ctx.cropUrl ?? ctx.imageUrl}::` : ""}${item.searchQuery}`;

  const alreadyCached = adapters.some((a) => listingsCache.get(cacheKey(a)));
  if (!alreadyCached && paidSearchCount(job) >= MAX_PAID_SEARCHES_PER_BOARD) {
    item.search = {
      status: "error",
      deals: [],
      note: `This board has used its ${MAX_PAID_SEARCHES_PER_BOARD} price searches. Open the pin in Google Lens to keep looking.`,
    };
    return item;
  }

  const runAdapters = (list: RetailerAdapter[]) =>
    searchQueue.add(() =>
      Promise.all(
        list.map(async (a) => {
          const key = cacheKey(a);
          const cached = listingsCache.get(key);
          if (cached) {
            job.usage.cacheHits++;
            sources.push({ adapter: a.name, ok: true, count: cached.length, cached: true });
            listings.push(...cached);
            return;
          }
          job.usage.retailerCalls[a.name] = (job.usage.retailerCalls[a.name] ?? 0) + 1;
          try {
            const found = await a.search(item, ctx);
            listingsCache.set(key, found);
            sources.push({ adapter: a.name, ok: true, count: found.length });
            listings.push(...found);
          } catch (err) {
            sources.push({ adapter: a.name, ok: false, count: 0, message: describeError(err, a.name) });
          }
        }),
      ),
    );
  const primary = adapters.filter((a) => (a.tier ?? "primary") === "primary");
  const fallback = adapters.filter((a) => a.tier === "fallback");
  if (primary.length) await runAdapters(primary);
  if (fallback.length && listings.filter((l) => l.price > 0).length < MIN_PRIMARY_LISTINGS) {
    await runAdapters(fallback);
  }

  const failed = sources.filter((s) => !s.ok);
  if (listings.length === 0) {
    item.search = {
      status: failed.length === sources.length ? "error" : "done",
      deals: [],
      sources,
      note:
        failed.length === sources.length
          ? `Couldn't search any retailer: ${failed.map((f) => f.message).join(" ")}`
          : `Retailers returned no listings for “${item.searchQuery}”.${
              failed.length ? ` Some sources failed: ${failed.map((f) => f.message).join(" ")}` : ""
            }`,
    };
    return item;
  }

  // 2. Show the closest-looking priced listings right away while the visual check runs.
  item.search = {
    status: "checking",
    deals: [...dedupeListings(listings.filter((l) => l.price > 0))]
      .sort((a, b) => b.matchConfidence - a.matchConfidence)
      .slice(0, TOP_N),
    sources,
  };
  opts.onProgress?.(item);

  // 3. Visual check of the most promising candidates (unpriced ones may be the original).
  const verifiedKey = `${pin.pin.imageUrl}::${item.itemType}::${item.searchQuery}::${ctx.cropUrl ?? ""}`;
  const cachedVerified = verifiedCache.get(verifiedKey);
  const candidates = pickCandidates(item, listings, MAX_CANDIDATES);
  let deals: RetailerListing[];
  let original: RetailerListing | undefined;
  let verified = true;
  let note: string | undefined;
  try {
    let passed: RetailerListing[];
    if (cachedVerified) {
      job.usage.cacheHits++;
      passed = cachedVerified;
    } else {
      ({ passed } = await verify(pin.pin.imageUrl, item, candidates, geminiHooks(job, "verify")));
      verifiedCache.set(verifiedKey, passed);
    }
    ({ original, deals } = splitOriginal(passed, TOP_N));
    if (!original && deals.length === 0) {
      note = `Found ${listings.length} listings, but none of the ${candidates.length} closest ones matched this item's type, color and pattern in the visual check.`;
    } else if (original && deals.length === 0) {
      note = `No ${original.price > 0 ? "cheaper " : ""}look-alikes passed the visual check.`;
    }
  } catch (err) {
    verified = false;
    deals = rankByText(item, listings);
    note = `Visual check unavailable (${describeError(err, "Gemini")}) Showing title-matched results only; colors and patterns may not match.`;
    if (deals.length === 0) note += " No listing titles matched this item type either.";
  }

  if (failed.length) {
    note = [note, `Some sources failed: ${failed.map((f) => f.message).join(" ")}`].filter(Boolean).join(" ");
  }
  item.search = { status: "done", original, deals, verified, note, sources };
  return item;
}
