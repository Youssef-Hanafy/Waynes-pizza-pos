"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { SiteIcon } from "./site-icon";
const ArrowRight = ({ size = 18 }: { size?: number }) => <SiteIcon name="arrow" size={size} />;
const Check = ({ size = 18 }: { size?: number }) => <SiteIcon name="check" size={size} />;
const Gift = ({ size = 18 }: { size?: number }) => <SiteIcon name="bag" size={size} />;
const X = ({ size = 18 }: { size?: number }) => <SiteIcon name="close" size={size} />;
import { WAYNE_REWARDS_CONSENT, WAYNE_REWARDS_CONSENT_VERSION } from "@/lib/wayne/rewards";
import styles from "./rewards.module.css";

export function RewardsSignup({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  const [consent, setConsent] = useState(false);
  const [status, setStatus] = useState<"idle" | "submitting" | "done">("idle");
  const [error, setError] = useState("");

  useEffect(() => {
    const element = dialog.current;
    if (open && !element?.open) element?.showModal();
    if (!open && element?.open) element.close();
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previousOverflow; };
  }, [open]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setStatus("submitting");
    try {
      const response = await fetch("/api/rewards", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ firstName, lastName, phone, consent, consentVersion: WAYNE_REWARDS_CONSENT_VERSION })
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || "We couldn’t complete your signup. Please try again.");
      setStatus("done");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Please try again in a moment.");
      setStatus("idle");
    }
  }

  return <dialog ref={dialog} className={styles.dialog} aria-labelledby="rewards-title" onCancel={onClose} onClose={onClose} onClick={(event) => { if (event.target === dialog.current) { const bounds = dialog.current.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose(); } }}>
    <button className={styles.dialogClose} type="button" aria-label="Close rewards signup" onClick={onClose} autoFocus><X size={18} /></button>
    <div className={styles.dialogIntro}><Gift size={29} aria-hidden="true" /><span className={styles.eyebrow}>WAYNE’S REWARDS · TEXT DAILY</span><h2 id="rewards-title">Good pizza.<br /><em>Better perks.</em></h2><p>Join the Wayne’s text club for member offers and more reasons to make it a pizza night.</p></div>
    {status === "done" ? <div className={styles.signupSuccess} role="status"><Check size={34} /><h3>You’re on the list!</h3><p>Your Text Daily signup is saved. Keep an eye out for Wayne’s member offers.</p><button onClick={onClose}>Let’s find your pizza <ArrowRight size={14} /></button></div> : <form className={styles.signupForm} onSubmit={submit}>
      <div className={styles.nameFields}><label>First name<input required autoComplete="given-name" maxLength={100} value={firstName} onChange={(event) => setFirstName(event.target.value)} /></label><label>Last name<input required autoComplete="family-name" maxLength={100} value={lastName} onChange={(event) => setLastName(event.target.value)} /></label></div>
      <label>Mobile number<input type="tel" autoComplete="tel" inputMode="tel" required maxLength={24} placeholder="(508) 000-0000" value={phone} onChange={(event) => setPhone(event.target.value)} /></label>
      <label className={styles.consent}><input type="checkbox" required checked={consent} onChange={(event) => setConsent(event.target.checked)} /><span>{WAYNE_REWARDS_CONSENT}</span></label>
      {error && <p className={styles.signupError} role="alert">{error}</p>}
      <button type="submit" disabled={status === "submitting"}>{status === "submitting" ? "Joining…" : "Join Text Daily"}<ArrowRight size={17} /></button>
      <small>Free to join. Your next favorite offer starts here.</small>
    </form>}
  </dialog>;
}
