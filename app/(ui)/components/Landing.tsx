"use client";

import { useState } from "react";
import { allowance, type AccountUsage } from "../types";
import { Divider, Flourish } from "./Ornaments";
import BotCheck from "./BotCheck";
import Footer from "./Footer";
import Wordmark from "./Wordmark";

const EXAMPLE_BOARD = "https://www.pinterest.com/whowhatwear/nyc-style/";
const BOARD_LINK = /(pinterest\.[a-z.]+\/[^/\s]+\/[^/\s]+|pin\.it\/\S+)/i;

export default function Landing({
  account,
  busy,
  error,
  onSubmit,
}: {
  account: AccountUsage | null;
  busy: boolean;
  error: string | null;
  onSubmit: (boardUrl: string, botToken: string) => void;
}) {
  const [url, setUrl] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [resetSignal, setResetSignal] = useState(0);
  const [formError, setFormError] = useState<string | null>(null);
  const a = allowance(account);

  const ready = token !== null && url.trim() !== "" && !busy;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const v = url.trim();
    if (!BOARD_LINK.test(v)) {
      setFormError("That doesn't look like a board link. It should look like pinterest.com/name/board-name.");
      return;
    }
    if (token === null) return;
    setFormError(null);
    onSubmit(v, token);
    // Turnstile tokens are single-use: ask for a fresh one for the next try.
    if (token) setResetSignal((n) => n + 1);
  };

  const shownError = formError ?? error;

  return (
    <div className="relative z-10 flex h-full min-h-svh flex-col px-[max(16px,env(safe-area-inset-left))] xl:px-28">
      <main className="relative z-10 flex flex-1 flex-col items-center justify-center gap-7 py-8 text-center">
        <div className="-mb-2 flex flex-col items-center">
          <div className="flex items-center gap-6">
            <span className="hidden md:block">
              <Flourish />
            </span>
            <h1 className="text-[clamp(52px,10vw,104px)] leading-[0.95]">
              <Wordmark />
            </h1>
            <span className="hidden md:block">
              <Flourish mirrored />
            </span>
          </div>
        </div>
        <p className="max-w-full text-[15px] text-ink-soft sm:whitespace-nowrap">
          Paste a Pinterest board. We&apos;ll find each piece and where to buy it.
        </p>

        <form onSubmit={submit} noValidate className="flex w-full max-w-2xl flex-col gap-3">
          <label
            htmlFor="board-url"
            className="flex items-center gap-2.5 rounded-full border border-line bg-paper py-1.5 pr-1.5 pl-5 shadow-[0_10px_30px_-18px_rgba(38,34,29,0.35)] focus-within:border-burgundy"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0 text-ink-soft" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-4-4" />
            </svg>
            <input
              id="board-url"
              type="url"
              inputMode="url"
              autoComplete="off"
              placeholder="pinterest.com/name/board-name"
              aria-label="Pinterest board link"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                setFormError(null);
              }}
              className="min-w-0 flex-1 bg-transparent py-2.5 font-label text-[14px] outline-none placeholder:text-ink-soft/60"
            />
            <button
              type="submit"
              disabled={!ready}
              className="shrink-0 rounded-full bg-burgundy px-5 py-2.5 font-label text-[13px] font-medium tracking-wide text-paper transition-colors hover:bg-burgundy-deep disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? "Reading board…" : "Shop this board"}
            </button>
          </label>

          <div className="flex flex-wrap items-start justify-between gap-3 text-left">
            <BotCheck onToken={setToken} resetSignal={resetSignal} />
            <button
              type="button"
              onClick={() => {
                setUrl(EXAMPLE_BOARD);
                setFormError(null);
              }}
              className="text-xs text-ink-soft underline underline-offset-4 hover:text-ink"
            >
              Try an example board
            </button>
          </div>
          {shownError && (
            <p role="alert" className="text-left text-[13px] text-amber">
              {shownError}
            </p>
          )}
        </form>

        <section aria-label="What works right now" className="grid w-full max-w-3xl gap-x-6 gap-y-3 text-left sm:grid-cols-3">
          <Step title="Read the board" n={1}>
            Public boards, up to 50 pins.
          </Step>
          <Step title="Spot the pieces" n={2}>
            About 15 pins a minute, so pins appear one by one.
          </Step>
          <Step title="Find prices" n={3}>
            {a.out ? (
              <mark className="rounded bg-amber-bg px-1 text-amber">
                Out of searches this month{a.renews ? `, back ${a.renews}` : ""}.
              </mark>
            ) : a.known ? (
              <>
                <span className="text-ink">
                  {a.left}
                  {a.total ? ` of ${a.total}` : ""} searches left
                </span>{" "}
                this month{a.renews ? `, renews ${a.renews}` : ""}.
              </>
            ) : (
              <>Uses a shared monthly search allowance.</>
            )}
          </Step>
        </section>
        <p className="w-full max-w-3xl text-left text-xs text-ink-soft">
          If searches run out, steps 1 and 2 still work, and every pin opens in Google Lens.
        </p>
        <Divider />
      </main>
      <Footer />
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 border-t border-line pt-2.5">
      <span className="font-heading text-lg">
        <span className="text-burgundy">{n}</span> · {title}
      </span>
      <span className="text-xs leading-relaxed text-ink-soft">{children}</span>
    </div>
  );
}
