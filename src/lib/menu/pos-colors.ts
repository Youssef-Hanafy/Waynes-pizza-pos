/**
 * Colours for POS buttons (owner, 2026-10-19: "edit the color for each item or
 * groups of items to make it easier to identify").  A category's colour is used
 * by every item in it that has no colour of its own.
 */
export const POS_COLORS = [
  { name: "Red", hex: "#e53935" },
  { name: "Orange", hex: "#fb8c00" },
  { name: "Yellow", hex: "#fdd835" },
  { name: "Green", hex: "#43a047" },
  { name: "Teal", hex: "#00897b" },
  { name: "Blue", hex: "#1e88e5" },
  { name: "Purple", hex: "#8e24aa" },
  { name: "Pink", hex: "#d81b60" },
  { name: "Brown", hex: "#6d4c41" },
  { name: "Gray", hex: "#757575" },
] as const;

/** A colour from a form: "#rrggbb" (lower case), "" for none, or null when it isn't a colour. */
export function parsePosColor(value: unknown): string | "" | null {
  if (value === "" || value === "none") return "";
  if (typeof value !== "string") return null;
  const clean = value.trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(clean) ? clean : null;
}

export function posColorName(hex: string | null | undefined) {
  if (!hex) return "No colour";
  return POS_COLORS.find((color) => color.hex === hex)?.name ?? hex;
}
