import { RewardsButton } from "./rewards-experience";
import styles from "./rewards.module.css";
export function RewardsSection() {
  return <section id="rewards" className={styles.rewardsBand}><div><span className={styles.eyebrow}>WAYNE’S REWARDS · TEXT DAILY</span><h2>You bring the appetite.<br /><em>We’ll bring the perks.</em></h2><p>Join Wayne’s Text Daily for member offers and more reasons to make it a pizza night. Free to join. Easy to love.</p><RewardsButton>Count me in →</RewardsButton><small>No purchase needed to join. Opt out anytime.</small></div><div className={styles.memberCard}><span>WAYNE’S PIZZA ★</span><strong>Officially<br />a pizza person.</strong><div><span>TEXT DAILY</span><span>MEMBER CLUB ↗</span></div></div></section>;
}
