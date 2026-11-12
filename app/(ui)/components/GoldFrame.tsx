/**
 * Decorative gold framing down both sides of the page: thin arches, a hairline
 * and small four-point stars, very light. Purely ornamental, hidden on
 * narrower screens where there's no side room.
 */

function Star({ y }: { y: number }) {
  return <path d={`M32 ${y - 8} Q33 ${y - 1} 40 ${y} Q33 ${y + 1} 32 ${y + 8} Q31 ${y + 1} 24 ${y} Q31 ${y - 1} 32 ${y - 8}Z`} fill="var(--gold)" />;
}

function Top() {
  return (
    <svg width="64" height="190" viewBox="0 0 64 190" aria-hidden="true" className="block shrink-0">
      <path d="M10 190 L10 70 A22 22 0 0 1 54 70 L54 190" fill="var(--nude-soft)" fillOpacity="0.45" stroke="var(--gold)" strokeWidth="1" />
      <path d="M19 190 L19 74 A13 13 0 0 1 45 74 L45 190" fill="none" stroke="var(--gold)" strokeWidth="0.6" strokeOpacity="0.7" />
      <Star y={26} />
      <circle cx="32" cy="110" r="2.5" fill="none" stroke="var(--gold)" strokeWidth="0.8" />
      <path d="M32 132 L36 138 L32 144 L28 138 Z" fill="none" stroke="var(--gold)" strokeWidth="0.7" />
    </svg>
  );
}

function Middle() {
  return (
    <svg width="64" height="90" viewBox="0 0 64 90" aria-hidden="true" className="block shrink-0">
      <circle cx="32" cy="45" r="20" fill="var(--nude-soft)" fillOpacity="0.4" stroke="var(--gold)" strokeWidth="0.7" />
      <circle cx="32" cy="45" r="13" fill="none" stroke="var(--gold)" strokeWidth="0.5" strokeOpacity="0.7" />
      <Star y={45} />
    </svg>
  );
}

function Bottom() {
  return (
    <svg width="64" height="150" viewBox="0 0 64 150" aria-hidden="true" className="block shrink-0">
      <path d="M10 0 L10 92 A22 22 0 0 0 54 92 L54 0" fill="var(--nude-soft)" fillOpacity="0.45" stroke="var(--gold)" strokeWidth="0.8" />
      <path d="M32 40 L36 46 L32 52 L28 46 Z" fill="none" stroke="var(--gold)" strokeWidth="0.7" />
      <Star y={136} />
    </svg>
  );
}

function Side({ mirrored }: { mirrored?: boolean }) {
  return (
    <div
      className={`pointer-events-none fixed top-0 bottom-0 z-0 hidden w-16 flex-col items-center py-6 xl:flex ${
        mirrored ? "right-3 -scale-x-100" : "left-3"
      }`}
      aria-hidden="true"
    >
      <Top />
      <div className="w-px flex-1 bg-gold/80" />
      <Middle />
      <div className="w-px flex-1 bg-gold/80" />
      <Bottom />
    </div>
  );
}

export default function GoldFrame() {
  return (
    <>
      <Side />
      <Side mirrored />
    </>
  );
}
