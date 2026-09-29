import { getStorefront } from "@/lib/content/queries";
import { brandNames } from "@/lib/content/schemas";
import { RewardsButton } from "./rewards-experience";
import styles from "./rewards.module.css";

export async function RewardsSection() {
  const brand = brandNames((await getStorefront()).settings);
  return (
    <section className={styles.rewardsBand} id="rewards">
      <div>
        <span className={styles.eyebrow}>{brand.rewardsName.toUpperCase()}</span>
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
        <span>{brand.brandName.toUpperCase()} ★</span>
        <strong>
          Officially
          <br />a pizza person.
        </strong>
        <div>
          <span>{brand.rewardsName.toUpperCase()}</span>
          <span>MEMBER CLUB ↗</span>
        </div>
      </div>
    </section>
  );
}
