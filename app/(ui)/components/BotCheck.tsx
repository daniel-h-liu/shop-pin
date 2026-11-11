"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Bot check using Cloudflare Turnstile (free). It runs invisibly for most
 * people ("interaction-only"); Cloudflare only shows its own checkbox when
 * it's unsure. Our burgundy indicator shows the state either way.
 *
 * Without NEXT_PUBLIC_TURNSTILE_SITE_KEY (local development) the check is
 * off and the server skips verification too.
 */

type TurnstileApi = {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string;
  reset: (id?: string) => void;
  remove: (id: string) => void;
};
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

let scriptPromise: Promise<TurnstileApi> | null = null;
function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  scriptPromise ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = SCRIPT_SRC;
    s.async = true;
    s.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error("Turnstile missing")));
    s.onerror = () => {
      scriptPromise = null;
      reject(new Error("Couldn't load the bot check"));
    };
    document.head.appendChild(s);
  });
  return scriptPromise;
}

type State = "checking" | "ok" | "error";

export default function BotCheck({
  onToken,
  resetSignal,
}: {
  /** null = no valid token (yet), "" = check disabled in this environment */
  onToken: (token: string | null) => void;
  /** Change this number to get a fresh token (tokens are single-use). */
  resetSignal: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  const widget = useRef<string | null>(null);
  const [state, setState] = useState<State>("checking");
  const onTokenRef = useRef(onToken);
  useEffect(() => {
    onTokenRef.current = onToken;
  });

  useEffect(() => {
    if (!SITE_KEY) {
      onTokenRef.current("");
      return;
    }
    let cancelled = false;
    loadTurnstile()
      .then((ts) => {
        if (cancelled || !box.current) return;
        widget.current = ts.render(box.current, {
          sitekey: SITE_KEY,
          appearance: "interaction-only",
          action: "shop_board", // checked on the server (lib/turnstile.ts)
          theme: "light",
          callback: (token: string) => {
            setState("ok");
            onTokenRef.current(token);
          },
          "expired-callback": () => {
            setState("checking");
            onTokenRef.current(null);
            if (widget.current) window.turnstile?.reset(widget.current);
          },
          "error-callback": () => {
            setState("error");
            onTokenRef.current(null);
          },
        });
      })
      .catch(() => !cancelled && setState("error"));
    return () => {
      cancelled = true;
      if (widget.current) window.turnstile?.remove(widget.current);
      widget.current = null;
    };
  }, []);

  // Fresh token after each use.
  useEffect(() => {
    if (resetSignal === 0 || !SITE_KEY || !widget.current) return;
    onTokenRef.current(null);
    window.turnstile?.reset(widget.current);
  }, [resetSignal]);

  if (!SITE_KEY) {
    return (
      <span className="inline-flex items-center gap-2 text-xs text-ink-soft" title="Set NEXT_PUBLIC_TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY to turn it on.">
        <span className="h-2 w-2 rounded-full border border-burgundy" />
        Bot check off (development)
      </span>
    );
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <span className="inline-flex items-center gap-2 rounded-full border border-burgundy/30 bg-paper px-3 py-1.5 text-xs text-burgundy">
        {state === "ok" ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden="true">
            <path d="m5 12 5 5 9-10" />
          </svg>
        ) : state === "checking" ? (
          <span className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-burgundy/25 border-t-burgundy" aria-hidden="true" />
        ) : (
          <span aria-hidden="true">!</span>
        )}
        <span role="status">
          {state === "ok" ? "Human check passed" : state === "checking" ? "Checking you're human…" : "Bot check failed. Reload the page to try again."}
        </span>
      </span>
      {/* Cloudflare renders its checkbox here only if it needs you to click. */}
      <div ref={box} />
    </div>
  );
}
