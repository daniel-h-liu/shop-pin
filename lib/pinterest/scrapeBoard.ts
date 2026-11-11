import type { Pin } from "@/lib/types";
import { MAX_PINS, parseBoardUrl, type BoardFetchResult } from "./fetchBoard";

/**
 * No-auth scraper for PUBLIC Pinterest boards.
 *
 * Uses the same unauthenticated JSON "resource" endpoints pinterest.com's own
 * web client calls when a logged-out visitor opens a board:
 *
 *   BoardResource     {username, slug}  -> board id, pin_count, privacy
 *   BoardFeedResource {board_id, ...}   -> pins (one big page; max ~250)
 *
 * If those fail (Pinterest changes them from time to time), it falls back to
 * the public board RSS feed (https://www.pinterest.com/<user>/<board>.rss),
 * which is stable but only returns the ~25 most recent pins.
 *
 * These are undocumented endpoints — expect occasional breakage and keep
 * request volume low (one board = 1-3 requests).
 */

const ORIGIN = "https://www.pinterest.com";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const REQUEST_TIMEOUT_MS = 10_000;
// Largest page Pinterest honours in one request (observed ~250).
const MAX_PAGE_SIZE = 250;
const FEED_ATTEMPTS = 4;

type FetchFn = typeof fetch;

export type ScrapeOptions = {
  maxPins?: number;
  fetchImpl?: FetchFn;
};

export class BoardScrapeError extends Error {
  constructor(
    message: string,
    readonly kind: "invalid_url" | "not_found" | "private" | "blocked" | "empty",
  ) {
    super(message);
    this.name = "BoardScrapeError";
  }
}

async function timedFetch(fetchImpl: FetchFn, url: string, init: RequestInit = {}) {
  return fetchImpl(url, {
    ...init,
    redirect: init.redirect ?? "follow",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { "User-Agent": USER_AGENT, "Accept-Language": "en-US,en;q=0.9", ...init.headers },
  });
}

/** Expand pin.it short links to their pinterest.com board URL. */
export async function resolveBoardUrl(input: string, fetchImpl: FetchFn = fetch): Promise<string> {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return input;
  }
  if (url.hostname !== "pin.it") return url.toString();
  const res = await timedFetch(fetchImpl, url.toString(), { method: "GET" });
  return res.url || url.toString();
}

async function getResource(
  fetchImpl: FetchFn,
  resource: string,
  sourceUrl: string,
  options: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const qs = new URLSearchParams({
    source_url: sourceUrl,
    data: JSON.stringify({ options, context: {} }),
    _: String(Date.now()),
  });
  const res = await timedFetch(fetchImpl, `${ORIGIN}/resource/${resource}/get/?${qs}`, {
    headers: {
      Accept: "application/json, text/javascript, */*; q=0.01",
      "X-Requested-With": "XMLHttpRequest",
      "X-Pinterest-PWS-Handler": "www/[username]/[slug].js",
    },
  });
  let body: Record<string, unknown> | null = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

type RawPin = {
  type?: string;
  id?: string;
  title?: string;
  grid_title?: string;
  description?: string;
  link?: string | null;
  is_video?: boolean;
  images?: Record<string, { url?: string; width?: number }>;
};

// 736x is plenty for vision ID and much lighter than `orig` (often 4-6k px).
const IMAGE_PREFERENCE = ["736x", "orig", "474x", "564x", "236x"];

function pickImage(pin: RawPin): string | undefined {
  const images = pin.images;
  if (!images) return undefined;
  for (const key of IMAGE_PREFERENCE) {
    if (images[key]?.url) return images[key].url;
  }
  return Object.values(images).find((i) => i?.url)?.url;
}

export function normalizeRawPin(raw: RawPin): Pin | null {
  if (raw.type && raw.type !== "pin") return null; // skip stories/section/ad modules
  if (!raw.id) return null;
  const imageUrl = pickImage(raw);
  if (!imageUrl) return null;
  const title = (raw.title || raw.grid_title || raw.description || "").trim();
  return {
    pinId: raw.id,
    imageUrl,
    title: title || undefined,
    sourceLink: raw.link || undefined,
  };
}

async function scrapeViaResourceApi(
  username: string,
  slug: string,
  maxPins: number,
  fetchImpl: FetchFn,
): Promise<{ pins: Pin[]; totalOnBoard?: number; boardName?: string }> {
  const sourceUrl = `/${username}/${slug}/`;

  const board = await getResource(fetchImpl, "BoardResource", sourceUrl, {
    username,
    slug,
    field_set_key: "detailed",
  });
  const boardData = (board.body?.resource_response as { data?: Record<string, unknown> } | undefined)
    ?.data;
  if (!boardData?.id) {
    // Pinterest answers 403/404 with an empty data payload for missing or private boards.
    if (board.status === 403 || board.status === 404) {
      throw new BoardScrapeError(
        `Board "${username}/${slug}" wasn't found, or it's private. Only public boards can be scraped.`,
        "not_found",
      );
    }
    throw new BoardScrapeError(`Unexpected BoardResource response (HTTP ${board.status})`, "blocked");
  }
  if (boardData.privacy && boardData.privacy !== "public") {
    throw new BoardScrapeError("This board is private. Only public boards can be scraped.", "private");
  }

  const boardId = String(boardData.id);
  const totalOnBoard = typeof boardData.pin_count === "number" ? boardData.pin_count : undefined;

  // Logged-out bookmark pagination returns empty pages, so ask for everything
  // we need in one request. Pinterest intermittently answers with a short
  // ~25-item page instead; retry a couple of times and keep the best result.
  const wanted = Math.min(maxPins, totalOnBoard ?? maxPins);
  // Size the page to what the board actually holds: asking for far more than
  // pin_count makes the short-response failure much more likely.
  const pageSize = Math.min(MAX_PAGE_SIZE, wanted + 10); // slack for non-pin feed items
  let best: Pin[] = [];
  for (let attempt = 0; attempt < FEED_ATTEMPTS && best.length < wanted; attempt++) {
    const feed = await getResource(fetchImpl, "BoardFeedResource", sourceUrl, {
      board_id: boardId,
      board_url: sourceUrl,
      page_size: pageSize,
      field_set_key: "react_grid_pin",
      filter_section_pins: false,
      bookmarks: [],
    });
    const rr = feed.body?.resource_response as { data?: RawPin[] } | undefined;
    if (!rr || !Array.isArray(rr.data)) {
      if (attempt === 0) {
        throw new BoardScrapeError(`Unexpected BoardFeedResource response (HTTP ${feed.status})`, "blocked");
      }
      continue;
    }
    const pins = dedupe(rr.data.map(normalizeRawPin)).slice(0, maxPins);
    if (pins.length > best.length) best = pins;
  }
  const boardName = typeof boardData.name === "string" && boardData.name.trim() ? boardData.name.trim() : undefined;
  return { pins: best, totalOnBoard, boardName };
}

function dedupe(pins: Array<Pin | null>): Pin[] {
  const seen = new Set<string>();
  return pins.filter((p): p is Pin => !!p && !seen.has(p.pinId) && !!seen.add(p.pinId));
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Parse Pinterest's board RSS. Upgrades 236x thumbnails to 736x. */
export function parseBoardRss(xml: string): Pin[] {
  const pins: Pin[] = [];
  for (const [, item] of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const link = item.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim();
    const title = decodeEntities(item.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim() ?? "");
    const desc = decodeEntities(item.match(/<description>([\s\S]*?)<\/description>/)?.[1] ?? "");
    const img = desc.match(/<img[^>]+src="([^"]+)"/)?.[1];
    const pinId = link?.match(/\/pin\/([^/]+)/)?.[1];
    if (!img || !pinId) continue;
    pins.push({
      pinId,
      imageUrl: img.replace(/i\.pinimg\.com\/\d+x\//, "i.pinimg.com/736x/"),
      title: title || undefined,
    });
  }
  return pins;
}

async function scrapeViaRss(
  username: string,
  slug: string,
  fetchImpl: FetchFn,
): Promise<Pin[]> {
  const res = await timedFetch(fetchImpl, `${ORIGIN}/${username}/${slug}.rss`);
  if (res.status === 404) {
    throw new BoardScrapeError(`Board "${username}/${slug}" wasn't found, or it's private.`, "not_found");
  }
  if (!res.ok) throw new BoardScrapeError(`Board RSS returned HTTP ${res.status}`, "blocked");
  return parseBoardRss(await res.text());
}

/**
 * Scrape a public board URL into Pin[] (no Pinterest credentials needed).
 * Returns at most `maxPins` (default MAX_PINS) — the most recent pins first.
 */
export async function scrapePublicBoard(
  boardUrl: string,
  { maxPins = MAX_PINS, fetchImpl = fetch }: ScrapeOptions = {},
): Promise<BoardFetchResult> {
  const resolved = await resolveBoardUrl(boardUrl, fetchImpl);
  const parsed = parseBoardUrl(resolved);
  if (!parsed) {
    throw new BoardScrapeError(
      "That doesn't look like a Pinterest board link. Expected something like https://www.pinterest.com/username/board-name/",
      "invalid_url",
    );
  }
  const { username, slug } = parsed;

  let pins: Pin[];
  let totalOnBoard: number | undefined;
  let boardName: string | undefined;
  try {
    ({ pins, totalOnBoard, boardName } = await scrapeViaResourceApi(username, slug, maxPins, fetchImpl));
  } catch (err) {
    // A definite "missing/private" answer won't be fixed by RSS; anything else might.
    if (err instanceof BoardScrapeError && (err.kind === "not_found" || err.kind === "private")) throw err;
    pins = (await scrapeViaRss(username, slug, fetchImpl)).slice(0, maxPins);
    totalOnBoard = undefined;
  }

  if (pins.length === 0) {
    throw new BoardScrapeError("No image pins found on that board.", "empty");
  }

  const truncated =
    totalOnBoard !== undefined ? totalOnBoard > pins.length : pins.length >= maxPins;
  return { pins, truncated, source: "scrape", boardName };
}
