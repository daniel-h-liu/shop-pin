"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { PinResult } from "@/lib/types";

/**
 * Masonry collage of pins. A pin appears (pops in) once Gemini has finished
 * with it and its photo has loaded, one at a time. Hovering a pin grows it
 * 10% and pushes its neighbours away, with a springy overshoot.
 */

const GAP = 14;
const MIN_COL = 210;
const STAGGER_MS = 140;
const FALLBACK_RATIO = 1.25;

const isReady = (r: PinResult) => r.status !== "pending" && r.status !== "identifying";

type Pos = { x: number; y: number; w: number; h: number };

export default function Collage({
  results,
  onShop,
}: {
  results: PinResult[];
  onShop: (pinId: string) => void;
}) {
  const gridRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [ratios, setRatios] = useState<Record<string, number>>({});
  const [broken, setBroken] = useState<Record<string, boolean>>({});
  const [order, setOrder] = useState<string[]>([]);
  const [hovered, setHovered] = useState<string | null>(null);
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const byId = useMemo(() => new Map(results.map((r) => [r.pin.pinId, r])), [results]);

  // Pins that are ready and whose image size we know, but haven't appeared yet.
  const waiting = useMemo(
    () => results.filter((r) => isReady(r) && ratios[r.pin.pinId] && !order.includes(r.pin.pinId)),
    [results, ratios, order],
  );

  // Reveal waiting pins one at a time.
  useEffect(() => {
    if (waiting.length === 0) return;
    const next = waiting[0].pin.pinId;
    const t = setTimeout(
      () => setOrder((o) => (o.includes(next) ? o : [...o, next])),
      order.length === 0 ? 0 : STAGGER_MS,
    );
    return () => clearTimeout(t);
  }, [waiting, order.length]);

  // Shortest-column placement in appearance order, so existing pins never move.
  const { positions, height } = useMemo(() => {
    const positions = new Map<string, Pos>();
    if (width <= 0) return { positions, height: 0 };
    const cols = Math.max(2, Math.min(6, Math.floor((width + GAP) / (MIN_COL + GAP))));
    const colW = (width - GAP * (cols - 1)) / cols;
    const heights = new Array<number>(cols).fill(0);
    for (const id of order) {
      const h = Math.round(colW * (ratios[id] ?? FALLBACK_RATIO));
      const c = heights.indexOf(Math.min(...heights));
      positions.set(id, { x: c * (colW + GAP), y: heights[c], w: colW, h });
      heights[c] += h + GAP;
    }
    return { positions, height: Math.max(0, ...heights) };
  }, [order, ratios, width]);

  const transformFor = (id: string): string => {
    const p = positions.get(id)!;
    const H = hovered ? positions.get(hovered) : undefined;
    let dx = 0;
    let dy = 0;
    let s = 1;
    if (H && id === hovered) s = 1.1;
    else if (H && !reduced) {
      const vx = p.x + p.w / 2 - (H.x + H.w / 2);
      const vy = p.y + p.h / 2 - (H.y + H.h / 2);
      const d = Math.hypot(vx, vy) || 1;
      const edge = Math.max(0, d - Math.max(H.w, H.h) / 2);
      const f = Math.exp(-edge / (H.w * 0.9));
      const push = Math.max(H.w, H.h) * 0.075 * f;
      dx = (vx / d) * push;
      dy = (vy / d) * push;
      s = 1 - 0.035 * f;
    }
    return `translate(${(p.x + dx).toFixed(1)}px, ${(p.y + dy).toFixed(1)}px) scale(${s.toFixed(3)})`;
  };

  // Load images off-screen first so each pin appears at its real proportions.
  const preloading = results.filter((r) => isReady(r) && !ratios[r.pin.pinId]);

  return (
    <>
      <div ref={gridRef} className="relative" style={{ height }}>
        {order.map((id) => {
          const r = byId.get(id);
          const p = positions.get(id);
          if (!r || !p) return null;
          return (
            <PinTile
              key={id}
              result={r}
              broken={!!broken[id]}
              hot={hovered === id}
              style={{ width: p.w, height: p.h, transform: transformFor(id) }}
              onHot={(on) => setHovered((cur) => (on ? id : cur === id ? null : cur))}
              onShop={() => onShop(id)}
            />
          );
        })}
      </div>
      <div className="hidden" aria-hidden="true">
        {preloading.map((r) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={r.pin.pinId}
            src={r.pin.imageUrl}
            alt=""
            onLoad={(e) => {
              const img = e.currentTarget;
              const ratio = img.naturalWidth ? img.naturalHeight / img.naturalWidth : FALLBACK_RATIO;
              setRatios((m) => ({ ...m, [r.pin.pinId]: Math.min(2.2, Math.max(0.5, ratio)) }));
            }}
            onError={() => {
              setBroken((m) => ({ ...m, [r.pin.pinId]: true }));
              setRatios((m) => ({ ...m, [r.pin.pinId]: FALLBACK_RATIO }));
            }}
          />
        ))}
      </div>
    </>
  );
}

function PinTile({
  result,
  broken,
  hot,
  style,
  onHot,
  onShop,
}: {
  result: PinResult;
  broken: boolean;
  hot: boolean;
  style: React.CSSProperties;
  onHot: (on: boolean) => void;
  onShop: () => void;
}) {
  const lastPointer = useRef("mouse");
  const items = result.items.length;
  const shoppable = result.status === "done" && items > 0;
  const tag =
    result.status === "deferred"
      ? "Not read yet"
      : result.status === "error"
        ? "Couldn't read"
        : !shoppable
          ? "Nothing to shop"
          : null;

  return (
    <div
      className={`absolute top-0 left-0 origin-center transition-transform duration-500 ease-bob will-change-transform ${hot ? "z-10" : "z-0"}`}
      style={style}
      onPointerEnter={(e) => e.pointerType === "mouse" && onHot(true)}
      onPointerLeave={(e) => e.pointerType === "mouse" && onHot(false)}
      onPointerDown={(e) => {
        lastPointer.current = e.pointerType;
      }}
      onClick={(e) => {
        // Touch: first tap bulges the pin and shows Shop.
        if (lastPointer.current !== "mouse" && !(e.target as HTMLElement).closest("button")) onHot(!hot);
      }}
      onFocus={() => onHot(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onHot(false);
      }}
    >
      <div
        tabIndex={0}
        aria-label={result.pin.title ?? "Pin"}
        className={`animate-pin-pop relative h-full w-full overflow-hidden rounded-pin bg-nude-soft transition-shadow duration-300 ${
          hot ? "shadow-[0_18px_40px_-14px_rgba(38,34,29,0.45)]" : "shadow-[0_1px_2px_rgba(38,34,29,0.08)]"
        }`}
      >
        {broken ? (
          <div className="flex h-full items-center justify-center p-4 text-center font-heading text-ink-soft">
            {result.pin.title ?? "Image unavailable"}
          </div>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={result.pin.imageUrl}
            alt={result.pin.title ?? ""}
            draggable={false}
            className={`h-full w-full object-cover ${shoppable ? "" : "opacity-70 saturate-50"}`}
          />
        )}

        {shoppable && (
          <>
            <button
              type="button"
              onClick={onShop}
              className={`absolute top-2.5 right-2.5 rounded-full bg-burgundy px-4 py-2 font-label text-xs font-medium tracking-wider text-paper transition-[opacity,transform,background-color] duration-300 ease-bob hover:bg-burgundy-deep focus-visible:translate-y-0 focus-visible:opacity-100 ${
                hot ? "translate-y-0 opacity-100" : "-translate-y-1 opacity-0"
              }`}
            >
              Shop
            </button>
            <div
              className={`pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-ink/65 to-transparent px-3 pt-7 pb-2.5 text-[12px] leading-snug text-paper transition-opacity duration-300 ${
                hot ? "opacity-100" : "opacity-0"
              }`}
            >
              <span className="block font-label text-[10px] tracking-[0.12em] uppercase opacity-85">
                {items} piece{items === 1 ? "" : "s"}
              </span>
              {result.pin.title && <span className="line-clamp-2">{result.pin.title}</span>}
            </div>
          </>
        )}

        {tag && (
          <span className="absolute bottom-2.5 left-2.5 rounded-full bg-paper/85 px-2.5 py-0.5 font-label text-[10px] tracking-[0.12em] text-ink-soft uppercase">
            {tag}
          </span>
        )}
      </div>
    </div>
  );
}
