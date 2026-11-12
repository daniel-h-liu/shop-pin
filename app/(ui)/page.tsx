"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DetectedItem, PinResult } from "@/lib/types";
import Collage from "./components/Collage";
import Footer from "./components/Footer";
import GoldFrame from "./components/GoldFrame";
import Landing from "./components/Landing";
import { NudeShapes } from "./components/Ornaments";
import ShopModal from "./components/ShopModal";
import Wordmark from "./components/Wordmark";
import { allowance, boardNameFromUrl, type AccountUsage, type StatusResponse } from "./types";

const POLL_INTERVAL_MS = 1500;

export default function Home() {
  const [boardUrl, setBoardUrl] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<StatusResponse | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [account, setAccount] = useState<AccountUsage | null>(null);
  const [rerunError, setRerunError] = useState<string | null>(null);
  const [pollNonce, setPollNonce] = useState(0);
  const [openPin, setOpenPin] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refreshAccount = useCallback(async () => {
    try {
      const res = await fetch("/api/usage");
      if (res.ok) setAccount(await res.json());
    } catch {
      // informational only
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one fetch on mount
    refreshAccount();
  }, [refreshAccount]);

  const stopPolling = () => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
  };

  // Poll while the board is being read; pins appear as they finish.
  useEffect(() => {
    if (!jobId) return;
    const poll = async () => {
      try {
        const res = await fetch(`/api/board/${jobId}/status`);
        if (!res.ok) return;
        const data: StatusResponse = await res.json();
        // Keep in-flight local search states; the server copy may lag.
        setJob((prev) => mergeLocalSearches(prev, data));
        if (data.status !== "running") stopPolling();
      } catch {
        // transient; keep trying
      }
    };
    poll();
    pollRef.current = setInterval(poll, POLL_INTERVAL_MS);
    return stopPolling;
  }, [jobId, pollNonce]);

  const submit = useCallback(async (url: string, botToken: string) => {
    setSubmitError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/board", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ boardUrl: url, turnstileToken: botToken || undefined }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSubmitError(data.error ?? `Something went wrong (HTTP ${res.status}).`);
        return;
      }
      setBoardUrl(url);
      setJob(null);
      setJobId(data.jobId);
      window.scrollTo(0, 0);
    } catch {
      setSubmitError("Couldn't reach the server. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }, []);

  const goHome = useCallback(() => {
    stopPolling();
    setJobId(null);
    setJob(null);
    setBoardUrl(null);
    setOpenPin(null);
    setRerunError(null);
    refreshAccount();
  }, [refreshAccount]);

  const patchItem = useCallback((pinId: string, item: DetectedItem) => {
    setJob(
      (prev) =>
        prev && {
          ...prev,
          results: prev.results.map((r) =>
            r.pin.pinId !== pinId ? r : { ...r, items: r.items.map((i) => (i.itemId === item.itemId ? item : i)) },
          ),
        },
    );
  }, []);

  const searchItem = useCallback(
    async (pinId: string, itemId: string) => {
      if (!jobId || !job) return;
      const current = job.results.find((r) => r.pin.pinId === pinId)?.items.find((i) => i.itemId === itemId);
      if (!current || current.search.status === "searching" || current.search.status === "checking") return;
      patchItem(pinId, { ...current, search: { status: "searching", deals: [] } });
      try {
        const res = await fetch(`/api/board/${jobId}/search`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pinId, itemId }),
        });
        if (!res.ok || !res.body) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error ?? `Search failed (HTTP ${res.status}).`);
        }
        // One JSON line per update: first results, then the visually checked ones.
        const apply = (line: string) => {
          if (!line.trim()) return;
          const data = JSON.parse(line) as { result: PinResult; usage: StatusResponse["usage"] };
          const updated = data.result.items.find((i) => i.itemId === itemId);
          if (updated) patchItem(pinId, updated);
          setJob((prev) => prev && { ...prev, usage: data.usage });
        };
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffered = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffered += value;
          const lines = buffered.split("\n");
          buffered = lines.pop() ?? "";
          lines.forEach(apply);
        }
        apply(buffered);
      } catch (err) {
        patchItem(pinId, {
          ...current,
          search: { status: "error", deals: [], note: err instanceof Error ? err.message : "Search failed." },
        });
      }
      refreshAccount();
    },
    [jobId, job, patchItem, refreshAccount],
  );

  const rerun = useCallback(async () => {
    if (!jobId) return;
    setRerunError(null);
    try {
      const res = await fetch(`/api/board/${jobId}/rerun`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setRerunError(data.error ?? `Retry failed (HTTP ${res.status}).`);
        return;
      }
      setPollNonce((n) => n + 1);
    } catch {
      setRerunError("Couldn't reach the server. Try again in a moment.");
    }
  }, [jobId]);

  const closeModal = useCallback(() => setOpenPin(null), []);
  const a = allowance(account);
  const openResult = useMemo(() => job?.results.find((r) => r.pin.pinId === openPin) ?? null, [job, openPin]);

  if (!jobId) {
    return (
      <>
        <NudeShapes />
        <GoldFrame />
        <Landing account={account} busy={submitting} error={submitError} onSubmit={submit} />
      </>
    );
  }

  const results = job?.results ?? [];
  const total = job?.totalPins ?? 0;
  const processed = job?.processedPins ?? 0;
  const reading = !job || job.status === "running";
  const shoppable = results.filter((r) => r.status === "done" && r.items.length > 0).length;
  const notRead = results.filter((r) => r.status === "deferred" || r.status === "error").length;

  return (
    <>
      <GoldFrame />
      {/* inert while the Shop modal is open: keyboard and screen readers stay inside it */}
      <div className="relative z-10 flex min-h-svh flex-col overflow-x-clip" inert={!!openResult}>
        <header className="sticky top-[env(safe-area-inset-top)] z-20 flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-line bg-cream/90 px-[max(16px,env(safe-area-inset-left))] py-3 backdrop-blur-md xl:px-28">
          <button type="button" onClick={goHome} aria-label="Start over with another board" className="text-[26px] leading-none">
            <Wordmark />
          </button>
          {boardUrl && (
            <span className="max-w-full truncate rounded-full border border-line bg-paper px-3 py-1 text-xs text-ink-soft">
              {boardUrl.replace(/^https?:\/\/(www\.)?/, "")}
            </span>
          )}
          <div className="flex min-w-48 flex-1 items-center gap-3 text-xs text-ink-soft">
            <span>
              {reading
                ? total
                  ? `Spotting pieces · ${processed} of ${total} pins`
                  : "Reading the board…"
                : `All ${total} pins read`}
            </span>
            <div className="h-[3px] max-w-56 flex-1 overflow-hidden rounded bg-line">
              <div
                className="h-full bg-burgundy transition-[width] duration-500"
                style={{ width: total ? `${(processed / total) * 100}%` : "4%" }}
              />
            </div>
          </div>
          <span className="text-xs text-ink-soft tabular-nums">
            {a.out ? (
              <mark className="rounded bg-amber-bg px-1.5 py-0.5 text-amber">
                Price searches used up{a.renews ? ` · back ${a.renews}` : ""}
              </mark>
            ) : a.known ? (
              <>
                Price searches left: <span className="text-ink">{a.left}</span>
                {a.total ? ` / ${a.total}` : ""}
              </>
            ) : null}
          </span>
        </header>

        <main className="flex flex-1 flex-col px-[max(16px,env(safe-area-inset-left))] xl:px-28">
          {job?.error && (
            <p className="mt-4 rounded-xl bg-amber-bg px-4 py-2.5 text-[13px] text-amber">{job.error}</p>
          )}
          {!reading && notRead > 0 && (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-amber-bg px-4 py-2.5 text-[13px] text-amber">
              <span>
                {notRead} pin{notRead === 1 ? " wasn't" : "s weren't"} read.{" "}
                {job?.halt
                  ? `${job.halt.message}${job.halt.retryAt ? ` You can retry after ${new Date(job.halt.retryAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.` : ""}`
                  : "You can try them again."}
                {rerunError && <span className="block">{rerunError}</span>}
              </span>
              <button
                type="button"
                onClick={rerun}
                className="rounded-full bg-burgundy px-4 py-1.5 font-label text-xs font-medium text-paper hover:bg-burgundy-deep"
              >
                Retry {notRead} pin{notRead === 1 ? "" : "s"}
              </button>
            </div>
          )}
          {job?.truncated && (
            <p className="mt-3 text-xs text-ink-soft">Big board: only the {total} most recent pins are included.</p>
          )}

          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 pt-7 pb-5">
            <h1 className="font-display text-[clamp(30px,4vw,46px)] leading-tight">
              {job?.boardName ?? (boardUrl ? boardNameFromUrl(boardUrl) : "Your board")}
            </h1>
            <span className="label">
              {shoppable} shoppable pin{shoppable === 1 ? "" : "s"}
            </span>
          </div>

          <div className="flex-1 pb-16">
            <Collage results={results} onShop={setOpenPin} />
            {reading && results.every((r) => r.status === "pending" || r.status === "identifying") && (
              <p className="animate-pulse py-10 text-center text-[13px] text-ink-soft">
                Looking at the first pins. They&apos;ll appear here one by one.
              </p>
            )}
          </div>
          <Footer />
        </main>
      </div>

      {openResult && (
        <ShopModal
          result={openResult}
          outOfSearches={a.out}
          renews={a.renews}
          searchesLeft={a.known && !a.out && a.left != null ? a.left : null}
          onSearch={(itemId) => searchItem(openResult.pin.pinId, itemId)}
          onClose={closeModal}
        />
      )}
    </>
  );
}

/** A poll mustn't overwrite an item that's mid-search (or just searched) locally. */
function mergeLocalSearches(prev: StatusResponse | null, next: StatusResponse): StatusResponse {
  if (!prev) return next;
  const local = new Map(prev.results.map((r) => [r.pin.pinId, r]));
  return {
    ...next,
    results: next.results.map((r) => {
      const old = local.get(r.pin.pinId);
      if (!old) return r;
      return {
        ...r,
        items: r.items.map((item) => {
          const mine = old.items.find((i) => i.itemId === item.itemId);
          return mine && mine.search.status !== "idle" && item.search.status === "idle" ? mine : item;
        }),
      };
    }),
  };
}
