import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage } from "@/components/site/legal-page";
import { getStoreSettings } from "@/lib/content/queries";
import { formatAddress } from "@/lib/content/schemas";
import { SMS_TERMS_UPDATED } from "@/lib/wayne/legal";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const settings = await getStoreSettings();
  return {
    title: `Text Messaging Terms | ${settings.store_name}`,
    description: `Terms for ${settings.store_name} text messages and Wayne's Rewards: how to join, message frequency, costs, and how to opt out.`,
    alternates: { canonical: settings.canonical_url ? `${settings.canonical_url}/terms` : "/terms" },
  };
}

/**
 * SMS program terms.  Carriers (10DLC) require the opt-in page to link a page
 * that names the program, says what is sent and how often, that message and
 * data rates may apply, and how STOP and HELP work.
 */
export default async function TermsPage() {
  const settings = await getStoreSettings();
  const name = settings.store_name;
  return <LegalPage eyebrow="Wayne's Rewards" settings={settings} title="Text messaging terms" updated={SMS_TERMS_UPDATED}>
    <p>These terms cover text messages from <strong>{name}</strong>, {formatAddress(settings)} (the &ldquo;Wayne&apos;s Rewards&rdquo; text club).</p>
    <h2>What you get</h2>
    <p>Recurring automated marketing texts: deals, coupons, member offers, new menu items and reminders when we haven&apos;t seen you in a while. Separately, if you order, we may text you about that order (for example that it&apos;s ready or on the way).</p>
    <h2>How you join</h2>
    <p>By checking the text-messaging box on our Wayne&apos;s Rewards signup or at checkout and submitting your number, you agree to receive recurring automated marketing texts from {name} at that number. Consent is not a condition of any purchase.</p>
    <h2>How often</h2>
    <p>Message frequency varies, typically a few messages a month.</p>
    <h2>Cost</h2>
    <p>Message and data rates may apply. Check your mobile plan for details. {name} does not charge for texts.</p>
    <h2>Stop or get help any time</h2>
    <ul>
      <li>Reply <strong>STOP</strong> to any message to opt out. You&apos;ll get one message confirming you&apos;re unsubscribed and no more marketing texts after that. <strong>START</strong> re-subscribes you.</li>
      <li>Reply <strong>HELP</strong> for help, or call us at <a href={`tel:${settings.public_phone}`}>{settings.public_phone}</a>{settings.public_email ? <> or email <a href={`mailto:${settings.public_email}`}>{settings.public_email}</a></> : null}.</li>
    </ul>
    <h2>Carriers</h2>
    <p>Carriers are not liable for delayed or undelivered messages.</p>
    <h2>Your information</h2>
    <p>How we handle your number and information is explained in our <Link href="/privacy">Privacy Policy</Link>. We never sell or share your mobile number or text-messaging opt-in with third parties or affiliates for their own marketing.</p>
  </LegalPage>;
}
