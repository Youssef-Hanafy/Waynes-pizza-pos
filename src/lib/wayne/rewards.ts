/**
 * Text-club (Rewards) consent.  The wording is a template filled with the
 * business's brand name; its version changes only when the template changes,
 * and the version is what each consent record stores as proof.
 */
export const REWARDS_CONSENT_VERSION = "2026-09-13";

export function rewardsConsentText(brandName: string) {
  return `I agree to receive recurring automated marketing texts from ${brandName} at this number. Consent is not a condition of purchase. Message frequency varies. Message and data rates may apply. Reply STOP to opt out or HELP for help.`;
}

export function parseRewardsSignup(body: unknown) {
  if (!body || typeof body !== "object") throw new Error("Enter your mobile number and agree to receive texts.");
  const value = body as Record<string, unknown>;
  if (typeof value.phone !== "string" || value.phone.length > 24 || !/^[+\d().\s-]+$/.test(value.phone)) throw new Error("Enter a valid 10-digit US mobile number.");
  const digits = typeof value.phone === "string" ? value.phone.replace(/\D/g, "") : "";
  const national = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(national)) throw new Error("Enter a valid 10-digit US mobile number.");
  if (value.consent !== true) throw new Error("Please check the box to agree to marketing texts.");
  if (value.consentVersion !== REWARDS_CONSENT_VERSION) throw new Error("Please refresh this page and review the current signup terms.");
  return { phone: `+1${national}`, consentVersion: REWARDS_CONSENT_VERSION };
}
