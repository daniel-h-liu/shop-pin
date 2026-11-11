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
    const f = reply({ success: true, action: "shop_board", hostname: "shop-pin.onrender.com" });
    expect(await verifyTurnstile("tok", "1.2.3.4", f)).toEqual({ ok: true });
    const [, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = String(init.body);
    expect(body).toContain("secret=secret");
    expect(body).toContain("response=tok");
    expect(body).toContain("remoteip=1.2.3.4");
  });

  it("rejects a token issued for a different action", async () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "secret");
    const r = await verifyTurnstile("tok", undefined, reply({ success: true, action: "login", hostname: "shop-pin.onrender.com" }));
    expect(r).toMatchObject({ ok: false });
  });

  it("enforces the hostname allowlist when TURNSTILE_HOSTNAMES is set", async () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "secret");
    vi.stubEnv("TURNSTILE_HOSTNAMES", "shop-pin.onrender.com, www.example.com");
    const ok = await verifyTurnstile("tok", undefined, reply({ success: true, action: "shop_board", hostname: "SHOP-PIN.onrender.com" }));
    expect(ok).toEqual({ ok: true });
    const bad = await verifyTurnstile("tok", undefined, reply({ success: true, action: "shop_board", hostname: "evil.example" }));
    expect(bad).toMatchObject({ ok: false });
  });

  it("rejects when Cloudflare answers with an HTTP error", async () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "secret");
    const f = vi.fn(async () => new Response("oops", { status: 500 })) as unknown as typeof fetch;
    expect(await verifyTurnstile("tok", undefined, f)).toMatchObject({ ok: false });
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
