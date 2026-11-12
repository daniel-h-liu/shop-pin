import { GoogleGenAI } from "@google/genai";
import PQueue from "p-queue";
import { ServiceError, untilPacificMidnight } from "@/lib/errors";

const SERVICE = "Gemini";

// Override with GEMINI_MODEL when Google retires a model (they do, often).
export const MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";

// Free tier is 15 requests/minute for flash-lite. Pace requests evenly so a
// 50-pin board doesn't burst into 429s. Raise GEMINI_RPM on a paid tier.
export const GEMINI_RPM = Number(process.env.GEMINI_RPM) || 15;
const MAX_RATE_LIMIT_RETRIES = 3;
const IMAGE_FETCH_TIMEOUT_MS = 8000;
const SUPPORTED_MIME = /^image\/(jpeg|png|webp|heic|heif)$/;

// Shared across all jobs (and dev hot reloads): the limit is per API key.
const g = globalThis as unknown as {
  __pdfGeminiQueue?: PQueue;
  __pdfGeminiBlockedUntil?: number;
};
const queue: PQueue =
  g.__pdfGeminiQueue ??
  (g.__pdfGeminiQueue = new PQueue({
    concurrency: 4,
    intervalCap: 1,
    interval: Math.ceil(60_000 / GEMINI_RPM),
  }));

let _client: GoogleGenAI | null = null;
function client(): GoogleGenAI {
  if (!process.env.GEMINI_API_KEY) {
    throw new ServiceError(SERVICE, "auth", "GEMINI_API_KEY isn't set, so images can't be analyzed.");
  }
  if (!_client) _client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return _client;
}

function dailyQuotaError(): ServiceError {
  const reset = untilPacificMidnight();
  return new ServiceError(
    SERVICE,
    "quota",
    `Gemini's free-tier daily request limit is used up. It resets at midnight Pacific time (in ${reset.label}).`,
    Math.ceil(reset.ms / 1000),
  );
}

/** Translate a Gemini SDK error (raw JSON in .message) into a ServiceError. */
export function classifyGeminiError(err: unknown): ServiceError {
  if (err instanceof ServiceError) return err;
  const status = (err as { status?: number })?.status;
  const msg = err instanceof Error ? err.message : String(err);
  if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
    return new ServiceError(SERVICE, "timeout", "Gemini didn't respond in time.");
  }

  if (status === 429 || /RESOURCE_EXHAUSTED/.test(msg)) {
    const quotaId = msg.match(/"quotaId"\s*:\s*"([^"]+)"/)?.[1] ?? "";
    if (/PerDay/i.test(quotaId) || /per day/i.test(msg)) return dailyQuotaError();
    const delay =
      Number(msg.match(/"retryDelay"\s*:\s*"([\d.]+)s"/)?.[1]) ||
      Number(msg.match(/retry in ([\d.]+)s/i)?.[1]) ||
      20;
    return new ServiceError(
      SERVICE,
      "rate_limit",
      `Gemini's free-tier per-minute limit (${GEMINI_RPM}/min) was hit. Try again in about ${Math.ceil(delay)}s.`,
      Math.ceil(delay),
    );
  }
  if (status === 404 && /model/i.test(msg)) {
    return new ServiceError(
      SERVICE,
      "config",
      `Gemini model "${MODEL}" isn't available to this API key. Set GEMINI_MODEL in .env.local to a current model.`,
    );
  }
  if (status === 400 && /API key/i.test(msg)) {
    return new ServiceError(SERVICE, "auth", "Gemini rejected the API key (GEMINI_API_KEY).");
  }
  if (status === 401 || status === 403) {
    return new ServiceError(SERVICE, "auth", "Gemini rejected the API key (GEMINI_API_KEY).");
  }
  if (status && status >= 500) {
    return new ServiceError(SERVICE, "rate_limit", "Gemini is overloaded right now.", 5);
  }
  return new ServiceError(
    SERVICE,
    "bad_response",
    `Gemini request failed${status ? ` (HTTP ${status})` : ""}.`,
  );
}

export type GeminiHooks = {
  onCall?: () => void; // a request was actually sent
  onRateLimitWait?: () => void;
  /** Higher runs first. Item searches (someone is waiting) jump ahead of pin reading. */
  priority?: number;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Send one structured-output request, paced by the shared queue. Waits and
 * retries on per-minute limits; throws a ServiceError("quota") immediately
 * once the daily limit is hit (and short-circuits later calls until reset).
 */
export async function generateJson(
  parts: Array<Record<string, unknown>>,
  responseSchema: Record<string, unknown>,
  hooks: GeminiHooks = {},
): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    if ((g.__pdfGeminiBlockedUntil ?? 0) > Date.now()) throw dailyQuotaError();
    try {
      const response = await queue.add(async () => {
        hooks.onCall?.();
        return client().models.generateContent({
          model: MODEL,
          contents: [{ role: "user", parts }],
          config: { responseMimeType: "application/json", responseSchema },
        });
      }, { priority: hooks.priority ?? 0 });
      const text = response?.text;
      if (!text) throw new ServiceError(SERVICE, "bad_response", "Gemini returned an empty response.");
      return text;
    } catch (err) {
      const se = classifyGeminiError(err);
      if (se.kind === "quota") {
        g.__pdfGeminiBlockedUntil = Date.now() + (se.retryAfterSec ?? 3600) * 1000;
        throw se;
      }
      if (se.kind === "rate_limit" && attempt < MAX_RATE_LIMIT_RETRIES) {
        hooks.onRateLimitWait?.();
        await sleep(Math.min(se.retryAfterSec ?? 10, 65) * 1000 + Math.random() * 1000);
        continue;
      }
      throw se;
    }
  }
}

/** Gemini has no URL-fetching for arbitrary images: send everything inline. */
export async function imagePart(
  imageUrl: string,
  timeoutMs = IMAGE_FETCH_TIMEOUT_MS,
): Promise<{ inlineData: { mimeType: string; data: string } }> {
  const dataUri = imageUrl.match(/^data:(image\/[a-z+]+);base64,(.+)$/);
  if (dataUri) {
    if (!SUPPORTED_MIME.test(dataUri[1])) {
      throw new ServiceError("Image", "bad_response", `Unsupported image type ${dataUri[1]}.`);
    }
    return { inlineData: { mimeType: dataUri[1], data: dataUri[2] } };
  }
  let res: Response;
  try {
    res = await fetch(imageUrl, { signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new ServiceError("Image", "network", "Couldn't download the image.");
  }
  if (!res.ok) {
    throw new ServiceError("Image", "bad_response", `Couldn't download the image (HTTP ${res.status}).`);
  }
  const mimeType = (res.headers.get("content-type") ?? "image/jpeg").split(";")[0].trim();
  if (!SUPPORTED_MIME.test(mimeType)) {
    throw new ServiceError("Image", "bad_response", `Unsupported image type ${mimeType}.`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  return { inlineData: { mimeType, data: buffer.toString("base64") } };
}

/** For tests. */
export function _resetGeminiBlock() {
  g.__pdfGeminiBlockedUntil = 0;
}
