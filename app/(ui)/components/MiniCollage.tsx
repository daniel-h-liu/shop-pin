/**
 * A still preview of what the app makes: pins from the example board
 * scattered down both sides of the landing page, staggered up/down and
 * in/out like a loose collage, so they frame the centered text instead of
 * lining up with it. Three carry the magnifying-glass badge the app is about.
 * Clicking any pin tries that board. Images load from Pinterest's CDN exactly
 * as the app does (never stored in the repo; they're other people's photos),
 * at low fetch priority so they never hold up the text. They rest faded into
 * the page and come to full color on hover.
 * If one fails to load, its tile simply stays a nude block. Wide screens only.
 */

const PIN = (hash: string) => `https://i.pinimg.com/236x/${hash}.jpg`;

type Tile = {
  src: string;
  side: "left" | "right";
  /** distance from the top of the page, as a share of its height */
  top: string;
  /** sideways offset from the column's base position (positive = toward the center) */
  dx: number;
  height: string;
  lens?: boolean;
};

const TILES: Tile[] = [
  { src: PIN("e4/88/e1/e488e17b0e5e7ce99b16e36dd43c77bd"), side: "left", top: "5%", dx: 34, height: "min(190px, 23svh)", lens: true },
  { src: PIN("1a/ab/fe/1aabfe30087bbe0dbaa016e209f601fb"), side: "left", top: "34%", dx: -6, height: "min(220px, 26svh)" },
  { src: PIN("de/f6/26/def6264e5ad2179b38f7f7da9c6385b8"), side: "left", top: "66%", dx: 46, height: "min(180px, 22svh)", lens: true },

  { src: PIN("e1/c8/65/e1c8654f1fcb3ecaf36b6f807486aee7"), side: "right", top: "11%", dx: 44, height: "min(200px, 24svh)" },
  { src: PIN("29/5e/da/295edacfcc217bb79840593e0efab2b0"), side: "right", top: "41%", dx: 12, height: "min(190px, 23svh)", lens: true },
  { src: PIN("41/52/22/4152228e723b5ec16046e50998d82a59"), side: "right", top: "71%", dx: -14, height: "min(170px, 21svh)" },
];

/** Distance of each column from its edge of the page, before the per-pin offset. */
const BASE = "clamp(88px, 7vw, 150px)";

function LensBadge() {
  return (
    <span className="absolute top-2 right-2 grid h-8 w-8 place-items-center rounded-full bg-paper/95 text-burgundy shadow-[0_4px_10px_-4px_rgba(38,34,29,0.5)]">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-4-4" />
      </svg>
    </span>
  );
}

export default function MiniCollage({ onTry }: { onTry: () => void }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-20 hidden xl:block" aria-hidden="true">
      {TILES.map((t) => (
        <button
          key={t.src}
          type="button"
          tabIndex={-1} // the "Try it" link is the keyboard path; these are larger mouse targets
          onClick={onTry}
          className="group pointer-events-auto absolute block w-[clamp(96px,8.5vw,132px)] rounded-2xl transition-[transform,box-shadow] duration-500 ease-bob hover:scale-[1.06] hover:shadow-[0_18px_36px_-14px_rgba(38,34,29,0.5)]"
          style={{
            top: t.top,
            height: t.height,
            [t.side]: `calc(${BASE} + ${t.dx}px)`,
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={t.src}
            alt=""
            decoding="async"
            fetchPriority="low"
            draggable={false}
            // Faded into the page at rest, full color on hover.
            className="pin-soft h-full w-full rounded-2xl object-cover opacity-85 saturate-[.45] sepia-[.18] group-hover:opacity-100 group-hover:saturate-100 group-hover:sepia-0"
            onError={(e) => (e.currentTarget.style.visibility = "hidden")}
          />
          {t.lens && <LensBadge />}
        </button>
      ))}
    </div>
  );
}
