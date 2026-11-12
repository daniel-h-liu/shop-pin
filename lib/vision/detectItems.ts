import { Type } from "@google/genai";
import { z } from "zod";
import { ServiceError } from "@/lib/errors";
import type { DetectedItem, Pin, ProductID } from "@/lib/types";
import { generateJson, imagePart, type GeminiHooks } from "./gemini";

export const MAX_ITEMS_PER_PIN = 6;

const ItemSchema = z.object({
  itemType: z.string(),
  category: z.string(),
  name: z.string(),
  colors: z.array(z.string()),
  pattern: z.string(),
  attributes: z.array(z.string()),
  gender: z.string().nullish(),
  brand: z.string().nullish(),
  typeKeywords: z.array(z.string()),
  searchQuery: z.string(),
  box_2d: z.array(z.number()).nullish(),
});

const DetectionSchema = z.object({
  confidence: z.enum(["high", "medium", "low"]),
  items: z.array(ItemSchema),
});

export type Detection = {
  confidence: ProductID["confidence"];
  items: DetectedItem[];
};

const PROMPT = `You are a shopping assistant doing Pinterest-style "shop the look": find every distinct purchasable item in this image so each can be searched on Google Shopping separately.

Rules:
- List each item separately, most prominent first, at most ${MAX_ITEMS_PER_PIN}. For an outfit photo that means each garment and accessory on its own (e.g. jacket, sweater, shirt, jeans, boots, hat, bag, belt, sunglasses, watch). NEVER describe a whole outfit as one item.
- Only include items that are clearly visible and large enough to describe accurately. Skip hidden or tiny ones.
- Describe what is actually in the photo, not what the caption says.

For each item:
- itemType: the specific product type in 1-3 words, e.g. "chore jacket", "crewneck sweater", "straight-leg jeans", "chelsea boots", "bucket hat", "table lamp".
- category: one of top, outerwear, bottoms, dress, footwear, bag, hat, accessory, jewelry, home decor, furniture, lighting, kitchen, beauty, other.
- name: short descriptive name, e.g. "Navy cable-knit crewneck sweater".
- colors: main color(s) in common retail color words, e.g. "navy", "camel", "olive", "cream", "charcoal", "rust". Be precise about the shade.
- pattern: "solid" or the specific pattern, e.g. "pinstripe", "buffalo plaid", "houndstooth", "floral", "cable knit", "fair isle".
- attributes: 3-6 short keywords for material, fit/silhouette and distinctive details, e.g. "wool", "oversized", "cropped", "quarter-zip", "wide-leg", "chunky sole".
- gender: "men", "women" or "unisex" for apparel, null otherwise.
- brand: only if a logo or label is legible, otherwise null.
- typeKeywords: 2-5 lowercase single words, at least one of which would appear in the title of ANY store listing for this kind of item (the type plus synonyms), e.g. ["sweater","pullover","jumper","knit"] or ["boots","boot","chelsea"].
- box_2d: a tight bounding box around this item in the image as [ymin, xmin, ymax, xmax], each normalized to 0-1000.
- searchQuery: a Google Shopping query of 3-8 words built as gender + color + pattern (omit if solid) + key material/detail + item type, e.g. "men's olive suede chelsea boots", "women's cream cable knit crewneck sweater". No brand unless legible. No vague words like "stylish" or "outfit".

confidence: "low" if the image contains no purchasable product (quote or text graphic, meme, landscape, infographic, abstract art) and return no items; "high" if the items are clear; "medium" otherwise.`;

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    confidence: { type: Type.STRING, format: "enum", enum: ["high", "medium", "low"] },
    items: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          itemType: { type: Type.STRING },
          category: { type: Type.STRING },
          name: { type: Type.STRING },
          colors: { type: Type.ARRAY, items: { type: Type.STRING } },
          pattern: { type: Type.STRING },
          attributes: { type: Type.ARRAY, items: { type: Type.STRING } },
          gender: { type: Type.STRING, nullable: true },
          brand: { type: Type.STRING, nullable: true },
          typeKeywords: { type: Type.ARRAY, items: { type: Type.STRING } },
          searchQuery: { type: Type.STRING },
          box_2d: { type: Type.ARRAY, items: { type: Type.NUMBER } },
        },
        required: [
          "itemType",
          "category",
          "name",
          "colors",
          "pattern",
          "attributes",
          "typeKeywords",
          "searchQuery",
          "box_2d",
        ],
      },
    },
  },
  required: ["confidence", "items"],
};

/** Validate Gemini's [ymin, xmin, ymax, xmax] (0-1000); drop anything unusable. */
export function toBox(raw: number[] | null | undefined): DetectedItem["box"] {
  if (!raw || raw.length !== 4 || raw.some((n) => !Number.isFinite(n))) return undefined;
  const [y0, x0, y1, x1] = raw.map((n) => Math.max(0, Math.min(1000, Math.round(n))));
  if (y1 - y0 < 20 || x1 - x0 < 20) return undefined; // degenerate / tiny
  if (y1 - y0 > 990 && x1 - x0 > 990) return undefined; // whole image: cropping adds nothing
  return [y0, x0, y1, x1];
}

/** One Gemini call per pin: every purchasable item in the image. */
export async function detectItems(pin: Pin, hooks: GeminiHooks = {}): Promise<Detection> {
  const text = pin.title
    ? `${PROMPT}\n\nPin caption (context only, may be inaccurate): "${pin.title}"`
    : PROMPT;
  const image = await imagePart(pin.imageUrl);

  let parsed: z.infer<typeof DetectionSchema> | null = null;
  for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
    const raw = await generateJson([{ text }, image], RESPONSE_SCHEMA, hooks);
    try {
      parsed = DetectionSchema.parse(JSON.parse(raw));
    } catch {
      // malformed JSON / schema drift: one retry
    }
  }
  if (!parsed) {
    throw new ServiceError("Gemini", "bad_response", "Gemini's answer for this image couldn't be read.");
  }

  const items: DetectedItem[] = parsed.items.slice(0, MAX_ITEMS_PER_PIN).map((it, i) => {
    const pattern = it.pattern.trim().toLowerCase() || "solid";
    const typeKeywords = [
      ...new Set(
        [...it.typeKeywords, ...it.itemType.split(/\s+/)]
          .map((k) => k.toLowerCase().replace(/[^a-z0-9-]/g, ""))
          .filter((k) => k.length > 2),
      ),
    ];
    return {
      itemId: `${pin.pinId}#${i}`,
      pinId: pin.pinId,
      productName: it.name,
      itemType: it.itemType,
      category: it.category.toLowerCase(),
      brand: it.brand || undefined,
      colors: it.colors,
      pattern,
      attributes: [it.gender, ...it.colors, pattern === "solid" ? null : pattern, ...it.attributes].filter(
        (a): a is string => !!a,
      ),
      typeKeywords,
      searchQuery: it.searchQuery,
      box: toBox(it.box_2d),
      confidence: parsed!.confidence,
      search: { status: "idle", deals: [] },
    };
  });

  return { confidence: items.length ? parsed.confidence : "low", items };
}
