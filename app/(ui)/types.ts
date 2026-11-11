import type { JobHalt, PinResult, Usage } from "@/lib/types";

export type StatusResponse = {
  status: "running" | "done" | "error";
  totalPins: number;
  processedPins: number;
  truncated: boolean;
  boardName?: string;
  results: PinResult[];
  usage: Usage;
  halt?: JobHalt;
  geminiRpm?: number;
  error?: string;
};

/** GET /api/usage */
export type AccountUsage = {
  serpapi: null | {
    error?: string;
    plan?: string;
    searchesPerMonth?: number;
    searchesLeft?: number;
    usedThisMonth?: number;
    renewsOn?: string;
    thisHour?: number;
    hourlyLimit?: number;
  };
  configured: { gemini: boolean; serpapi: boolean; ebay: boolean };
};

/** "2026-11-13" → "Nov 13" */
export function shortDate(isoDay: string | undefined): string | null {
  if (!isoDay) return null;
  const d = new Date(`${isoDay.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** Price-search allowance as the UI talks about it. */
export function allowance(account: AccountUsage | null) {
  const s = account?.serpapi;
  const left = s?.searchesLeft;
  const total = s?.searchesPerMonth;
  return {
    known: typeof left === "number",
    left,
    total,
    out: typeof left === "number" && left <= 0,
    renews: shortDate(s?.renewsOn),
  };
}

export function lensUrl(imageUrl: string): string | null {
  return /^https?:\/\//i.test(imageUrl)
    ? `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(imageUrl)}`
    : null;
}

/** "https://www.pinterest.com/whowhatwear/nyc-style/" → "Nyc Style" */
export function boardNameFromUrl(url: string): string {
  const slug = url.match(/pinterest\.[a-z.]+\/[^/]+\/([^/?#]+)/i)?.[1];
  if (!slug) return "Your board";
  let name = slug;
  try {
    name = decodeURIComponent(slug);
  } catch {
    // keep the raw slug
  }
  return name.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
