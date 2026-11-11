import { NextResponse } from "next/server";
import { getJob } from "@/lib/pipeline/jobs";
import { countProcessed } from "@/lib/pipeline/orchestrator";
import { GEMINI_RPM } from "@/lib/vision/gemini";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/board/[jobId]/status — progress, per-pin results so far, API
 * usage for this board, and any quota halt. Polled every 1-2s while running.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params;
  const job = getJob(jobId);
  if (!job) {
    return NextResponse.json({ error: "Job not found (the server may have restarted). Run the board again." }, { status: 404 });
  }
  return NextResponse.json({
    jobId: job.jobId,
    status: job.status,
    totalPins: job.totalPins,
    processedPins: countProcessed(job),
    truncated: job.truncated,
    boardName: job.boardName,
    results: Object.values(job.results),
    usage: job.usage,
    halt: job.halt,
    geminiRpm: GEMINI_RPM,
    error: job.error,
  });
}
