import { beforeEach, describe, expect, it } from "vitest";
import { MAX_PAID_SEARCHES_PER_BOARD, countProcessed, rerunPins, runPipeline, searchItem } from "@/lib/pipeline/orchestrator";
import { createJob } from "@/lib/pipeline/jobs";
import { detectionCache, listingsCache, verifiedCache } from "@/lib/pipeline/cache";
import { pinsFromImageUrls } from "@/lib/pinterest/fetchBoard";
import { ServiceError } from "@/lib/errors";
import type { DetectedItem, Pin, RetailerListing } from "@/lib/types";
import type { RetailerAdapter } from "@/lib/retailers/types";
import type { Detection } from "@/lib/vision/detectItems";

let jobCounter = 0;
const newJob = (totalPins: number) => createJob(`test-job-${++jobCounter}`, totalPins, false);

const itemFor = (pin: Pin, i = 0, overrides: Partial<DetectedItem> = {}): DetectedItem => ({
  itemId: `${pin.pinId}#${i}`,
  pinId: pin.pinId,
  productName: `Red sweater ${i}`,
  itemType: "crewneck sweater",
  category: "top",
  colors: ["red"],
  pattern: "solid",
  attributes: ["red", "wool"],
  typeKeywords: ["sweater", "crewneck"],
  searchQuery: `red wool sweater ${pin.pinId} ${i}`,
  confidence: "high",
  search: { status: "idle", deals: [] },
  ...overrides,
});

const detectionFor =
  (itemsPerPin = 1, confidence: Detection["confidence"] = "high") =>
  async (pin: Pin): Promise<Detection> => ({
    confidence,
    items: confidence === "low" ? [] : Array.from({ length: itemsPerPin }, (_, i) => itemFor(pin, i)),
  });

const listing = (retailer: string, price: number, title = "Red wool crewneck sweater"): RetailerListing => ({
  retailer,
  title,
  price,
  currency: "USD",
  url: `https://${retailer}.example/${price}`,
  imageUrl: `https://${retailer}.example/${price}.jpg`,
  matchConfidence: 0.9,
});

const adapter = (name: string, impl: RetailerAdapter["search"]): RetailerAdapter => ({
  name,
  isConfigured: () => true,
  search: impl,
});

const passAll: NonNullable<Parameters<typeof searchItem>[3]>["verify"] = async (_img, _item, cands, hooks) => {
  hooks?.onCall?.();
  return { passed: cands.map((c) => ({ ...c, matchConfidence: 0.85 })), checked: cands.length };
};

beforeEach(() => {
  detectionCache.clear();
  listingsCache.clear();
  verifiedCache.clear();
});

describe("runPipeline (item detection)", () => {
  it("handles a board with zero pins", async () => {
    const job = newJob(0);
    await runPipeline([], job, { detect: detectionFor() });
    expect(job.status).toBe("done");
    expect(countProcessed(job)).toBe(0);
  });

  it("detects multiple items per pin and searches nothing automatically", async () => {
    const pins: Pin[] = [{ pinId: "outfit", imageUrl: "https://img.example/o.jpg" }];
    const job = newJob(1);
    await runPipeline(pins, job, { detect: detectionFor(3) });
    const r = job.results["outfit"];
    expect(r.status).toBe("done");
    expect(r.items.map((i) => i.itemId)).toEqual(["outfit#0", "outfit#1", "outfit#2"]);
    expect(r.items.every((i) => i.search.status === "idle")).toBe(true);
    expect(job.usage.retailerCalls).toEqual({});
  });

  it("skips non-product pins", async () => {
    const pins: Pin[] = [{ pinId: "meme", imageUrl: "https://img.example/meme.jpg" }];
    const job = newJob(1);
    await runPipeline(pins, job, { detect: detectionFor(1, "low") });
    expect(job.results["meme"].status).toBe("skipped");
    expect(job.results["meme"].skipReason).toBeTruthy();
  });

  it("defers the rest of the board when Gemini's daily quota runs out, and reruns them later", async () => {
    const pins: Pin[] = Array.from({ length: 5 }, (_, i) => ({ pinId: `p${i}`, imageUrl: `https://img.example/${i}.jpg` }));
    const job = newJob(pins.length);
    let calls = 0;
    await runPipeline(pins, job, {
      detectConcurrency: 1,
      detect: async (pin) => {
        if (++calls > 2) throw new ServiceError("Gemini", "quota", "Daily limit used up.", 3600);
        return detectionFor()(pin);
      },
    });
    const statuses = pins.map((p) => job.results[p.pinId].status);
    expect(statuses).toEqual(["done", "done", "deferred", "deferred", "deferred"]);
    expect(job.results["p4"].deferredReason).toBe("Daily limit used up.");
    expect(job.halt?.service).toBe("Gemini");
    expect(countProcessed(job)).toBe(5);

    // Quota resets → rerun only the deferred pins.
    const queued = rerunPins(job, { detect: detectionFor() });
    expect(queued).toBe(3);
    await new Promise((r) => setTimeout(r, 20));
    expect(pins.every((p) => job.results[p.pinId].status === "done")).toBe(true);
    expect(job.halt).toBeUndefined();
  });

  it("turns unexpected errors into a readable per-pin error without killing the batch", async () => {
    const pins: Pin[] = [
      { pinId: "broken", imageUrl: "https://img.example/broken.jpg" },
      { pinId: "fine", imageUrl: "https://img.example/fine.jpg" },
    ];
    const job = newJob(2);
    await runPipeline(pins, job, {
      detect: async (p) => {
        if (p.pinId === "broken") throw new ServiceError("Image", "network", "Couldn't download the image.");
        return detectionFor()(p);
      },
    });
    expect(job.results["broken"].status).toBe("error");
    expect(job.results["broken"].error).toBe("Couldn't download the image.");
    expect(job.results["fine"].status).toBe("done");
  });

  it("counts Gemini calls and serves repeats from cache", async () => {
    const board = pinsFromImageUrls(["https://img.example/1.jpg", "https://img.example/2.jpg"]);
    const job1 = newJob(2);
    const detect = async (pin: Pin, hooks: { onCall?: () => void }) => {
      hooks.onCall?.();
      return detectionFor()(pin);
    };
    await runPipeline(board.pins, job1, { detect });
    expect(job1.usage.geminiIdentify).toBe(2);

    const job2 = newJob(2);
    await runPipeline(board.pins, job2, { detect });
    expect(job2.usage.geminiIdentify).toBe(0);
    expect(job2.usage.cacheHits).toBe(2);
  });
});

describe("searchItem (on demand)", () => {
  const pin: Pin = { pinId: "x", imageUrl: "https://img.example/x.jpg" };

  async function jobWithItem() {
    const job = newJob(1);
    await runPipeline([pin], job, { detect: detectionFor(1) });
    return job;
  }

  it("searches every adapter, keeps visually verified deals, cheapest first, top 5", async () => {
    const job = await jobWithItem();
    const item = await searchItem(job, "x", "x#0", {
      adapters: [
        adapter("a", async () => [listing("a", 30), listing("a", 10)]),
        adapter("b", async () => [listing("b", 20), listing("b", 40), listing("b", 50), listing("b", 60)]),
      ],
      verify: passAll,
    });
    expect(item?.search.status).toBe("done");
    expect(item?.search.verified).toBe(true);
    expect(item?.search.deals.map((d) => d.price)).toEqual([10, 20, 30, 40, 50]);
    expect(job.usage.retailerCalls).toEqual({ a: 1, b: 1 });
    expect(job.usage.geminiVerify).toBe(1);
  });

  it("explains a quota failure instead of saying 'no deals'", async () => {
    const job = await jobWithItem();
    const item = await searchItem(job, "x", "x#0", {
      adapters: [
        adapter("Google Shopping", async () => {
          throw new ServiceError("SerpApi", "quota", "SerpApi's monthly search allowance is used up.");
        }),
      ],
      verify: passAll,
    });
    expect(item?.search.status).toBe("error");
    expect(item?.search.note).toContain("monthly search allowance is used up");
    expect(item?.search.sources?.[0]).toMatchObject({ ok: false });
  });

  it("says when listings existed but none passed the visual check", async () => {
    const job = await jobWithItem();
    const item = await searchItem(job, "x", "x#0", {
      adapters: [adapter("a", async () => [listing("a", 10), listing("a", 12)])],
      verify: async (_i, _it, cands) => ({ passed: [], checked: cands.length }),
    });
    expect(item?.search.deals).toEqual([]);
    expect(item?.search.note).toMatch(/none of the 2 closest ones matched/);
  });

  it("falls back to title matching when the visual check is rate-limited", async () => {
    const job = await jobWithItem();
    const item = await searchItem(job, "x", "x#0", {
      adapters: [
        adapter("a", async () => [listing("a", 15), listing("a", 5, "Blue denim jacket")]),
      ],
      verify: async () => {
        throw new ServiceError("Gemini", "rate_limit", "Gemini's per-minute limit was hit.");
      },
    });
    expect(item?.search.verified).toBe(false);
    expect(item?.search.deals.map((d) => d.price)).toEqual([15]); // jacket isn't a sweater
    expect(item?.search.note).toContain("Visual check unavailable");
  });

  it("only runs fallback sources when primary ones find too few priced listings", async () => {
    const job = await jobWithItem();
    let fallbackCalls = 0;
    let seenImage: string | undefined;
    const lens = { ...adapter("lens", async (_p, ctx) => ((seenImage = ctx?.imageUrl), [listing("lens", 10), listing("lens", 11), listing("lens", 12)])), usesImage: true };
    const shopping = { ...adapter("shop", async () => (fallbackCalls++, [listing("shop", 5)])), tier: "fallback" as const };
    await searchItem(job, "x", "x#0", { adapters: [lens, shopping], verify: passAll });
    expect(seenImage).toBe(pin.imageUrl);
    expect(fallbackCalls).toBe(0);
    expect(job.usage.retailerCalls).toEqual({ lens: 1 });

    const job2 = await jobWithItem();
    listingsCache.clear();
    verifiedCache.clear();
    const thinLens = { ...adapter("lens", async () => [listing("lens", 10)]), usesImage: true };
    const item = await searchItem(job2, "x", "x#0", { adapters: [thinLens, shopping], verify: passAll });
    expect(fallbackCalls).toBe(1);
    expect(item?.search.deals.map((d) => d.price)).toEqual([5, 10]);
  });

  it("runs the fallback when the primary source fails", async () => {
    const job = await jobWithItem();
    const lens = adapter("lens", async () => {
      throw new ServiceError("SerpApi (Google Lens)", "config", "Google Lens needs a public image URL.");
    });
    const shopping = { ...adapter("shop", async () => [listing("shop", 7)]), tier: "fallback" as const };
    const item = await searchItem(job, "x", "x#0", { adapters: [lens, shopping], verify: passAll });
    expect(item?.search.deals.map((d) => d.price)).toEqual([7]);
    expect(item?.search.note).toContain("Google Lens needs a public image URL");
  });

  it("stops paid searches once a board hits its cap, but still serves cached ones", async () => {
    const job = await jobWithItem();
    const opts = { adapters: [adapter("Google Lens", async () => [listing("lens", 10)])], verify: passAll };
    await searchItem(job, "x", "x#0", opts); // cached now
    job.usage.retailerCalls["Google Lens"] = MAX_PAID_SEARCHES_PER_BOARD;
    const cached = await searchItem(job, "x", "x#0", opts);
    expect(cached?.search.deals).toHaveLength(1);

    const pin2: Pin = { pinId: "y", imageUrl: "https://img.example/y.jpg" };
    job.results.y = { pin: pin2, status: "done", items: [itemFor(pin2)] };
    const refused = await searchItem(job, "y", "y#0", opts);
    expect(refused?.search.status).toBe("error");
    expect(refused?.search.note).toContain(`used its ${MAX_PAID_SEARCHES_PER_BOARD} price searches`);
  });

  it("does not re-spend API calls for a repeated search", async () => {
    const job = await jobWithItem();
    let calls = 0;
    const opts = {
      adapters: [adapter("a", async () => (calls++, [listing("a", 10)]))],
      verify: passAll,
    };
    await searchItem(job, "x", "x#0", opts);
    await searchItem(job, "x", "x#0", opts);
    expect(calls).toBe(1);
    expect(job.usage.geminiVerify).toBe(1);
    expect(job.usage.cacheHits).toBe(2);
  });
});
