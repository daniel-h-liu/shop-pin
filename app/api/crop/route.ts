import { cropImage, isCroppableSource, parseBox } from "@/lib/crop";

export const runtime = "nodejs";

const FETCH_TIMEOUT_MS = 8000;
const MAX_BYTES = 8 * 1024 * 1024;

/**
 * GET /api/crop?src=<pinimg url>&box=ymin,xmin,ymax,xmax (0-1000)
 * Returns one item cut out of a pin photo as a JPEG. Google Lens (through
 * SerpApi) fetches this URL to search just that item.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const src = searchParams.get("src") ?? "";
  const box = parseBox(searchParams.get("box"));
  if (!isCroppableSource(src) || !box) {
    return new Response("Bad crop request", { status: 400 });
  }

  let input: Buffer;
  try {
    const res = await fetch(src, { redirect: "error", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return new Response("Image not found", { status: 404 });
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) return new Response("Image too large", { status: 413 });
    input = Buffer.from(buf);
  } catch {
    return new Response("Couldn't fetch the image", { status: 502 });
  }

  try {
    const out = await cropImage(input, box);
    return new Response(new Uint8Array(out), {
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "public, max-age=604800, immutable",
      },
    });
  } catch {
    return new Response("Couldn't crop the image", { status: 422 });
  }
}
