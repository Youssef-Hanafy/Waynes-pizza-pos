import Image from "next/image";
import { getPublicAssetUrl } from "@/lib/images/public-url";

export function MenuImage({
  alt,
  path,
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
  if (!url) return null;
  return <div className="menu-photo"><Image alt={alt} className="menu-photo-img" fill preload={preload} sizes={sizes} src={url} /></div>;
}
