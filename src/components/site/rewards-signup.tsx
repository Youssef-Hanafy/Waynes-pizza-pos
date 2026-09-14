"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { SiteIcon } from "./site-icon";
import { WayneBadge } from "./wayne-badge";
import {
  WAYNE_REWARDS_CONSENT,
  WAYNE_REWARDS_CONSENT_VERSION,
} from "@/lib/wayne/rewards";
import styles from "./rewards.module.css";

const perks = [
  "Member-only deals",
  "First to hear about specials",
  "Free to join",
];

export function RewardsSignup({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
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
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setStatus("submitting");
    try {
      const response = await fetch("/api/rewards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          firstName,
          lastName,
          phone,
          consent,
          consentVersion: WAYNE_REWARDS_CONSENT_VERSION,
        }),
      });
      const result = await response.json();
      if (!response.ok || !result.ok)
        throw new Error(
          result.error || "We couldn’t complete your signup. Please try again.",
        );
      setStatus("done");
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Please try again in a moment.",
      );
      setStatus("idle");
    }
  }

  return (
    <dialog
      aria-labelledby="rewards-title"
      className={styles.dialog}
      onCancel={onClose}
      onClose={onClose}
      onClick={(event) => {
        if (event.target !== dialog.current) return;
        const bounds = dialog.current.getBoundingClientRect();
        if (
          event.clientX < bounds.left ||
          event.clientX > bounds.right ||
          event.clientY < bounds.top ||
          event.clientY > bounds.bottom
        )
          onClose();
      }}
      ref={dialog}
    >
      <button
        aria-label="Close"
        autoFocus
        className={styles.dialogClose}
        onClick={onClose}
        type="button"
      >
        <SiteIcon name="close" size={18} />
      </button>

      <div className={styles.dialogIntro}>
        <WayneBadge className={styles.dialogBadge} size={62} />
        <span className={styles.eyebrow}>WAYNE’S REWARDS</span>
        <h2 id="rewards-title">
          Good pizza.
          <br />
          <em>Better perks.</em>
        </h2>
        <p>
          Drop your number and we’ll text you the deals we save for regulars.
        </p>
        <ul className={styles.perks}>
          {perks.map((perk) => (
            <li key={perk}>
              <SiteIcon name="check" size={14} />
              {perk}
            </li>
          ))}
        </ul>
      </div>

      {status === "done" ? (
        <div className={styles.signupSuccess} role="status">
          <span className={styles.successMark}>
            <SiteIcon name="check" size={30} />
          </span>
          <h3>You’re in.</h3>
          <p>
            Welcome to Wayne’s Rewards. Watch your texts — the good offers land
            there first.
          </p>
          <button onClick={onClose} type="button">
            Let’s find your pizza <SiteIcon name="arrow" size={16} />
          </button>
        </div>
      ) : (
        <form className={styles.signupForm} onSubmit={submit}>
          <div className={styles.nameFields}>
            <label>
              First name
              <input
                autoComplete="given-name"
                maxLength={100}
                onChange={(event) => setFirstName(event.target.value)}
                required
                value={firstName}
              />
            </label>
            <label>
              Last name
              <input
                autoComplete="family-name"
                maxLength={100}
                onChange={(event) => setLastName(event.target.value)}
                required
                value={lastName}
              />
            </label>
          </div>
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
          <label className={styles.consent}>
            <input
              checked={consent}
              onChange={(event) => setConsent(event.target.checked)}
              required
              type="checkbox"
            />
            <span>{WAYNE_REWARDS_CONSENT}</span>
          </label>
          {error && (
            <p className={styles.signupError} role="alert">
              {error}
            </p>
          )}
          <button disabled={status === "submitting"} type="submit">
            {status === "submitting" ? "Joining…" : "Join Wayne’s Rewards"}
            <SiteIcon name="arrow" size={17} />
          </button>
          <button
            className={styles.dismiss}
            onClick={onClose}
            type="button"
          >
            No thanks, I’m just hungry
          </button>
        </form>
      )}
    </dialog>
  );
}
