import { NextResponse } from "next/server";
import { getJob } from "@/lib/pipeline/jobs";
import { searchItem } from "@/lib/pipeline/orchestrator";

export const runtime = "nodejs";

/**
 * POST /api/board/[jobId]/search { pinId, itemId } — search retailers for
 * one detected item and visually verify the matches. Returns the updated
 * pin result and the board's usage counters.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params;
  const job = getJob(jobId);
  if (!job) {
    return NextResponse.json({ error: "Job not found (the server may have restarted). Run the board again." }, { status: 404 });
  }
  let body: { pinId?: string; itemId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.pinId || !body.itemId) {
    return NextResponse.json({ error: "Provide pinId and itemId" }, { status: 400 });
  }
  const item = await searchItem(job, body.pinId, body.itemId);
  if (!item) return NextResponse.json({ error: "Item not found" }, { status: 404 });
  return NextResponse.json({ result: job.results[body.pinId], usage: job.usage });
}
