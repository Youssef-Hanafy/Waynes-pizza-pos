import type { CSSProperties } from "react";

const paths = {
  arrow: "M4 12h16M13 5l7 7-7 7",
  bag: "M5 7h14l1 14H4L5 7ZM9 8V6a3 3 0 0 1 6 0v2",
  pin: "M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0ZM15 10a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
  clock: "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0ZM12 6v6l4 2",
  truck:
    "M1 4h13v13H1V4ZM14 9h4l4 5v3h-8M8 18a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM20 18a2 2 0 1 1-4 0 2 2 0 0 1 4 0",
  phone:
    "m8 3 3 5-3 3c2 3 3 4 6 6l3-3 5 3c-1 5-4 5-7 4C8 18 3 13 2 7c-1-3 1-5 6-4Z",
  search: "M19 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Zm-3 6 6 6",
  close: "m6 6 12 12M6 18 18 6",
  pizza:
    "M3 5c6-4 12-4 18 0L12 22 3 5ZM5 8c5-3 9-3 14 0M9 11h.01M14 10h.01M12 15h.01",
  check: "m5 12 4 4L20 5",
  menu: "M4 6h16M4 12h16M4 18h16",
  plus: "M12 5v14M5 12h14",
  leaf: "M20 3C8 1 1 9 6 16s17 3 14-13ZM4 21 16 9",
} as const;

export function SiteIcon({
  name,
  size = 20,
  style,
  className,
}: {
  name: keyof typeof paths;
  size?: number;
  style?: CSSProperties;
  className?: string;
}) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      style={style}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={paths[name]} />
    </svg>
  );
}
