import { WayneBadge } from "./wayne-badge";

export function BrandMark({ compact = false, name = "Store", city = "" }: { compact?: boolean; name?: string; city?: string }) {
  return (
    <span
      className={`brand-mark ${compact ? "brand-mark-compact" : ""}`}
      aria-label={name}
    >
      <WayneBadge className="brand-badge" size={compact ? 40 : 52} />
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
