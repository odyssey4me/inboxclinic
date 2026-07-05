// SPDX-License-Identifier: Apache-2.0
import type { TrustSignal } from "@inboxclinic/core";

/** Friendly text for each signal label emitted by `computeTrustScore`. */
const SIGNAL_TEXT: Record<string, string> = {
  replied: "You've replied to this sender",
  inContacts: "In your contacts",
  frequentlyStarred: "You frequently star these",
  consistentlyOpened: "You usually open these",
  neverOpened: "You never open these",
  markedSpam: "You marked this as spam",
  repeatedlyMarkedSpam: "You repeatedly marked this as spam",
  authAllPass: "Passes SPF, DKIM and DMARC",
  authTwoPass: "Passes two of SPF / DKIM / DMARC",
  spoofed: "Fails authentication (possible spoofing)",
  listUnsubscribe: "Offers one-click unsubscribe",
  noListUnsubscribe: "No unsubscribe header",
};

/** The 3–4 most influential signals as plain statements with a +/− marker. */
export function SignalList({ signals, limit = 4 }: { signals: TrustSignal[]; limit?: number }) {
  const top = [...signals].sort((a, b) => Math.abs(b.value) - Math.abs(a.value)).slice(0, limit);
  if (top.length === 0) return null;

  return (
    <ul className="space-y-1 text-sm">
      {top.map((signal) => {
        const positive = signal.value >= 0;
        return (
          <li key={signal.label} className="flex items-start gap-2">
            <span
              aria-hidden="true"
              className={positive ? "font-semibold text-green-600" : "font-semibold text-red-600"}
            >
              {positive ? "+" : "−"}
            </span>
            <span className="text-slate-700">{SIGNAL_TEXT[signal.label] ?? signal.label}</span>
          </li>
        );
      })}
    </ul>
  );
}
