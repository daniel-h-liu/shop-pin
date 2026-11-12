/**
 * Landing page decoration, in the same hairline gold style as GoldFrame:
 * flourishes beside the wordmark and flat nude shapes that section off
 * parts of the page.
 */

const GOLD = "var(--gold)";

/** Line, diamond, star: sits beside the wordmark (mirrored on the right). */
export function Flourish({ mirrored = false }: { mirrored?: boolean }) {
  return (
    <svg width="130" height="30" viewBox="0 0 130 30" aria-hidden="true" className={mirrored ? "-scale-x-100" : ""}>
      <path d="M0 15 H78" stroke={GOLD} strokeWidth="0.8" />
      <path d="M20 15 H70" stroke={GOLD} strokeWidth="2.4" strokeOpacity="0.25" />
      <circle cx="10" cy="15" r="2" fill="none" stroke={GOLD} strokeWidth="0.8" />
      <path d="M84 15 L92 7 L100 15 L92 23 Z" fill="none" stroke={GOLD} strokeWidth="0.9" />
      <path d="M92 11 L96 15 L92 19 L88 15 Z" fill={GOLD} fillOpacity="0.5" />
      <path d="M118 5 Q119 14 128 15 Q119 16 118 25 Q117 16 108 15 Q117 14 118 5Z" fill={GOLD} />
    </svg>
  );
}

/**
 * Two or three flat nude shapes that section off parts of the page: a wave
 * along the bottom and soft blobs in the top corners. Solid fills, no
 * gradients, behind everything else.
 */
export function NudeShapes() {
  return (
    <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden" aria-hidden="true">
      {/* bottom wave */}
      <svg className="absolute inset-x-0 bottom-0 h-[30%] w-full" viewBox="0 0 1440 300" preserveAspectRatio="none">
        <path
          d="M0 120 C 220 40, 420 40, 640 110 S 1060 200, 1240 120 S 1400 60, 1440 80 L1440 300 L0 300 Z"
          fill="var(--nude-soft)"
        />
        <path
          d="M0 120 C 220 40, 420 40, 640 110 S 1060 200, 1240 120 S 1400 60, 1440 80"
          fill="none"
          stroke="var(--gold)"
          strokeWidth="1"
          strokeOpacity="0.55"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      {/* top-right blob */}
      <svg className="absolute -top-[14%] -right-[8%] w-[38%] min-w-[260px]" viewBox="0 0 400 300">
        <path
          d="M60 40 C 120 -20, 300 -10, 370 50 C 430 105, 400 210, 320 250 C 240 290, 170 240, 120 200 C 60 150, 0 100, 60 40Z"
          fill="var(--nude)"
          fillOpacity="0.45"
          stroke="var(--gold)"
          strokeWidth="1"
          strokeOpacity="0.55"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      {/* top-left blob */}
      <svg className="absolute -top-[10%] -left-[10%] hidden w-[26%] md:block" viewBox="0 0 300 300">
        <path
          d="M40 70 C 90 0, 220 10, 260 80 C 300 150, 250 250, 160 260 C 80 270, 20 220, 15 150 C 12 115, 20 95, 40 70Z"
          fill="var(--nude-soft)"
          stroke="var(--gold)"
          strokeWidth="1"
          strokeOpacity="0.55"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </div>
  );
}
