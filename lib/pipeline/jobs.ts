import { emptyUsage, type JobState } from "@/lib/types";

/**
 * In-memory job store, polled by the frontend for per-pin progress.
 * NOTE: single-instance only — this needs Redis or a DB if deployed across
 * multiple server processes. Stored on globalThis so Next.js dev hot-reloads
 * don't wipe running jobs.
 */

const g = globalThis as unknown as { __pdfJobs?: Map<string, JobState> };
const jobs: Map<string, JobState> = g.__pdfJobs ?? (g.__pdfJobs = new Map());

const JOB_TTL_MS = 2 * 60 * 60 * 1000; // evict finished jobs after 2h

export function createJob(jobId: string, totalPins: number, truncated: boolean): JobState {
  const job: JobState = {
    jobId,
    createdAt: Date.now(),
    status: "running",
    totalPins,
    processedPins: 0,
    truncated,
    results: {},
    usage: emptyUsage(),
  };
  jobs.set(jobId, job);
  evictStale();
  return job;
}

export function getJob(jobId: string): JobState | undefined {
  return jobs.get(jobId);
}

function evictStale(): void {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.status !== "running" && now - job.createdAt > JOB_TTL_MS) {
      jobs.delete(id);
    }
  }
}
