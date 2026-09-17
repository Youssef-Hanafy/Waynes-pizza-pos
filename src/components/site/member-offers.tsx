"use client";

import { useState, type FormEvent } from "react";
import { RewardsButton } from "./rewards-experience";
import { SiteIcon } from "./site-icon";

/**
 * The second card.
 *
 * The join card asks for a name and a number because the person filling it in
 * is not a member yet.  Someone who already gets Wayne's texts should not have
 * to sign up again to find out what this week's offer is — they type the number
 * their texts go to and their offers appear.
 *
 * A number with no membership behind it gets the invitation instead of an
 * error, because "you aren't in the club" and "here is how to join" are the same
 * answer.
 */

type Offer = {
  id: string;
  code: string;
  description: string;
  discount_type: "fixed" | "percent";
  discount_value: number;
  minimum_order_cents: number;
  fulfillment_type: "pickup" | "delivery" | null;
  ends_at: string | null;
  personal: boolean;
};

const headline = (offer: Offer) =>
  offer.discount_type === "percent"
    ? `${offer.discount_value / 100}% off`
    : `$${(offer.discount_value / 100).toFixed(2).replace(/\.00$/, "")} off`;

function condition(offer: Offer) {
  const parts: string[] = [];
  if (offer.minimum_order_cents > 0) parts.push(`on orders over $${(offer.minimum_order_cents / 100).toFixed(2)}`);
  if (offer.fulfillment_type) parts.push(`${offer.fulfillment_type} only`);
  if (offer.ends_at)
    parts.push(`through ${new Date(offer.ends_at).toLocaleDateString("en-US", { month: "long", day: "numeric" })}`);
  return parts.join(" · ");
}

export function MemberOffers() {
  const [phone, setPhone] = useState("");
  const [status, setStatus] = useState<"idle" | "checking">("idle");
  const [result, setResult] = useState<{ member: boolean; first_name?: string; offers: Offer[] } | null>(null);
  const [error, setError] = useState("");

  async function check(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setResult(null);
    setStatus("checking");
    try {
      const response = await fetch("/api/rewards/offers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "We couldn’t check that number.");
      setResult(body);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Please try again in a moment.");
    } finally {
      setStatus("idle");
    }
  }

  return (
    <section className="member-offers" id="member-offers">
      <span className="eyebrow">ALREADY A MEMBER?</span>
      <h2>
        See what’s
        <br />
        <em>waiting for you.</em>
      </h2>
      <p>
        Enter the mobile number your Wayne’s texts go to and we’ll show this
        week’s member offers and any code you haven’t used yet.
      </p>
      <form className="member-offers-form" onSubmit={check}>
        <label>
          Mobile number
          <input
            autoComplete="tel"
            inputMode="tel"
            maxLength={24}
            onChange={(event) => setPhone(event.target.value)}
            placeholder="(508) 000-0000"
            required
            type="tel"
            value={phone}
          />
        </label>
        <button disabled={status === "checking"} type="submit">
          {status === "checking" ? "Checking…" : "See my offers"}
          <SiteIcon name="arrow" size={17} />
        </button>
      </form>

      {error ? (
        <p className="member-offers-error" role="alert">
          {error}
        </p>
      ) : null}

      {result && !result.member ? (
        <div className="member-offers-join" role="status">
          <strong>This number isn’t in Wayne’s Rewards yet.</strong>
          <p>
            Members get offers texted to them and a free small side on their
            first order. It’s free, and it takes a few seconds.
          </p>
          <RewardsButton className="order-button">Join Wayne’s Rewards →</RewardsButton>
        </div>
      ) : null}

      {result?.member ? (
        <div className="member-offers-result" role="status">
          <strong>
            {result.first_name ? `Hi ${result.first_name} — ` : ""}
            {result.offers.length
              ? `${result.offers.length} offer${result.offers.length === 1 ? "" : "s"} ready to use.`
              : "You’re a member — no offers running this week."}
          </strong>
          {result.offers.length ? (
            <ul>
              {result.offers.map((offer) => (
                <li key={offer.id}>
                  <p className="member-offer-headline">{headline(offer)}</p>
                  <p className="member-offer-description">
                    {offer.description || (offer.personal ? "Your welcome offer." : "Member offer.")}
                  </p>
                  {condition(offer) ? <p className="member-offer-condition">{condition(offer)}</p> : null}
                  <code>{offer.code}</code>
                </li>
              ))}
            </ul>
          ) : (
            <p>Keep an eye on your texts — the next one lands soon.</p>
          )}
        </div>
      ) : null}
    </section>
  );
}
