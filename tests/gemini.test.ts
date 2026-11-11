import { describe, expect, it } from "vitest";
import { classifyGeminiError } from "@/lib/vision/gemini";
import { untilPacificMidnight } from "@/lib/errors";

const apiError = (status: number, message: string) => Object.assign(new Error(message), { status });

describe("classifyGeminiError", () => {
  it("turns a per-minute 429 into a short rate_limit message with the retry delay", () => {
    const raw = `{"error":{"code":429,"message":"You exceeded your current quota ... Please retry in 30.439669019s.","status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.googleapis.com/google.rpc.QuotaFailure","violations":[{"quotaId":"GenerateRequestsPerMinutePerProjectPerModel-FreeTier","quotaValue":"15"}]},{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"30s"}]}}`;
    const e = classifyGeminiError(apiError(429, raw));
    expect(e.kind).toBe("rate_limit");
    expect(e.retryAfterSec).toBe(30);
    expect(e.message).not.toContain("{");
  });

  it("recognizes the daily quota and says when it resets", () => {
    const raw = `{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","details":[{"violations":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]}]}}`;
    const e = classifyGeminiError(apiError(429, raw));
    expect(e.kind).toBe("quota");
    expect(e.message).toMatch(/daily request limit .* midnight Pacific/);
    expect(e.retryAfterSec).toBeGreaterThan(0);
  });

  it("explains a retired model", () => {
    const e = classifyGeminiError(apiError(404, "models/gemini-old is no longer available to new users"));
    expect(e.kind).toBe("config");
    expect(e.message).toContain("GEMINI_MODEL");
  });
});

describe("untilPacificMidnight", () => {
  it("counts down to the next Pacific midnight", () => {
    const { ms, label } = untilPacificMidnight(new Date("2026-11-09T12:00:00Z"));
    expect(ms).toBe(20 * 3600 * 1000); // 04:00 PST → 20h to midnight
    expect(label).toBe("20h 0m");
  });
});
