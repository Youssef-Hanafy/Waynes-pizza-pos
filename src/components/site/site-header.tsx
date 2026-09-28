import { RewardsExperience, RewardsButton } from "./rewards-experience";
import Image from "next/image";
import Link from "next/link";
import { getPublicAssetUrl } from "@/lib/images/public-url";
import { isStoreOpenNow } from "@/lib/content/store-status";
import type { StoreSettings } from "@/lib/content/schemas";
import { getStorefront } from "@/lib/content/queries";
import { brandNames } from "@/lib/content/schemas";
import { BrandMark } from "./brand-mark";
import { SiteIcon } from "./site-icon";
import { SiteNavigation } from "./site-navigation";
import { SocialLinks } from "./social-links";

export async function SiteHeader({ settings }: { settings: StoreSettings }) {
  // Rewards is a text program: offered only where this business has SMS on.
  const rewardsEnabled = (await getStorefront()).services.includes("sms");
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
              `GOOD FOOD. GREAT NEIGHBORS. THAT’S ${brandNames(settings).shortName.toUpperCase()}.`}
          </span>
          {rewardsEnabled ? <RewardsButton>Join {brandNames(settings).rewardsName} →</RewardsButton> : null}
        </div>
      </div>
      {rewardsEnabled ? <RewardsExperience /> : null}
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
              <BrandMark badgeLabel={brandNames(settings).shortName} name={settings.store_name} city={[settings.city, settings.state].filter(Boolean).join(", ")} />
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
          <SocialLinks className="header-social" settings={settings} />
          <SiteNavigation social={<SocialLinks settings={settings} />} />
        </div>
      </header>
    </>
  );
}
