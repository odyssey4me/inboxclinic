// SPDX-License-Identifier: Apache-2.0
import { trustTier, type TrustTierColour } from "@inboxclinic/core";

const TEXT_COLOUR: Record<TrustTierColour, string> = {
  green: "text-green-600",
  "light-green": "text-green-500",
  grey: "text-slate-500",
  orange: "text-orange-500",
  red: "text-red-600",
};

const DOTS = 5;

/** Trust score as filled dots + the tier name (colour is always paired with text). */
export function ScoreIndicator({ score }: { score: number }) {
  const { tier, colour } = trustTier(score);
  const filled = Math.max(0, Math.min(DOTS, Math.round(((score + 10) / 20) * DOTS)));
  return (
    <div className="flex items-center gap-2">
      <span aria-hidden="true" className={`tracking-widest ${TEXT_COLOUR[colour]}`}>
        {"●".repeat(filled)}
        {"○".repeat(DOTS - filled)}
      </span>
      <span className={`text-sm font-semibold ${TEXT_COLOUR[colour]}`}>{tier}</span>
      <span className="sr-only">trust score {score.toFixed(1)} of 10</span>
    </div>
  );
}
