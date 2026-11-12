"use client";

import { useEffect, useRef } from "react";

/**
 * A small burgundy circle that trails the mouse pointer, lagging just
 * slightly. It swells over anything clickable. Mouse/trackpad only (no touch
 * screens) and off for people who prefer reduced motion. The real cursor
 * stays visible; this is decoration.
 */
const FOLLOW = 0.28; // share of the remaining distance covered per frame (1 = no lag)

export default function CursorDot() {
  const dot = useRef<HTMLDivElement>(null);
  const circle = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = dot.current;
    const ring = circle.current;
    if (!el || !ring) return;
    if (!window.matchMedia("(pointer: fine)").matches) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let x = -100;
    let y = -100;
    let tx = x;
    let ty = y;
    let big = false; // over something clickable
    let frame = 0;
    let shown = false;

    const tick = () => {
      x += (tx - x) * FOLLOW;
      y += (ty - y) * FOLLOW;
      el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      frame = Math.abs(tx - x) + Math.abs(ty - y) > 0.1 ? requestAnimationFrame(tick) : 0;
    };
    const move = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      tx = e.clientX;
      ty = e.clientY;
      if (!shown) {
        x = tx; // appear under the pointer, not flying in from a corner
        y = ty;
        shown = true;
        el.style.opacity = "1";
      }
      const nowBig = !!(e.target as Element | null)?.closest?.("a, button, input, label, [tabindex]:not([tabindex='-1'])");
      if (nowBig !== big) {
        big = nowBig;
        ring.style.transform = `translate(-50%, -50%) scale(${big ? 2.2 : 1})`;
        ring.style.opacity = big ? "0.55" : "1";
      }
      if (!frame) frame = requestAnimationFrame(tick);
    };
    const leave = () => {
      shown = false;
      el.style.opacity = "0";
    };

    window.addEventListener("pointermove", move, { passive: true });
    document.documentElement.addEventListener("pointerleave", leave);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", move);
      document.documentElement.removeEventListener("pointerleave", leave);
    };
  }, []);

  return (
    <div
      ref={dot}
      aria-hidden="true"
      className="pointer-events-none fixed top-0 left-0 z-[100] opacity-0 transition-opacity duration-200"
      style={{ transform: "translate3d(-100px, -100px, 0)" }}
    >
      <div
        ref={circle}
        className="h-3 w-3 rounded-full bg-burgundy transition-[transform,opacity] duration-300 ease-bob"
        style={{ transform: "translate(-50%, -50%)" }}
      />
    </div>
  );
}
