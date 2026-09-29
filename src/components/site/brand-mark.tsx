import { WayneBadge } from "./wayne-badge";

export function BrandMark({ compact = false, name = "Store", city = "", badgeLabel = "" }: { compact?: boolean; name?: string; city?: string; badgeLabel?: string }) {
  return (
    <span
      className={`brand-mark ${compact ? "brand-mark-compact" : ""}`}
      aria-label={name}
    >
      <WayneBadge className="brand-badge" label={badgeLabel || name} size={compact ? 40 : 52} />
      <span className="brand-text">
        <span className="brand-word">
          {name}
          <span className="brand-spark" aria-hidden>
            ✦
          </span>
        </span>
        <span className="brand-sub">
          {city || "LOCAL"}
        </span>
      </span>
    </span>
  );
}
