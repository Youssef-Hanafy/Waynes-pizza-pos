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
  if (!url)
    return (
      <div
        aria-hidden="true"
        className="grid aspect-[4/3] place-items-center bg-gradient-to-br from-red-50 to-amber-100 text-5xl"
      >
        🍕
      </div>
    );
  return (
    <Image
      alt={alt}
      className="aspect-[4/3] w-full object-cover"
      height={480}
      preload={preload}
      src={url}
      width={640}
    />
  );
}
