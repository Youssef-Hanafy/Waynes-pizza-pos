import { SiteHeader } from "@/components/site/site-header";
import { SiteFooter } from "@/components/site/site-footer";
import { DealCard } from "@/components/site/deal-card";
import { MemberOffers } from "@/components/site/member-offers";
import { getStoreSettings } from "@/lib/content/queries";
import { getPublicPromotions } from "@/lib/promotions/public";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Offers",
  description: "Wayne’s Pizza deals, plus member-only offers for Wayne’s Rewards.",
};

/**
 * Two kinds of offer live here.  The deals on the left are for everybody and
 * come straight from Admin -> Promotions.  The card on the right is for people
 * who already get Wayne's texts: they check their number and see the offers
 * saved for members that week.  Someone who is not a member sees the invitation
 * instead of an empty page.
 */
export default async function OffersPage() {
  const [settings, promotions] = await Promise.all([getStoreSettings(), getPublicPromotions()]);
  return (
    <div className="storefront">
      <SiteHeader settings={settings} />
      <main id="main-content">
        <div className="site-container offers-page-layout">
          <section>
            <p className="eyebrow">DEALS FOR EVERYONE</p>
            <h1 className="mt-2 text-4xl font-black">This week at Wayne’s</h1>
            {promotions.length ? (
              <div className="mt-6 grid gap-4">
                {promotions.map((promotion) => (
                  <DealCard key={promotion.id} promotion={promotion} />
                ))}
              </div>
            ) : (
              <p className="mt-6 rounded-2xl border-2 border-dashed border-wayne-border p-6 text-wayne-muted">
                No public deals are running right now. Members still get their
                own offers by text — check yours on the right.
              </p>
            )}
          </section>
          <MemberOffers />
        </div>
      </main>
      <SiteFooter settings={settings} />
    </div>
  );
}
