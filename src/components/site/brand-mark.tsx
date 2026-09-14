import { WayneBadge } from "./wayne-badge";

export function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <span
      className={`brand-mark ${compact ? "brand-mark-compact" : ""}`}
      aria-label="Wayne's Pizza"
    >
      <WayneBadge className="brand-badge" size={compact ? 40 : 52} />
      <span className="brand-text">
        <span className="brand-word">
          Wayne&apos;s
          <span className="brand-spark" aria-hidden>
            ✦
          </span>
        </span>
        <span className="brand-sub">
          PIZZA <span aria-hidden>•</span> WORCESTER, MA
        </span>
      </span>
    </span>
  );
}
