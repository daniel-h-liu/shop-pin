import { NextResponse } from "next/server";
import { getJob } from "@/lib/pipeline/jobs";
import { rerunPins } from "@/lib/pipeline/orchestrator";

export const runtime = "nodejs";

/** POST /api/board/[jobId]/rerun — retry pins that were deferred (quota) or failed. */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params;
  const job = getJob(jobId);
  if (!job) {
    return NextResponse.json({ error: "Job not found (the server may have restarted). Run the board again." }, { status: 404 });
  }
  if (job.status === "running") {
    return NextResponse.json({ error: "This board is still being processed." }, { status: 409 });
  }
  if (job.halt?.retryAt && job.halt.retryAt > Date.now()) {
    const mins = Math.ceil((job.halt.retryAt - Date.now()) / 60_000);
    return NextResponse.json(
      { error: `${job.halt.message} Try again in about ${mins >= 60 ? `${Math.round(mins / 60)}h` : `${mins}m`}.` },
      { status: 429 },
    );
  }
  const queued = rerunPins(job);
  return NextResponse.json({ queued });
}
