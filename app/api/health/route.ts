import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** GET /api/health — cheap liveness check for Render (and any uptime pinger). Spends no API calls. */
export function GET() {
  return NextResponse.json({ ok: true });
}
