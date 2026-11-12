import { Type } from "@google/genai";
import { z } from "zod";
import { ServiceError } from "@/lib/errors";
import type { DetectedItem, RetailerListing } from "@/lib/types";
import { cropImage } from "@/lib/crop";
import { generateJson, imagePart, type GeminiHooks } from "./gemini";

/**
 * Visual check: show Gemini the pin photo plus candidate product thumbnails
 * and have it score each candidate against the target item on type, color
 * and pattern. Title matching alone can't tell a red plaid shirt from a
 * blue one when the listing title just says "flannel shirt".
 */

export const MAX_CANDIDATES = 10;
export const VERIFIED_THRESHOLD = 0.6;
const THUMB_TIMEOUT_MS = 5000;

const VerdictSchema = z.object({
  verdicts: z.array(
    z.object({
      candidate: z.number(),
      sameItemType: z.boolean(),
      colorMatch: z.number(),
      patternMatch: z.number(),
      overall: z.number(),
      exactProduct: z.boolean().nullish(),
      reason: z.string(),
    }),
  ),
});

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    verdicts: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          candidate: { type: Type.INTEGER },
          sameItemType: { type: Type.BOOLEAN },
          colorMatch: { type: Type.NUMBER },
          patternMatch: { type: Type.NUMBER },
          overall: { type: Type.NUMBER },
          exactProduct: { type: Type.BOOLEAN },
          reason: { type: Type.STRING },
        },
        required: ["candidate", "sameItemType", "colorMatch", "patternMatch", "overall", "exactProduct", "reason"],
      },
    },
  },
  required: ["verdicts"],
};

function describe(item: DetectedItem): string {
  return [
    `"${item.productName}"`,
    `type: ${item.itemType}`,
    `color: ${item.colors.join(", ") || "unspecified"}`,
    `pattern: ${item.pattern}`,
    item.attributes.length ? `details: ${item.attributes.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("; ");
}

/** The target item cut out of the pin photo, when Gemini gave us its box. */
async function closeUpPart(
  pin: { inlineData: { mimeType: string; data: string } },
  item: DetectedItem,
): Promise<{ inlineData: { mimeType: string; data: string } } | null> {
  if (!item.box) return null;
  try {
    const out = await cropImage(Buffer.from(pin.inlineData.data, "base64"), item.box);
    return { inlineData: { mimeType: "image/jpeg", data: out.toString("base64") } };
  } catch {
    return null; // the full photo is still there
  }
}

/**
 * Returns the candidates that passed, with matchConfidence replaced by the
 * visual score. Throws ServiceError if Gemini is unavailable (caller falls
 * back to text-only ranking).
 */
export async function verifyMatches(
  pinImageUrl: string,
  item: DetectedItem,
  candidates: RetailerListing[],
  hooks: GeminiHooks = {},
): Promise<{ passed: RetailerListing[]; checked: number }> {
  // Fetch the pin and the thumbnails in parallel; candidates without a usable image are dropped.
  const pinPartP = imagePart(pinImageUrl);
  pinPartP.catch(() => {}); // awaited below; avoid an unhandled rejection meanwhile
  const withImages = (
    await Promise.all(
      candidates.slice(0, MAX_CANDIDATES).map(async (c) => {
        if (!c.imageUrl) return null;
        try {
          return { listing: c, part: await imagePart(c.imageUrl, THUMB_TIMEOUT_MS) };
        } catch {
          return null;
        }
      }),
    )
  ).filter((x): x is NonNullable<typeof x> => x !== null);
  if (withImages.length === 0) return { passed: [], checked: 0 };

  const pinPart = await pinPartP;
  const parts: Array<Record<string, unknown>> = [
    {
      text: `TARGET: the following photo contains this item: ${describe(item)}. Look only at that item in the photo and ignore everything else in it.`,
    },
    pinPart,
  ];
  const closeUp = await closeUpPart(pinPart, item);
  if (closeUp) parts.push({ text: "Close-up of the target item, cropped from the same photo:" }, closeUp);
  parts.push(
    {
      text: `Below are ${withImages.length} candidate products, numbered 1-${withImages.length}. For EACH candidate judge whether a shopper who wants the target item would accept it as the same look (not necessarily the same brand):
- sameItemType: same kind of product (a cardigan is not a crewneck sweater; ankle boots are not sneakers; a set or bundle is not the single item).
- colorMatch 0-1: 1 = same color/shade, 0.5 = same color family but noticeably different shade, 0 = different color.
- patternMatch 0-1: 1 = same pattern (or both solid), 0 = different pattern.
- exactProduct: true only if it is very likely the exact same product (same design, cut, details and print placement, as if from the same maker), not merely similar. When unsure, false.
- overall 0-1: how good a substitute it is. If sameItemType is false or colorMatch < 0.5, overall must be below 0.4. Visible silhouette differences (short vs long sleeves, zip vs buttons, cropped vs full length, wide vs skinny leg) should bring overall down to 0.5-0.65.
- reason: max 10 words.`,
    },
  );
  withImages.forEach((w, i) => {
    parts.push({ text: `Candidate ${i + 1}: "${w.listing.title}"` }, w.part);
  });

  const raw = await generateJson(parts, RESPONSE_SCHEMA, hooks);
  let parsed: z.infer<typeof VerdictSchema>;
  try {
    parsed = VerdictSchema.parse(JSON.parse(raw));
  } catch {
    throw new ServiceError("Gemini", "bad_response", "Gemini's visual check returned an unreadable answer.");
  }

  const passed: RetailerListing[] = [];
  for (const v of parsed.verdicts) {
    const w = withImages[v.candidate - 1];
    if (!w) continue;
    const score = v.sameItemType ? Math.max(0, Math.min(1, v.overall)) : 0;
    const exact = !!v.exactProduct && v.sameItemType;
    if (score >= VERIFIED_THRESHOLD || exact) {
      passed.push({ ...w.listing, matchConfidence: Math.max(score, exact ? 0.9 : 0), matchReason: v.reason, exact });
    }
  }
  return { passed, checked: withImages.length };
}
