import type { Pin } from "@/lib/types";

export const MAX_PINS = 50; // cap per board; UI shows a note when a board is truncated

export type BoardFetchResult = {
  pins: Pin[];
  truncated: boolean;
  source: "scrape" | "fallback";
  boardName?: string; // the board's own title, when known
};

/** Extract {username, slug} from a board URL like https://www.pinterest.com/user/board-name/ */
export function parseBoardUrl(
  boardUrl: string,
): { username: string; slug: string } | null {
  try {
    const url = new URL(boardUrl);
    if (!/(^|\.)pinterest\.[a-z.]+$/.test(url.hostname)) return null;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    // /pin/<id>/, /search/..., /ideas/... etc. are not boards
    if (["pin", "search", "ideas", "today", "_"].includes(parts[0])) return null;
    return { username: decodeURIComponent(parts[0]), slug: decodeURIComponent(parts[1]) };
  } catch {
    return null;
  }
}

/** Fallback path: normalize a list of direct image URLs (pasted or uploaded) into Pin[]. */
export function pinsFromImageUrls(imageUrls: string[]): BoardFetchResult {
  const unique = [...new Set(imageUrls.map((u) => u.trim()).filter(Boolean))];
  const capped = unique.slice(0, MAX_PINS);
  return {
    pins: capped.map((imageUrl, i) => ({ pinId: `upload-${i}`, imageUrl })),
    truncated: unique.length > MAX_PINS,
    source: "fallback",
  };
}
