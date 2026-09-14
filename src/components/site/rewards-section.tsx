import { RewardsButton } from "./rewards-experience";
import styles from "./rewards.module.css";

export function RewardsSection() {
  return (
    <section className={styles.rewardsBand} id="rewards">
      <div>
        <span className={styles.eyebrow}>WAYNE’S REWARDS</span>
        <h2>
          You bring the appetite.
          <br />
          <em>We’ll bring the perks.</em>
        </h2>
        <p>
          Join today and your first order comes with a free small side.
          After that it’s member-only deals texted straight to you — no app, no
          points to chase. Free to join, easy to love.
        </p>
        <RewardsButton>Count me in →</RewardsButton>
        <small>No purchase needed to join. Opt out anytime.</small>
      </div>
      <div className={styles.memberCard}>
        <span>WAYNE’S PIZZA ★</span>
        <strong>
          Officially
          <br />a pizza person.
        </strong>
        <div>
          <span>WAYNE’S REWARDS</span>
          <span>MEMBER CLUB ↗</span>
        </div>
      </div>
    </section>
  );
}
