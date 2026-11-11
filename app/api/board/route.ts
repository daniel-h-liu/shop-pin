import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { pinsFromImageUrls, type BoardFetchResult } from "@/lib/pinterest/fetchBoard";
import { BoardScrapeError, scrapePublicBoard } from "@/lib/pinterest/scrapeBoard";
import { verifyTurnstile } from "@/lib/turnstile";
import { createJob } from "@/lib/pipeline/jobs";
import { runPipeline } from "@/lib/pipeline/orchestrator";
import { describeError } from "@/lib/errors";

export const runtime = "nodejs";

type BoardRequest = {
  boardUrl?: string;
  imageUrls?: string[]; // fallback path: pasted/uploaded image URLs (or data: URIs)
  turnstileToken?: string; // Cloudflare Turnstile bot-check token
};

/**
 * POST /api/board — accepts { boardUrl } or { imageUrls }, kicks off the
 * pipeline asynchronously, and returns a jobId immediately. The frontend
 * polls GET /api/board/[jobId]/status.
 */
export async function POST(req: Request) {
  let body: BoardRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const ip = req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const human = await verifyTurnstile(body.turnstileToken, ip);
  if (!human.ok) {
    return NextResponse.json({ error: human.message, botCheckFailed: true }, { status: 403 });
  }

  let board: BoardFetchResult;
  try {
    if (body.imageUrls?.length) {
      board = pinsFromImageUrls(body.imageUrls);
    } else if (body.boardUrl) {
      board = await scrapePublicBoard(body.boardUrl);
    } else {
      return NextResponse.json(
        { error: "Provide boardUrl or imageUrls" },
        { status: 400 },
      );
    }
  } catch (err) {
    const status =
      err instanceof BoardScrapeError
        ? err.kind === "invalid_url"
          ? 400
          : err.kind === "not_found" || err.kind === "private" || err.kind === "empty"
            ? 404
            : 502
        : 502;
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : "Failed to fetch board",
        fallbackAvailable: true,
      },
      { status },
    );
  }

  const jobId = randomUUID();
  const job = createJob(jobId, board.pins.length, board.truncated);
  job.boardName = board.boardName;

  if (board.pins.length === 0) {
    job.status = "done";
  } else {
    // Fire and forget — don't block the HTTP response on the full pipeline.
    runPipeline(board.pins, job).catch((err) => {
      job.status = "error";
      job.error = describeError(err, "Pipeline");
    });
  }

  return NextResponse.json({
    jobId,
    totalPins: board.pins.length,
    truncated: board.truncated,
    source: board.source,
  });
}
