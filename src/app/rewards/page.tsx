import { SiteHeader } from "@/components/site/site-header";
import { SiteFooter } from "@/components/site/site-footer";
import { RewardsSection } from "@/components/site/rewards-section";
import { MemberOffers } from "@/components/site/member-offers";
import { getStoreSettings, storefrontSettings } from "@/lib/content/queries";
import { brandNames } from "@/lib/content/schemas";
export const dynamic = "force-dynamic";
export async function generateMetadata() {
  const { rewardsName } = brandNames(await getStoreSettings());
  return { title: rewardsName, description: `Join ${rewardsName} for member-only offers by text.` };
}
export default async function RewardsPage() {
  const settings = await storefrontSettings("sms");
  return <div className="storefront"><SiteHeader settings={settings} /><main id="main-content"><h1 className="sr-only">{brandNames(settings).rewardsName}</h1><RewardsSection /><div className="site-container" style={{ paddingBottom: 60 }}><MemberOffers /></div></main><SiteFooter settings={settings} /></div>;
}
