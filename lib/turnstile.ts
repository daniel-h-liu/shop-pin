/**
 * Cloudflare Turnstile (free bot check) verification.
 *
 * The browser widget produces a one-time token; the server confirms it with
 * Cloudflare before starting a board. When TURNSTILE_SECRET_KEY isn't set
 * (local development) the check is skipped.
 *
 * Besides `success`, the server checks that the token was issued for this
 * form (`action`) and, when TURNSTILE_HOSTNAMES is set, on one of our own
 * hostnames — so a token minted on another site can't be replayed here.
 */

/** Must match the `action` the widget renders with (app/(ui)/components/BotCheck.tsx). */
export const TURNSTILE_ACTION = "shop_board";

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export type TurnstileResult = { ok: true; skipped?: boolean } | { ok: false; message: string };

export function isTurnstileEnabled(): boolean {
  return !!process.env.TURNSTILE_SECRET_KEY;
}

function allowedHostnames(): string[] {
  return (process.env.TURNSTILE_HOSTNAMES ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

export async function verifyTurnstile(
  token: string | undefined,
  remoteIp?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TurnstileResult> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return { ok: true, skipped: true };
  if (!token) return { ok: false, message: "Please complete the bot check first." };

  const form = new URLSearchParams({ secret, response: token });
  if (remoteIp) form.set("remoteip", remoteIp);
  try {
    const res = await fetchImpl(VERIFY_URL, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { ok: false, message: "The bot check service had a problem. Please try again in a moment." };
    const data = (await res.json()) as {
      success?: boolean;
      action?: string;
      hostname?: string;
      "error-codes"?: string[];
    };
    if (data.success) {
      if (data.action !== TURNSTILE_ACTION) {
        return { ok: false, message: "The bot check didn't match this page. Please reload and try again." };
      }
      const hosts = allowedHostnames();
      if (hosts.length && !hosts.includes((data.hostname ?? "").toLowerCase())) {
        return { ok: false, message: "The bot check came from a different site. Please reload and try again." };
      }
      return { ok: true };
    }
    const codes = data["error-codes"] ?? [];
    if (codes.includes("timeout-or-duplicate")) {
      return { ok: false, message: "The bot check expired. Please try again." };
    }
    return { ok: false, message: "The bot check didn't pass. Please try again." };
  } catch {
    return { ok: false, message: "Couldn't reach the bot check service. Please try again in a moment." };
  }
}
