/**
 * One error type for every external service, carrying a human-readable
 * message that's safe to show in the UI (never a raw JSON blob).
 */

export type ErrorKind =
  | "rate_limit" // short-term throttling; retrying later (seconds/minutes) works
  | "quota" // a daily/monthly allowance is used up
  | "auth" // missing/invalid credentials
  | "config" // e.g. model retired
  | "timeout"
  | "network"
  | "bad_response";

export class ServiceError extends Error {
  constructor(
    readonly service: string,
    readonly kind: ErrorKind,
    message: string,
    readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

/** Turn anything thrown into a short UI-safe sentence. */
export function describeError(err: unknown, fallbackService = "Request"): string {
  if (err instanceof ServiceError) return err.message;
  if (err instanceof Error) {
    if (err.name === "AbortError" || err.name === "TimeoutError") {
      return `${fallbackService} timed out.`;
    }
    // Never dump giant API payloads into the UI.
    const msg = err.message.length > 200 ? `${err.message.slice(0, 200)}…` : err.message;
    return `${fallbackService} failed: ${msg}`;
  }
  return `${fallbackService} failed.`;
}

/** Map a fetch-level failure (timeout, DNS, reset) to a ServiceError. */
export function networkError(service: string, err: unknown): ServiceError {
  if (err instanceof ServiceError) return err;
  const name = err instanceof Error ? err.name : "";
  if (name === "AbortError" || name === "TimeoutError") {
    return new ServiceError(service, "timeout", `${service} didn't respond in time.`);
  }
  return new ServiceError(service, "network", `Couldn't reach ${service} (network error).`);
}

/** "in 3h 20m" until the next midnight in America/Los_Angeles (Gemini's daily reset). */
export function untilPacificMidnight(now = new Date()): { ms: number; label: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const elapsed = (get("hour") * 3600 + get("minute") * 60 + get("second")) * 1000;
  const ms = 24 * 3600 * 1000 - elapsed;
  const h = Math.floor(ms / 3_600_000);
  const m = Math.round((ms % 3_600_000) / 60_000);
  return { ms, label: h > 0 ? `${h}h ${m}m` : `${m}m` };
}
