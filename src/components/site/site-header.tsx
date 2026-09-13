import { RewardsExperience, RewardsButton } from "./rewards-experience";
import Image from "next/image";
import Link from "next/link";
import { getPublicAssetUrl } from "@/lib/images/public-url";
import { isStoreOpenNow } from "@/lib/content/store-status";
import type { StoreSettings } from "@/lib/content/schemas";
import { BrandMark } from "./brand-mark";
import { SiteIcon } from "./site-icon";
import { SiteNavigation } from "./site-navigation";

export function SiteHeader({ settings }: { settings: StoreSettings }) {
  const logoUrl = getPublicAssetUrl(settings.logo_path);
  const open = isStoreOpenNow(settings);
  return (
    <>
      <a href="#main-content" className="site-skip-link">
        Skip to content
      </a>
      <div className="site-topbar">
        <div className="site-container">
          <span>
            {settings.announcement_text ||
              "GOOD FOOD. GREAT NEIGHBORS. THAT’S WAYNE’S."}
          </span>
          <RewardsButton>Join Wayne’s Text Daily →</RewardsButton>
        </div>
      </div>
      <RewardsExperience />
      <header className="site-header">
        <div className="site-container header-inner">
          <Link
            className="site-logo"
            href="/"
            aria-label={`${settings.store_name} home`}
          >
            {logoUrl ? (
              <Image
                alt={settings.logo_alt}
                height={64}
                width={100}
                src={logoUrl}
                className="uploaded-logo"
              />
            ) : (
              <BrandMark />
            )}
          </Link>
          <div className="header-location">
            <SiteIcon name="pin" size={19} />
            <div>
              <strong>
                {settings.city}, {settings.state}
              </strong>
              <span>
                <i className={open ? "status-dot is-open" : "status-dot"} />
                {open ? "Open now" : "Currently closed"}{" "}
                <span className="location-address">
                  · {settings.address_line1}
                </span>
              </span>
            </div>
          </div>
          <SiteNavigation />
        </div>
      </header>
    </>
  );
}
