import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage } from "@/components/site/legal-page";
import { getStoreSettings } from "@/lib/content/queries";
import { formatAddress } from "@/lib/content/schemas";
import { PRIVACY_UPDATED } from "@/lib/wayne/legal";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const settings = await getStoreSettings();
  return {
    title: `Privacy Policy | ${settings.store_name}`,
    description: `How ${settings.store_name} collects, uses and protects your information when you order or join Wayne's Rewards.`,
    alternates: { canonical: settings.canonical_url ? `${settings.canonical_url}/privacy` : "/privacy" },
  };
}

export default async function PrivacyPage() {
  const settings = await getStoreSettings();
  const name = settings.store_name;
  return <LegalPage eyebrow="Privacy" settings={settings} title="Privacy policy" updated={PRIVACY_UPDATED}>
    <p>This policy explains what {name} ({formatAddress(settings)}) collects when you order from us or join Wayne&apos;s Rewards, and what we do with it.</p>
    <h2>What we collect</h2>
    <ul>
      <li>Your name, phone number and email, and a delivery address when you order delivery.</li>
      <li>Your orders: what you ordered, when, totals, and how you paid (card payments are handled by our payment processor; we never store your full card number).</li>
      <li>Whether you&apos;ve agreed to receive our texts or emails, and when and where you agreed.</li>
      <li>Caller ID (the number calling) when you phone the store, so staff can pull up your past orders and address.</li>
    </ul>
    <h2>How we use it</h2>
    <ul>
      <li>To make, deliver and support your order, including texts about your order.</li>
      <li>To run Wayne&apos;s Rewards: your member offers, and deals and reminders if you&apos;ve opted in.</li>
      <li>To understand what our customers order so we can run the shop better.</li>
    </ul>
    <h2>Text messages</h2>
    <p><strong>We do not sell, rent or share your mobile number or text-messaging opt-in with third parties or affiliates for their marketing.</strong> Your number is shared only with the service providers that send our texts and run our ordering system for us, and only to do that. Text-messaging opt-in data and consent are never shared with any third party. See our <Link href="/terms">text messaging terms</Link>. Reply STOP to any text to opt out.</p>
    <h2>Who else sees it</h2>
    <p>Service providers who work for us (ordering and database hosting, payment processing, text and email delivery) and only as needed to provide their service, and authorities when the law requires it. We don&apos;t sell personal information.</p>
    <h2>Keeping it safe</h2>
    <p>Staff accounts are individual and limited to what each role needs, and sensitive changes (refunds, discounts, customer removals, settings) are recorded in an audit log.</p>
    <h2>Your choices</h2>
    <p>You can opt out of texts (reply STOP) or emails (unsubscribe link) at any time. To see, correct or delete your information, call <a href={`tel:${settings.public_phone}`}>{settings.public_phone}</a>{settings.public_email ? <> or email <a href={`mailto:${settings.public_email}`}>{settings.public_email}</a></> : null}. Deleting your details removes you from our marketing; order records we must keep for tax purposes are kept without your personal details.</p>
    <h2>Changes</h2>
    <p>If we change this policy we&apos;ll update the date at the top of this page.</p>
  </LegalPage>;
}
