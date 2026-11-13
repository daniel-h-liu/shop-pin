"use client";

import { useEffect, useRef, useState } from "react";
import type { DetectedItem, PinResult, RetailerListing } from "@/lib/types";
import { lensUrl } from "../types";

const PAID_SOURCES = new Set(["Google Lens", "Google Shopping"]);

/** Pin titles are often file names or SEO strings; only show readable ones. */
function readableTitle(title: string | undefined): string | null {
  if (!title) return null;
  const t = title.replace(/\s+/g, " ").trim();
  if (t.length < 4 || t.length > 140) return null;
  if (!t.includes(" ") || /[_]{1,}|\.(jpe?g|png|webp)$/i.test(t)) return null; // slug-like
  return t;
}

/** Taps landing this soon after the modal opens are leftovers from the tap that opened it. */
const OPEN_GUARD_MS = 400;

export default function ShopModal({
  result,
  outOfSearches,
  renews,
  searchesLeft,
  onSearch,
  onClose,
}: {
  result: PinResult;
  outOfSearches: boolean;
  renews: string | null;
  /** Shared searches left this month, when known. */
  searchesLeft: number | null;
  onSearch: (itemId: string) => void;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  // Ignore taps until the modal has settled (see OPEN_GUARD_MS).
  const [armed, setArmed] = useState(false);
  const lens = lensUrl(result.pin.imageUrl);
  const n = result.items.length;
  const caption = readableTitle(result.pin.title);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, [onClose]);

  useEffect(() => {
    const t = setTimeout(() => setArmed(true), OPEN_GUARD_MS);
    return () => clearTimeout(t);
  }, []);

  const guardedSearch = (itemId: string) => {
    if (armed) onSearch(itemId);
  };

  return (
    <div
      className="animate-fade-in fixed inset-0 z-50 grid place-items-center bg-ink/40 px-[max(16px,env(safe-area-inset-left))] py-[max(16px,env(safe-area-inset-top))]"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="shop-title"
        className="animate-modal-rise grid max-h-full w-full max-w-4xl overflow-y-auto rounded-3xl bg-paper shadow-[0_30px_80px_-20px_rgba(38,34,29,0.5)] md:grid-cols-[minmax(0,300px)_minmax(0,1fr)] md:overflow-hidden"
      >
        {/* Pin + Lens (below the pieces on small screens) */}
        <div className="order-last flex items-center gap-4 bg-nude-soft p-5 md:order-none md:flex-col md:items-stretch">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={result.pin.imageUrl}
            alt={caption ?? ""}
            className="w-24 shrink-0 rounded-pin object-cover md:w-full"
          />
          {lens && (
            <div className="flex flex-1 flex-col gap-2">
              <a
                href={lens}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-full border border-ink px-4 py-2.5 text-center font-label text-[13px] font-medium transition-colors hover:bg-ink hover:text-paper"
              >
                Open pin in Google Lens ↗
              </a>
              <p className="text-center text-xs leading-snug text-ink-soft">
                Free, opens a new tab. Draw a box around any piece to search it yourself.
              </p>
            </div>
          )}
        </div>

        {/* Pieces */}
        <div className="flex min-w-0 flex-col gap-3 p-5 md:overflow-y-auto md:p-7">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 id="shop-title" className="font-heading text-2xl leading-tight md:text-[28px]">
                {n} piece{n === 1 ? "" : "s"} spotted
              </h2>
              {caption && <p className="mt-1 line-clamp-2 text-[13px] text-ink-soft">{caption}</p>}
            </div>
            <button
              ref={closeRef}
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-line text-lg leading-none hover:border-ink"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
            </button>
          </div>

          {outOfSearches ? (
            <p className="rounded-xl bg-amber-bg px-3 py-2 text-xs text-amber">
              This month&apos;s price searches are used up{renews ? ` (back ${renews})` : ""}. Saved results still show, and Google Lens works anytime.
            </p>
          ) : (
            <p className="text-xs leading-relaxed text-ink-soft">
              <span className="text-ink">Search</span> looks one piece up with Google Lens. Each new search uses 1 of the{" "}
              {searchesLeft != null ? <span className="text-ink tabular-nums">{searchesLeft}</span> : "limited"} free searches
              everyone shares this month; repeating a search is free.
            </p>
          )}

          <ul className="flex flex-col">
            {result.items.map((item) => (
              <PieceRow key={item.itemId} item={item} disabled={outOfSearches} onSearch={() => guardedSearch(item.itemId)} />
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

function PieceRow({ item, disabled, onSearch }: { item: DetectedItem; disabled: boolean; onSearch: () => void }) {
  const s = item.search;
  const searching = s.status === "searching";
  const checking = s.status === "checking";
  const busy = searching || checking;
  const searched = s.status === "done" || s.status === "error";
  const paid = (s.sources ?? []).filter((src) => PAID_SOURCES.has(src.adapter) && !src.cached).length;
  const allCached = (s.sources ?? []).length > 0 && (s.sources ?? []).every((src) => src.cached);
  const pieceLens = item.cropUrl ? lensUrl(item.cropUrl) : null;
  const original = s.status === "done" ? s.original : undefined;

  return (
    <li className="flex flex-col gap-2.5 border-t border-line py-3.5">
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0 font-heading text-lg leading-snug break-words">{item.productName}</span>
        {(!searched || s.status === "error") && (
          <button
            type="button"
            onClick={onSearch}
            disabled={busy || (disabled && !searched)}
            aria-label={`${searching ? "Searching" : checking ? "Checking" : s.status === "error" ? "Try again" : "Search prices"} for ${item.productName}`}
            className={`shrink-0 rounded-full px-4 py-2 font-label text-xs font-medium tracking-wide transition-colors ${
              busy
                ? "cursor-progress bg-burgundy-soft text-burgundy"
                : "bg-burgundy text-paper hover:bg-burgundy-deep disabled:cursor-not-allowed disabled:opacity-40"
            }`}
          >
            {searching ? "Searching…" : checking ? "Checking…" : s.status === "error" ? "Try again" : "Search"}
          </button>
        )}
      </div>

      {searching && (
        <div className="flex flex-col gap-1.5" aria-hidden="true">
          <div className="skeleton h-16 rounded-xl" />
          <div className="skeleton h-16 rounded-xl" />
        </div>
      )}

      {checking && (
        <div className="flex flex-col gap-1" aria-live="polite">
          <p className="flex items-center gap-2 text-xs text-ink-soft">
            <span className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-burgundy/25 border-t-burgundy" aria-hidden="true" />
            First matches from Google Lens. Comparing each photo to your pin…
          </p>
          <div className="flex flex-col gap-1">
            {s.deals.map((deal, i) => (
              <DealRow key={`${deal.url}-${i}`} deal={deal} index={i} sub="checking" />
            ))}
          </div>
        </div>
      )}

      {searched && (
        <div className="flex flex-col gap-1" aria-live="polite">
          {original && (
            <>
              <span className="label mt-1">The original</span>
              <DealRow deal={original} index={0} sub="exact" />
            </>
          )}
          {s.deals.length > 0 && (
            <>
              {(original || s.verified) && (
                <span className="label mt-2">
                  {original && original.price > 0 ? "Cheaper look-alikes" : "Look-alikes"}
                  <span className="ml-2 tracking-normal normal-case">· similar, may not be the exact piece</span>
                </span>
              )}
              {s.deals.map((deal, i) => (
                <DealRow
                  key={`${deal.url}-${i}`}
                  deal={deal}
                  index={i + (original ? 1 : 0)}
                  lowest={i === 0}
                  sub={deal.exact ? "exact" : s.verified ? "score" : "text"}
                />
              ))}
            </>
          )}
          {s.note && (
            <p
              className={`text-xs ${
                s.status === "error" || (s.deals.length === 0 && !original) ? "rounded-xl bg-amber-bg px-3 py-2 text-amber" : "text-ink-soft"
              }`}
            >
              {s.note}
            </p>
          )}
          {s.status === "done" && (
            <p className="text-[11px] text-ink-soft">
              {allCached ? "Saved result, no search used." : `Used ${paid || 1} of this month's shared searches.`}
              {pieceLens && (
                <>
                  {" "}
                  <a href={pieceLens} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-ink">
                    See more of this piece in Google Lens ↗
                  </a>
                </>
              )}
            </p>
          )}
        </div>
      )}
    </li>
  );
}

function DealRow({
  deal,
  index,
  lowest = false,
  sub,
}: {
  deal: RetailerListing;
  index: number;
  lowest?: boolean;
  /** exact = judged the same product; score = how alike it looks; text = matched by name only; checking = photo check running */
  sub: "exact" | "score" | "text" | "checking";
}) {
  const price =
    deal.price > 0
      ? new Intl.NumberFormat("en-US", {
          style: "currency",
          currency: deal.currency || "USD",
          maximumFractionDigits: deal.price % 1 === 0 ? 0 : 2,
        }).format(deal.price)
      : null;
  const pct = Math.round(deal.matchConfidence * 100);
  const detail =
    sub === "exact"
      ? "same piece"
      : sub === "score"
        ? `${pct}% alike`
        : sub === "text"
          ? "matched by name, photo not compared"
          : "comparing photos…";

  return (
    <a
      href={deal.url}
      target="_blank"
      rel="noopener noreferrer"
      title={deal.matchReason}
      style={{ animationDelay: `${index * 60}ms` }}
      className="animate-pin-pop grid grid-cols-[3.25rem_minmax(0,1fr)_auto] items-center gap-3 rounded-xl p-1.5 transition-colors hover:bg-cream"
    >
      {deal.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={deal.imageUrl} alt="" className="h-13 w-13 rounded-lg bg-nude-soft object-cover" />
      ) : (
        <span className="h-13 w-13 rounded-lg bg-nude-soft" />
      )}
      <span className="min-w-0">
        <span className="line-clamp-2 text-[13px] leading-snug break-words">{deal.title}</span>
        <span className="text-[11px] text-ink-soft">
          {deal.condition && (
            <span className="mr-1.5 inline-block rounded-full bg-nude-soft px-2 py-px align-[1px] font-label text-[11px] text-ink">
              {deal.condition.toLowerCase()}
            </span>
          )}
          {deal.retailer} · <span className={sub === "exact" ? "text-burgundy" : ""}>{detail}</span>
        </span>
      </span>
      <span className="text-right font-heading text-xl tabular-nums">
        {price ?? <span className="block font-label text-[11px] leading-tight text-ink-soft">price on site</span>}
        {lowest && price && <span className="block font-label text-[11px] tracking-wide text-burgundy">lowest</span>}
      </span>
    </a>
  );
}
