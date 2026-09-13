import Image from "next/image";
import { getPublicAssetUrl } from "@/lib/images/public-url";

export function MenuImage({
  alt,
  path,
  preload = false,
}: {
  alt: string;
  path: string | null;
  preload?: boolean;
}) {
  const url = getPublicAssetUrl(path);

  /*
   * Until a photograph is uploaded this has to look like a decision rather than a
   * hole in the page — eight tiles of the same broken-image emoji is what a
   * half-finished site looks like. A quiet brand mark on warm paper reads as
   * deliberate, and disappears the moment a real photo lands.
   */
  if (!url) {
    return (
      <div aria-hidden="true" className="relative grid aspect-[4/3] place-items-center overflow-hidden bg-gradient-to-br from-wayne-cream-deep via-wayne-cream to-wayne-red-soft">
        <span className="grid h-14 w-14 place-items-center rounded-full border-2 border-wayne-green/20 font-display text-xl font-black text-wayne-green/35">
          W
        </span>
      </div>
    );
  }

  return (
    <Image
      alt={alt}
      className="aspect-[4/3] w-full object-cover transition duration-300 group-hover:scale-[1.03]"
      height={480}
      preload={preload}
      src={url}
      width={640}
    />
  );
}
