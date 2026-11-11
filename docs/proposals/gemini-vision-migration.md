# Proposal: Replace Claude Vision with Gemini 2.5 Flash-Lite for Product Identification

**Status:** Draft for review
**Author:** Claude Code (drafted on request)
**Date:** 2026-07-11
**Scope:** `lib/vision/identifyProduct.ts` only — no other pipeline stage changes required.

---

## 1. Summary

The product-identification step currently calls **`claude-opus-4-8`** — Anthropic's most expensive model ($5.00 / $25.00 per MTok input/output) — to do a bounded, structured-extraction task (name a clothing item, guess brand/attributes, write a search query). This is the priciest model available for what is essentially a classification task, and it's a paid-only API with no free tier, which conflicts with the goal of running this project at near-zero cost for solo/hobby use.

**Recommendation:** Replace it with **Gemini 2.5 Flash-Lite** (`gemini-2.5-flash-lite`). At current published pricing it is roughly **60–80x cheaper per call** than Opus 4.8, and Google's free tier will likely cover all solo-use volume outright ($0/month in practice). The swap is low-risk because the pipeline already has a dependency-injection seam for this exact purpose (`PipelineOptions.identify` in `lib/pipeline/orchestrator.ts:17`, already exercised by the test suite) — production code needs one new file plus a one-line default-import change, not a pipeline rewrite.

---

## 2. Current State

`lib/vision/identifyProduct.ts` sends one image + a ~130-token instruction prompt to `claude-opus-4-8` per pin, using `client.messages.parse()` with a Zod schema (`output_config.format`) to force structured JSON output (`productName`, `category`, `brand`, `attributes`, `searchQuery`, `confidence`). On failure it retries once. `runPipeline` fans this out through a `p-queue` at concurrency 5, and results are cached by image URL (`lib/pipeline/cache.ts`) so a re-run of the same board doesn't re-spend the call.

This is a well-built pipeline stage — the problem is purely **which model is behind it**, not the surrounding orchestration.

---

## 3. Problem

- `claude-opus-4-8` is priced for frontier reasoning/agentic work, not single-image classification. There is no cheaper way to use it — Anthropic has no free tier at all.
- The task's actual difficulty is low: identify a clearly-photographed clothing item and emit ~6 short structured fields. This is squarely inside what small/cheap multimodal models handle well.
- For a solo hobby project, "free if possible" is a real constraint, and the current design has zero path to $0.

---

## 4. Options Considered

| Option | Input $/MTok | Output $/MTok | Free tier | Notes |
|---|---:|---:|---|---|
| **`claude-opus-4-8`** (current) | $5.00 | $25.00 | None | Frontier model; wildly overpowered for this task |
| `claude-haiku-4-5` | $1.00 | $5.00 | None | Still Anthropic; ~5x cheaper than Opus, but the ask was to move off paid Claude models entirely |
| `gemini-3.5-flash` (latest Flash) | $1.50 | $9.00 | Free tier exists | Surprisingly, now *pricier* than Claude Haiku 4.5 — not the right pick for a cost-minimization goal |
| `gemini-3.1-flash-lite` | $0.25 | $1.50 | Free tier exists | Newer, more future-proof than 2.5, but ~2.5x the cost of 2.5 Flash-Lite |
| **`gemini-2.5-flash-lite`** ✅ | **$0.10** | **$0.40** | **Free tier exists** | Best $/quality for a bounded classification task; still GA and broadly used |
| Self-hosted open-source VLM (Qwen2.5-VL-7B, LLaVA, moondream2 via Ollama) | $0 marginal | $0 marginal | N/A (local compute) | True $0, but needs a capable local GPU, weaker brand/logo recognition, and less reliable JSON-schema adherence — would need extra retry/validation plumbing. Good future fallback, not the MVP pick. |

*Pricing pulled live from `ai.google.dev/gemini-api/docs/pricing` on 2026-07-11 — verify again before implementing, as Google revises pricing/model lineups more often than Anthropic. Exact free-tier RPM/RPD is account-tier-dependent; check `aistudio.google.com/rate-limit` for the live number rather than trusting a hardcoded figure.*

### Why not the newest Gemini Flash?

Counterintuitively, `gemini-3.5-flash` (the current flagship "Flash" model) is priced *above* Claude Haiku 4.5, not below it. "Flash" is a tier name, not a fixed price point, and Google has pushed the flagship Flash model upmarket over successive generations. The actual budget tier is now **Flash-Lite** — that's the one that matches "cheap but strong enough for clothing ID," not the model most people mean when they casually say "Gemini Flash."

### Why not self-hosted open source now

It's genuinely free, but for a solo user optimizing for "incredibly easy," adding local GPU inference (model download, serving, uptime, weaker structured-output reliability) is a worse cost/effort trade than a $0.0001/call hosted API with a free tier that likely never gets billed. Worth revisiting only if Gemini's free tier quota turns out to be too tight for actual usage patterns — see §9.

---

## 5. Cost Analysis

Assumptions, stated explicitly so the conclusion is checkable:

- One Pinterest pin image (~736×1104px typical) + ~150 tokens of prompt/title text as input.
- Structured JSON output (~150 tokens: name, category, brand, attributes, query, confidence).
- Claude image tokenization ≈ `(width × height) / 750` → ~1,100 tokens for a pin this size.
- Gemini image tokenization is tile-based (~258 tokens/tile up to 768×768) → roughly 500–560 tokens for a pin this size.

| | `claude-opus-4-8` (current) | `gemini-2.5-flash-lite` (proposed) |
|---|---:|---:|
| Input tokens/call | ~1,250 | ~700 |
| Output tokens/call | ~150 | ~150 |
| Cost/call | **~$0.0100** | **~$0.00013** |
| Cost per 50-pin board | **~$0.50** | **~$0.0065** |
| Cost per 100 board runs (5,000 pins) | **~$50** | **~$0.65** (likely $0 under free tier) |

That's roughly a **75x reduction**, and in practice the free tier probably absorbs all of it for solo use — this repo caches identification results by image URL already, so repeated runs against the same board don't even re-spend the (already tiny) per-call cost.

*(Not in scope here, but worth flagging: `SERPAPI_KEY` and `RAINFOREST_API_KEY` are also paid and dwarf the vision-model cost at any real volume. SerpApi has a 100-search/month free tier; eBay's Browse API is free within rate limits. If "free if possible" should extend past identification, that's a natural follow-up proposal.)*

---

## 6. Technical Design

**Goal: zero changes outside `lib/vision/`.** The function signature `(pin: Pin) => Promise<ProductID>` is the only contract the rest of the pipeline cares about — `runPipeline` already accepts an injected `identify` function (`lib/pipeline/orchestrator.ts:17,39`), which is exactly how the test suite mocks this stage today (`tests/orchestrator.test.ts:51,73,92,113,138,158`). That seam means this migration is a **swap, not a refactor**.

Proposed shape of the new file (illustrative — verify exact `@google/genai` SDK method names against current docs before implementing; the SDK surface changes faster than Anthropic's):

```typescript
// lib/vision/identifyProduct.ts
import { GoogleGenAI, Type } from "@google/genai";
import type { Pin, ProductID } from "@/lib/types";

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    productName: { type: Type.STRING },
    category: { type: Type.STRING },
    brand: { type: Type.STRING, nullable: true },
    attributes: { type: Type.ARRAY, items: { type: Type.STRING } },
    searchQuery: { type: Type.STRING },
    confidence: { type: Type.STRING, enum: ["high", "medium", "low"] },
  },
  required: ["productName", "category", "attributes", "searchQuery", "confidence"],
};

let _client: GoogleGenAI | null = null;
function client(): GoogleGenAI {
  if (!_client) _client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return _client;
}

export async function identifyProduct(pin: Pin): Promise<ProductID> {
  // same PROMPT text as today; same imageSource() base64/URL handling;
  // same two-attempt retry loop; same return shape.
  // Swap: response_schema/JSON-mode call to Gemini instead of client.messages.parse().
}
```

Changes required:

1. `npm install @google/genai` (or the Vercel AI SDK's `@ai-sdk/google` if the team prefers a unified provider abstraction across future model swaps — not necessary for a single-provider MVP).
2. New env var `GEMINI_API_KEY`; update `README.md`'s key table and `.env.local.example`.
3. Keep `ANTHROPIC_API_KEY` documented as **optional** rather than deleting the Claude path — see §9 (fallback option).
4. No changes to `orchestrator.ts`, `cache.ts`, `rank.ts`, retailer adapters, or the frontend — they only see `ProductID`.
5. Update `npm run smoke` (`scripts/smoke.ts`) to exercise the new provider instead of/in addition to Claude.

---

## 7. Migration Plan

1. **Spike (½ day):** Confirm current `@google/genai` structured-output API against live docs; run the 3 smoke-test sample images through Gemini 2.5 Flash-Lite manually and eyeball output quality vs. the existing Opus 4.8 output for the same images.
2. **Implement:** Write the new `identifyProduct.ts` behind the same signature; keep the existing Zod schema as the source of truth for the shape (validate Gemini's JSON output against it client-side even though Gemini also enforces its own `responseSchema`, since the two schema systems aren't identical).
3. **Test:** Existing `tests/orchestrator.test.ts` and `tests/rank.test.ts` need no changes (they mock `identify`). Add a small new test file mirroring the current vision test coverage, but against the Gemini call path.
4. **Validate accuracy side-by-side:** Run `npm run smoke` (or a small ad hoc script) against ~15–20 varied pins (clean product photos, ambiguous items, non-product mood boards) comparing Opus 4.8 vs. Flash-Lite output — confirm brand detection and the "low confidence" skip logic for non-product images both still work acceptably.
5. **Cut over:** Update the default in `orchestrator.ts` (or just replace the file), update README + `.env.local.example`, remove/relegate `ANTHROPIC_API_KEY` per §9.
6. **Optional:** Keep the old Claude-backed implementation available behind an env flag (`VISION_PROVIDER=gemini|claude`) for one release cycle as a safety net, then delete once confidence is high.

Estimated effort: **half a day to a day**, mostly in step 1 (SDK verification) and step 4 (manual accuracy spot-check) — the actual code change is small given the existing seam.

---

## 8. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Flash-Lite is less accurate than Opus 4.8 at brand/logo recognition on stylized or low-quality Pinterest photos | Do the side-by-side spot-check in step 4 before cutover; the `confidence` field + existing "skip low-confidence pins" logic already absorbs uncertain identifications gracefully — worst case is more pins showing `medium`/`low` rather than wrong data reaching retailers |
| Free-tier rate limits throttle a burst (e.g. a 50-pin board submitted all at once) | The pipeline already rate-limits vision calls via `p-queue` at concurrency 5 (`VISION_CONCURRENCY`); add 429-aware retry/backoff on the Gemini call path, matching the pattern already used in `lib/retailers/types.ts` (`fetchWithRetryOn429`) |
| Google's JSON schema subset differs slightly from Zod/OpenAPI (e.g. `nullable` handling) | Keep the Zod schema as a post-hoc validator on Gemini's response, same as today's `response.parsed_output` guarantee, rather than trusting `responseSchema` blindly |
| Pinterest image URLs may not be fetchable by Google's servers the same way they are by Anthropic's (hotlink/CORS/expiry differences) | Confirm in the step-1 spike; the existing `imageSource()` base64 fallback for uploaded images already covers the case where a bare URL doesn't work |
| Vendor lock-in / one more API key to manage | Same friction as today's Anthropic key; document clearly in README's existing "required vs optional" key table |
| Pricing/free-tier terms change (Google moves faster here than Anthropic) | Keep the vision call behind the same narrow interface so a future re-swap (to a different Gemini tier, or back to Claude, or to a self-hosted model) touches one file again |

---

## 9. Open Questions for Decision

1. **Keep Claude as an optional fallback provider**, selectable via env var, or fully remove the Anthropic dependency from this stage? (Recommendation: keep it behind a flag for one release, since the codebase already treats provider keys as optional/graceful-degradation throughout.)
2. **Flash-Lite vs. Flash-Lite's newer sibling (`gemini-3.1-flash-lite`)** — recommend starting on 2.5 Flash-Lite for the lowest cost today, but revisit if 2.5 approaches deprecation.
3. Is it worth extending this cost-minimization pass to the retailer layer (SerpApi/Rainforest are paid; eBay Browse is free) in a follow-up proposal, or is identification the only in-scope target for now?

---

## 10. Appendix: Pricing Snapshot (as fetched 2026-07-11)

| Model | Input $/MTok | Output $/MTok |
|---|---:|---:|
| `claude-opus-4-8` | $5.00 | $25.00 |
| `claude-sonnet-5` | $3.00 ($2.00 intro) | $15.00 ($10.00 intro) |
| `claude-haiku-4-5` | $1.00 | $5.00 |
| `gemini-3.5-flash` | $1.50 | $9.00 |
| `gemini-3.1-flash-lite` | $0.25 | $1.50 |
| `gemini-2.5-flash` | $0.30 | $2.50 |
| **`gemini-2.5-flash-lite`** | **$0.10** | **$0.40** |

Sources: Anthropic pricing table (skill-cached 2026-06-24) and `ai.google.dev/gemini-api/docs/pricing` (fetched live 2026-07-11). Re-verify both before implementation — pricing is not contractual and both vendors revise it.
