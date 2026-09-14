import { SiteHeader } from "@/components/site/site-header";
import { SiteFooter } from "@/components/site/site-footer";
import { RewardsSection } from "@/components/site/rewards-section";
import { getStoreSettings } from "@/lib/content/queries";
export const dynamic = "force-dynamic";
export const metadata = { title: "Wayne’s Rewards", description: "Join Wayne’s Rewards for member-only offers by text." };
export default async function RewardsPage() {
  const settings = await getStoreSettings();
  return <div className="storefront"><SiteHeader settings={settings} /><main id="main-content"><h1 className="sr-only">Wayne’s Rewards</h1><RewardsSection /></main><SiteFooter settings={settings} /></div>;
}
