import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SerpAccount = {
  plan_name?: string;
  searches_per_month?: number;
  plan_searches_left?: number;
  total_searches_left?: number;
  this_month_usage?: number;
  plan_renewal_date?: string;
  this_hour_searches?: number;
  account_rate_limit_per_hour?: number;
};

let cache: { at: number; body: unknown } | null = null;
const CACHE_MS = 20_000;

/**
 * GET /api/usage — account-level quota where the provider exposes it.
 * SerpApi's account endpoint is free (doesn't consume searches). Gemini and
 * eBay have no usage API; their per-board counts come from the job status.
 */
export async function GET() {
  if (cache && Date.now() - cache.at < CACHE_MS) return NextResponse.json(cache.body);

  let serpapi: Record<string, unknown> | null = null;
  const key = process.env.SERPAPI_KEY;
  if (key) {
    try {
      const res = await fetch(`https://serpapi.com/account.json?api_key=${encodeURIComponent(key)}`, {
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const a = (await res.json()) as SerpAccount;
        serpapi = {
          plan: a.plan_name,
          searchesPerMonth: a.searches_per_month,
          searchesLeft: a.total_searches_left ?? a.plan_searches_left,
          usedThisMonth: a.this_month_usage,
          renewsOn: a.plan_renewal_date,
          thisHour: a.this_hour_searches,
          hourlyLimit: a.account_rate_limit_per_hour,
        };
      } else {
        serpapi = { error: `SerpApi account lookup failed (HTTP ${res.status}).` };
      }
    } catch {
      serpapi = { error: "Couldn't reach SerpApi for account usage." };
    }
  }

  const body = {
    serpapi,
    configured: {
      gemini: !!process.env.GEMINI_API_KEY,
      serpapi: !!key,
      ebay: !!process.env.EBAY_APP_ID && !!process.env.EBAY_CERT_ID,
    },
  };
  cache = { at: Date.now(), body };
  return NextResponse.json(body);
}
