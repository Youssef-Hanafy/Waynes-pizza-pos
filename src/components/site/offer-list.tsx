"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { SAVED_PROMO_STORAGE_KEY, memberOfferLinkPath, type MemberOffer } from "@/lib/promotions/member-offers";

/**
 * One member's offers, as cards.  Used by the phone lookup and by the personal
 * link page so the two always look the same.
 *
 * "Use this code" remembers the code for checkout and goes to the menu — the
 * customer never has to copy a code out of a text.
 */

const headline = (offer: MemberOffer) =>
  offer.discount_type === "percent"
    ? `${offer.discount_value / 100}% off`
    : `$${(offer.discount_value / 100).toFixed(2).replace(/\.00$/, "")} off`;

function condition(offer: MemberOffer) {
  const parts: string[] = [];
  if (offer.minimum_order_cents > 0) parts.push(`on orders over $${(offer.minimum_order_cents / 100).toFixed(2)}`);
  if (offer.fulfillment_type) parts.push(`${offer.fulfillment_type} only`);
  if (offer.ends_at)
    parts.push(`good through ${new Date(offer.ends_at).toLocaleDateString("en-US", { month: "long", day: "numeric" })}`);
  return parts.join(" · ");
}

export function OfferList({ offers }: { offers: MemberOffer[] }) {
  const router = useRouter();
  function use(code: string) {
    try {
      window.localStorage.setItem(SAVED_PROMO_STORAGE_KEY, code);
    } catch {
      // Private browsing: the code is still on screen to type in.
    }
    router.push("/menu");
  }
  return (
    <ul>
      {offers.map((offer) => (
        <li key={offer.id}>
          <p className="member-offer-headline">{headline(offer)}</p>
          <p className="member-offer-description">
            {offer.description || (offer.personal ? "Your personal offer." : "Member offer.")}
          </p>
          {condition(offer) ? <p className="member-offer-condition">{condition(offer)}</p> : null}
          <div className="member-offer-actions">
            <code>{offer.code}</code>
            <button onClick={() => use(offer.code)} type="button">
              Use this code →
            </button>
          </div>
          {offer.personal ? <p className="member-offer-condition">Just for you — works with your phone number, once.</p> : null}
        </li>
      ))}
    </ul>
  );
}

/** "Your personal link" — bookmark it, or tap the one in your texts. */
export function PersonalLink({ linkKey }: { linkKey: string }) {
  const [copied, setCopied] = useState(false);
  const [origin, setOrigin] = useState("");
  useEffect(() => {
    // Read after hydration so the server and browser render the same first frame.
    const value = window.location.origin;
    queueMicrotask(() => setOrigin(value));
  }, []);
  const path = memberOfferLinkPath(linkKey);
  const url = `${origin}${path}`;
  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }
  return (
    <div className="member-offer-link">
      <p>
        <strong>Your personal offers link</strong> — opens your offers without typing your number. The link in
        Wayne’s texts goes to the same place.
      </p>
      <div className="member-offer-actions">
        <a href={path}>{url.replace(/^https?:\/\//, "")}</a>
        <button onClick={copy} type="button">
          {copied ? "Copied" : "Copy link"}
        </button>
      </div>
    </div>
  );
}
