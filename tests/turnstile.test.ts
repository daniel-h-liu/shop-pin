import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyTurnstile } from "@/lib/turnstile";

afterEach(() => vi.unstubAllEnvs());

const reply = (body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

describe("verifyTurnstile", () => {
  it("is skipped when no secret key is configured (local development)", async () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "");
    expect(await verifyTurnstile(undefined)).toEqual({ ok: true, skipped: true });
  });

  it("requires a token when enabled", async () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "secret");
    expect(await verifyTurnstile(undefined)).toMatchObject({ ok: false });
  });

  it("sends secret, token and IP to Cloudflare and accepts success", async () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "secret");
    const f = reply({ success: true });
    expect(await verifyTurnstile("tok", "1.2.3.4", f)).toEqual({ ok: true });
    const [, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = String(init.body);
    expect(body).toContain("secret=secret");
    expect(body).toContain("response=tok");
    expect(body).toContain("remoteip=1.2.3.4");
  });

  it("explains an expired or reused token", async () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "secret");
    const r = await verifyTurnstile("tok", undefined, reply({ success: false, "error-codes": ["timeout-or-duplicate"] }));
    expect(r).toMatchObject({ ok: false, message: expect.stringContaining("expired") });
  });

  it("fails closed when Cloudflare can't be reached", async () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "secret");
    const f = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await verifyTurnstile("tok", undefined, f)).toMatchObject({ ok: false });
  });
});
