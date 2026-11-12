import { NextResponse } from "next/server";
import { getJob } from "@/lib/pipeline/jobs";
import { searchItem } from "@/lib/pipeline/orchestrator";

export const runtime = "nodejs";

/**
 * POST /api/board/[jobId]/search { pinId, itemId } — search retailers for
 * one detected item and visually verify the matches.
 *
 * Streams newline-delimited JSON, one line per update, each
 * { result, usage } (the updated pin result and the board's usage counters):
 * first when the search results are in (item status "checking"), then the
 * final one after the visual check ("done" / "error").
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
  const { pinId, itemId } = body;
  if (!pinId || !itemId) {
    return NextResponse.json({ error: "Provide pinId and itemId" }, { status: 400 });
  }
  if (!job.results[pinId]?.items.some((i) => i.itemId === itemId)) {
    return NextResponse.json({ error: "Item not found" }, { status: 404 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = () => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify({ result: job.results[pinId], usage: job.usage }) + "\n"));
        } catch {
          // client went away; the search still finishes and is cached
        }
      };
      await searchItem(job, pinId, itemId, { onProgress: send });
      send();
      try {
        controller.close();
      } catch {
        // already closed
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no", // don't let a proxy hold back the first update
    },
  });
}
