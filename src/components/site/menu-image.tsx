import Image from "next/image";
import { getPublicAssetUrl } from "@/lib/images/public-url";

/*
 * Every photo on the storefront is owner-uploaded through Admin -> Menu photos
 * and served from Supabase storage. Nothing here ships an image with the code,
 * so swapping a picture never needs a deploy.
 *
 * Until a photo is uploaded the slot still has to look designed rather than
 * broken, so it falls back to Wayne's tiled wordmark - the same motif as the
 * store's social posts - with the slice mark on top.
 */
export function MenuImage({
  alt,
  path,
  name,
  preload = false,
  sizes = "(max-width: 640px) 90vw, (max-width: 1024px) 45vw, 28vw",
}: {
  alt: string;
  path: string | null;
  preload?: boolean;
  category?: string;
  name?: string;
  sizes?: string;
}) {
  const url = getPublicAssetUrl(path);
  if (!url) return <MenuImageFallback label={name} />;

  return (
    <div className="menu-photo">
      <Image
        alt={alt}
        className="menu-photo-img"
        fill
        priority={preload}
        sizes={sizes}
        src={url}
      />
    </div>
  );
}

export function MenuImageFallback({ label }: { label?: string }) {
  void label;
  return (
    <div className="menu-photo menu-photo-empty">
      <svg
        aria-hidden="true"
        className="menu-photo-pattern"
        preserveAspectRatio="xMidYMid slice"
        viewBox="0 0 300 200"
      >
        <defs>
          <pattern
            height="46"
            id="wayne-wordmark-tile"
            patternUnits="userSpaceOnUse"
            width="196"
          >
            <text
              fill="#ffffff"
              fontFamily="Georgia, 'Times New Roman', serif"
              fontSize="21"
              fontStyle="italic"
              fontWeight="700"
              opacity="0.09"
              x="0"
              y="20"
            >
              Waynes Pizza
            </text>
            <text
              fill="#ffffff"
              fontFamily="Georgia, 'Times New Roman', serif"
              fontSize="21"
              fontStyle="italic"
              fontWeight="700"
              opacity="0.09"
              x="-98"
              y="42"
            >
              Waynes Pizza
            </text>
          </pattern>
        </defs>
        <rect fill="#1f4b3a" height="200" width="300" />
        <rect fill="url(#wayne-wordmark-tile)" height="200" width="300" />
      </svg>
      <span className="menu-photo-empty-mark" aria-hidden>
        <svg viewBox="0 0 64 64" width="100%" height="100%">
          <path d="M6 22c16-9 36-9 52 0L32 60Z" fill="#f3c064" />
          <path d="M6 22c16-9 36-9 52 0l-4 6c-14-7-30-7-44 0Z" fill="#d98c2f" />
          <circle cx="24" cy="34" fill="#b02222" r="4.2" />
          <circle cx="41" cy="33" fill="#b02222" r="3.6" />
          <circle cx="32" cy="46" fill="#b02222" r="3.2" />
        </svg>
      </span>
    </div>
  );
}
