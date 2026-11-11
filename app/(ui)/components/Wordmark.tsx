/** "shop-pin!" with "pin" in burgundy (a nod to Pinterest). */
export default function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span className={`font-wordmark tracking-tight ${className}`}>
      shop-<span className="text-burgundy">pin</span>!
    </span>
  );
}
