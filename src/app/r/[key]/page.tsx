import { createHash } from "node:crypto";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { SiteHeader } from "@/components/site/site-header";
import { SiteFooter } from "@/components/site/site-footer";
import { MemberOffers } from "@/components/site/member-offers";
import { OfferList, PersonalLink } from "@/components/site/offer-list";
import { RewardsButton } from "@/components/site/rewards-experience";
import { getStoreSettings } from "@/lib/content/queries";
import { logger } from "@/lib/logging/logger";
import { checkoutRateLimitKey } from "@/lib/orders/rate-limit";
import { memberOffersSchema, type MemberOffersResult } from "@/lib/promotions/member-offers";
import { createServiceSupabaseClient } from "@/lib/supabase/server";

/**
 * A member's personal offers page: /r/<their link key>, or /r/<one of their
 * personal codes>.  This is where the links in Wayne's texts land — the weekly
 * "your offers are up" text and the win-back text both point here — so a
 * member sees their own codes without typing a phone number.
 *
 * The page never says whose link a bad key is, and the lookup shares the
 * storefront's rate limiter so links can't be guessed at speed.
 */
export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Your Wayne’s offers",
  robots: { index: false, follow: false },
};

type Lookup = { state: "ok"; result: MemberOffersResult } | { state: "limited" } | { state: "unavailable" };

async function lookUp(key: string): Promise<Lookup> {
  const db = createServiceSupabaseClient();
  const limit = await db.rpc("wayne_consume_public_order_rate_limit", {
    client_key: createHash("sha256").update(`offer-link:${checkoutRateLimitKey(await headers())}`).digest("hex"),
  });
  if (limit.error || limit.data !== true) return { state: "limited" };
  const { data, error } = await db.rpc("wayne_member_offers_by_link", { link_key: key });
  if (error) {
    logger.error("offers.link_failed", error);
    return { state: "unavailable" };
  }
  const parsed = memberOffersSchema.safeParse(data);
  if (!parsed.success) {
    logger.error("offers.link_invalid", { issue: parsed.error.issues[0]?.message });
    return { state: "unavailable" };
  }
  return { state: "ok", result: parsed.data };
}

export default async function PersonalOffersPage({ params }: { params: Promise<{ key: string }> }) {
  const [{ key }, settings] = await Promise.all([params, getStoreSettings()]);
  const lookup = await lookUp(decodeURIComponent(key).slice(0, 60));
  const result = lookup.state === "ok" ? lookup.result : null;

  return (
    <div className="storefront">
      <SiteHeader settings={settings} />
      <main id="main-content">
        <div className="site-container personal-offers-page">
          {result?.member ? (
            <section className="member-offers">
              <span className="eyebrow">WAYNE’S REWARDS</span>
              <h1 className="mt-2 text-4xl font-black">
                {result.first_name ? `${result.first_name}, here` : "Here"}’s
                <br />
                <em className="not-italic text-wayne-red">what’s waiting for you.</em>
              </h1>
              <div className="member-offers-result">
                {result.offers.length ? (
                  <>
                    <strong>
                      {result.offers.length} offer{result.offers.length === 1 ? "" : "s"} ready to use. Tap “Use this
                      code” and it’s filled in at checkout.
                    </strong>
                    <OfferList offers={result.offers} />
                  </>
                ) : (
                  <p>No offers right now — keep an eye on your texts, the next one lands soon.</p>
                )}
                {result.link_key ? <PersonalLink linkKey={result.link_key} /> : null}
              </div>
            </section>
          ) : lookup.state === "ok" ? (
            <>
              <section className="member-offers">
                <span className="eyebrow">WAYNE’S REWARDS</span>
                <h1 className="mt-2 text-3xl font-black">This link isn’t active.</h1>
                <p>
                  It may have been typed wrong, or the membership was closed. Check your offers with your phone number
                  below, or join Wayne’s Rewards — it’s free.
                </p>
                <RewardsButton className="order-button">Join Wayne’s Rewards →</RewardsButton>
              </section>
              <div className="mt-6">
                <MemberOffers />
              </div>
            </>
          ) : (
            <section className="member-offers">
              <h1 className="text-3xl font-black">
                {lookup.state === "limited" ? "Please wait a few minutes and try again." : "Offers are unavailable right now."}
              </h1>
              <p>You can still order — any code you have works at checkout.</p>
            </section>
          )}
        </div>
      </main>
      <SiteFooter settings={settings} />
    </div>
  );
}
