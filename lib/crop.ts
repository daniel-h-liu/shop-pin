import type { DetectedItem } from "@/lib/types";

/**
 * Cropping one item out of a pin photo so Google Lens searches just that
 * piece (like drawing a box in Lens by hand). SerpApi fetches images by URL,
 * so the crop is served from our own /api/crop endpoint, which only works
 * when the server has a public address (on Render: RENDER_EXTERNAL_URL).
 */

type Box = NonNullable<DetectedItem["box"]>;

/** Only Pinterest's image CDN, so /api/crop can't be used to fetch arbitrary URLs. */
const ALLOWED_HOSTS = new Set(["i.pinimg.com"]);
/** Extra room around Gemini's box (fraction of the box size per side). */
const PADDING = 0.08;
const MAX_SIDE = 900;

export function publicBaseUrl(): string | undefined {
  const raw = process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL;
  if (!raw || !/^https:\/\//i.test(raw)) return undefined;
  return raw.replace(/\/+$/, "");
}

export function isCroppableSource(src: string): boolean {
  try {
    const u = new URL(src);
    return u.protocol === "https:" && ALLOWED_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

/** Public URL of the item's crop, or undefined when cropping isn't possible here. */
export function cropUrlFor(imageUrl: string, box: DetectedItem["box"], base = publicBaseUrl()): string | undefined {
  if (!box || !base || !isCroppableSource(imageUrl)) return undefined;
  const qs = new URLSearchParams({ src: imageUrl, box: box.join(",") });
  return `${base}/api/crop?${qs}`;
}

export function parseBox(raw: string | null): Box | undefined {
  const parts = (raw ?? "").split(",").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 1000)) return undefined;
  const [y0, x0, y1, x1] = parts;
  if (y1 <= y0 || x1 <= x0) return undefined;
  return [y0, x0, y1, x1];
}

/** Pixel rectangle for a 0-1000 box on a width×height image, padded and clamped. */
export function boxToRegion(box: Box, width: number, height: number) {
  const [y0, x0, y1, x1] = box;
  const padX = ((x1 - x0) / 1000) * width * PADDING;
  const padY = ((y1 - y0) / 1000) * height * PADDING;
  const left = Math.max(0, Math.floor((x0 / 1000) * width - padX));
  const top = Math.max(0, Math.floor((y0 / 1000) * height - padY));
  const right = Math.min(width, Math.ceil((x1 / 1000) * width + padX));
  const bottom = Math.min(height, Math.ceil((y1 / 1000) * height + padY));
  return { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

export async function cropImage(input: Buffer, box: Box): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  const img = sharp(input).rotate(); // respect EXIF orientation
  const meta = await img.metadata();
  const w = meta.autoOrient?.width ?? meta.width;
  const h = meta.autoOrient?.height ?? meta.height;
  if (!w || !h) throw new Error("Unreadable image");
  return img
    .extract(boxToRegion(box, w, h))
    .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 88 })
    .toBuffer();
}
