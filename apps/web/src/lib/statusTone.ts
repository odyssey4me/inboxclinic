// SPDX-License-Identifier: Apache-2.0
import type { TrustStatus } from "@inboxclinic/core";

import type { BadgeTone } from "../components/ui/Badge";

/**
 * Map a subject's trust status to its badge tone. Shared by the Dashboard, the
 * sender/domain detail cards, and the Decisions screen so the status colours stay in one
 * place (the colour is always paired with the status word).
 */
export function statusTone(status: TrustStatus): BadgeTone {
  if (status === "trusted") return "green";
  if (status === "blocked") return "red";
  return "neutral";
}
