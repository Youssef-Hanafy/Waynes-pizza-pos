import type { StoreSettings } from "@/lib/content/schemas";

/**
 * Wayne's posts. People should be able to find that from the top of the page,
 * not from the bottom of the footer. Every URL comes from the settings row, so
 * the owner changes where these point from Admin -> Website settings; an empty
 * URL simply removes that icon rather than linking nowhere.
 *
 * Brand glyphs are filled paths, so they are drawn here rather than through
 * SiteIcon, which draws single-stroke outlines.
 */

const glyphs: Record<"facebook" | "instagram" | "tiktok", string | string[]> = {
  facebook:
    "M22 12.06C22 6.5 17.52 2 12 2S2 6.5 2 12.06C2 17.08 5.66 21.24 10.44 22v-7.02H7.9v-2.92h2.54V9.85c0-2.52 1.49-3.91 3.77-3.91 1.09 0 2.24.2 2.24.2v2.46h-1.26c-1.24 0-1.63.78-1.63 1.57v1.89h2.78l-.45 2.92h-2.33V22C18.34 21.24 22 17.08 22 12.06Z",
  instagram: [
    "M12 2.16c3.2 0 3.58.01 4.85.07 1.17.05 1.8.25 2.23.41.56.22.96.48 1.38.9.42.42.68.82.9 1.38.16.42.36 1.06.41 2.23.06 1.27.07 1.65.07 4.85s-.01 3.58-.07 4.85c-.05 1.17-.25 1.8-.41 2.23-.22.56-.48.96-.9 1.38-.42.42-.82.68-1.38.9-.42.16-1.06.36-2.23.41-1.27.06-1.65.07-4.85.07s-3.58-.01-4.85-.07c-1.17-.05-1.8-.25-2.23-.41a3.7 3.7 0 0 1-1.38-.9 3.7 3.7 0 0 1-.9-1.38c-.16-.42-.36-1.06-.41-2.23-.06-1.27-.07-1.65-.07-4.85s.01-3.58.07-4.85c.05-1.17.25-1.8.41-2.23.22-.56.48-.96.9-1.38.42-.42.82-.68 1.38-.9.42-.16 1.06-.36 2.23-.41 1.27-.06 1.65-.07 4.85-.07Z",
    "M12 7.38a4.62 4.62 0 1 0 0 9.24 4.62 4.62 0 0 0 0-9.24Zm0 7.62a3 3 0 1 1 0-6 3 3 0 0 1 0 6Z",
    "M18.5 7.2a1.08 1.08 0 1 1-2.16 0 1.08 1.08 0 0 1 2.16 0Z",
  ],
  tiktok:
    "M16.6 5.82A4.28 4.28 0 0 1 15.54 3h-3.09v12.4a2.59 2.59 0 1 1-1.79-2.46V9.8a5.68 5.68 0 1 0 4.88 5.62V9.01a7.35 7.35 0 0 0 4.3 1.38V7.3a4.28 4.28 0 0 1-3.24-1.48Z",
};

function Glyph({ name }: { name: keyof typeof glyphs }) {
  const path = glyphs[name];
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
      {Array.isArray(path) ? (
        path.map((segment) => <path d={segment} key={segment.slice(0, 12)} fillRule="evenodd" />)
      ) : (
        <path d={path} />
      )}
    </svg>
  );
}

export function SocialLinks({
  className = "",
  settings,
}: {
  className?: string;
  settings: Pick<StoreSettings, "facebook_url" | "instagram_url" | "tiktok_url" | "store_name">;
}) {
  const links = [
    { name: "tiktok" as const, label: "TikTok", url: settings.tiktok_url },
    { name: "instagram" as const, label: "Instagram", url: settings.instagram_url },
    { name: "facebook" as const, label: "Facebook", url: settings.facebook_url },
  ].filter((link) => link.url);
  if (!links.length) return null;
  return (
    <div className={`social-links ${className}`.trim()}>
      {links.map((link) => (
        <a
          aria-label={`${settings.store_name} on ${link.label}`}
          className={`social-link is-${link.name}`}
          href={link.url}
          key={link.name}
          rel="noreferrer noopener"
          target="_blank"
        >
          <Glyph name={link.name} />
        </a>
      ))}
    </div>
  );
}
