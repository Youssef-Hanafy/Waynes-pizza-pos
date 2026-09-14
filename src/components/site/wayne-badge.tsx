/*
 * Wayne's actual sign is a pizza slice over a green banner that reads WAYNE'S,
 * with WE DELIVER arced over the top. This is that mark drawn as vector so it
 * stays sharp from a 28px favicon to a 200px footer lockup, and so the colours
 * come from the same palette as the rest of the site instead of a flat PNG.
 */
export function WayneBadge({
  size = 56,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      width={size}
      height={size}
      viewBox="0 0 120 120"
      role="presentation"
    >
      <defs>
        <path
          d="M60 12a48 48 0 0 0-48 48"
          id="wayne-badge-arc"
          transform="rotate(-45 60 60)"
        />
        <linearGradient id="wayne-badge-cheese" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="#ffe2a6" />
          <stop offset="100%" stopColor="#f3c064" />
        </linearGradient>
        <linearGradient id="wayne-badge-crust" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0%" stopColor="#e8a94f" />
          <stop offset="50%" stopColor="#d98c2f" />
          <stop offset="100%" stopColor="#e8a94f" />
        </linearGradient>
      </defs>

      <circle cx="60" cy="60" fill="#1f4b3a" r="58" />
      <circle
        cx="60"
        cy="60"
        fill="none"
        r="53.5"
        stroke="#f4dfae"
        strokeWidth="2"
      />

      <text
        fill="#f4dfae"
        fontFamily="var(--font-display), Archivo, system-ui, sans-serif"
        fontSize="12.5"
        fontWeight="800"
        letterSpacing="2.4"
      >
        <textPath href="#wayne-badge-arc" startOffset="50%" textAnchor="middle">
          WE DELIVER
        </textPath>
      </text>

      {/* The slice: crust along the top, cheese falling to the point. */}
      <path
        d="M23 44c23-13 51-13 74 0L60 101Z"
        fill="url(#wayne-badge-cheese)"
      />
      <path
        d="M23 44c23-13 51-13 74 0l-5.5 8.5c-20-10-43-10-63 0Z"
        fill="url(#wayne-badge-crust)"
      />
      <path
        d="M23 44c23-13 51-13 74 0L60 101Z"
        fill="none"
        stroke="#b8712a"
        strokeLinejoin="round"
        strokeWidth="2"
      />
      <circle cx="47" cy="63" fill="#b02222" r="6" />
      <circle cx="71" cy="61" fill="#b02222" r="5" />
      <circle cx="59" cy="79" fill="#b02222" r="4.6" />

      {/* Banner. */}
      <path
        d="M8 74h104l-9 11 9 11H8l9-11Z"
        fill="#b02222"
        stroke="#8a1a1a"
        strokeWidth="1.5"
      />
      <text
        fill="#fff8e7"
        fontFamily="var(--font-display), Archivo, system-ui, sans-serif"
        fontSize="17"
        fontWeight="900"
        letterSpacing="1.6"
        textAnchor="middle"
        x="60"
        y="91"
      >
        WAYNE&apos;S
      </text>
    </svg>
  );
}
