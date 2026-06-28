/**
 * `computeTrustScore` — pure trust scoring (no I/O).
 *
 * See docs/design-trust-decisions.md ("Trust scoring") and architecture.md §4.
 * v1 blends two signal groups, re-normalised because the Network group is deferred:
 *
 *   score = User × 0.77 + Compliance × 0.23   (clamped to −10…+10)
 *
 * **User signals** (−10…+10 before weighting), each scaled by the sender's
 * aggregate recency factor `R` (recency weights ≤30d ×1.0 … >180d ×0.2), except
 * `inContacts`, which is a current-state fact:
 *   replied +3, in contacts +2, frequently starred +2, consistently opened >80% +1,
 *   never opened −1, manually marked spam −2, repeatedly marked spam −3.
 *
 * **Compliance signals:** SPF+DKIM+DMARC all pass +2 (two pass +1; spoofed −3);
 * `List-Unsubscribe` present +1 (absent −1).
 *
 * The result pairs the score with its display tier (via `trustTier`) and the
 * contributing signals, for UI transparency. `components.network` is `null` in v1.
 */

import { trustTier, type TrustTierColour, type TrustTierName } from "../trust/tiers";
import { aggregateRecency } from "../senders/recency";
import type { SenderSnapshot } from "./senderSnapshot";

const USER_WEIGHT = 0.77;
const COMPLIANCE_WEIGHT = 0.23;

const SCORE_MIN = -10;
const SCORE_MAX = 10;

const STARRED_FREQUENT = 2;
const SPAM_REPEATED = 2;
const OPENED_CONSISTENTLY = 0.8;

/** One weighted contribution, surfaced as supporting evidence in the UI. */
export interface TrustSignal {
  label: string;
  value: number;
  weight: number;
}

export interface TrustScoreResult {
  score: number;
  tier: TrustTierName;
  colour: TrustTierColour;
  components: { user: number; compliance: number; network: number | null };
  signals: TrustSignal[];
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Pure. v1 weighting: User×0.77 + Compliance×0.23 (Network deferred → null). */
export function computeTrustScore(sender: SenderSnapshot): TrustScoreResult {
  const recency = aggregateRecency(sender.recencyBuckets);
  const signals: TrustSignal[] = [];

  // --- User signals (recency-scaled, except inContacts) --------------------
  let user = 0;
  const addUser = (label: string, base: number, scaled = true): void => {
    const value = scaled ? base * recency : base;
    user += value;
    signals.push({ label, value, weight: USER_WEIGHT });
  };

  if (sender.replyCount > 0) addUser("replied", 3);
  if (sender.inContacts) addUser("inContacts", 2, false);
  if (sender.starredCount >= STARRED_FREQUENT) addUser("frequentlyStarred", 2);
  if (sender.readRate !== null && sender.readRate > OPENED_CONSISTENTLY) {
    addUser("consistentlyOpened", 1);
  }
  if (sender.readRate !== null && sender.readRate === 0) addUser("neverOpened", -1);
  if (sender.spamMarkedCount >= SPAM_REPEATED) addUser("repeatedlyMarkedSpam", -3);
  else if (sender.spamMarkedCount >= 1) addUser("markedSpam", -2);

  // --- Compliance signals --------------------------------------------------
  let compliance = 0;
  const addCompliance = (label: string, value: number): void => {
    compliance += value;
    signals.push({ label, value, weight: COMPLIANCE_WEIGHT });
  };

  const { spf, dkim, dmarc, spoofed } = sender.auth;
  const passCount = (spf ? 1 : 0) + (dkim ? 1 : 0) + (dmarc ? 1 : 0);
  if (spoofed) addCompliance("spoofed", -3);
  else if (passCount === 3) addCompliance("authAllPass", 2);
  else if (passCount === 2) addCompliance("authTwoPass", 1);

  if (sender.hasListUnsubscribe) addCompliance("listUnsubscribe", 1);
  else addCompliance("noListUnsubscribe", -1);

  const score = clamp(USER_WEIGHT * user + COMPLIANCE_WEIGHT * compliance, SCORE_MIN, SCORE_MAX);
  const { tier, colour } = trustTier(score);

  return {
    score,
    tier,
    colour,
    components: { user, compliance, network: null },
    signals,
  };
}
