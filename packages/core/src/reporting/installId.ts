// SPDX-License-Identifier: Apache-2.0
/**
 * Anonymous install ID — a random, opaque per-install token used only for feedback
 * abuse-correlation (design-error-reporting.md Decision 5). Stored as a `settings` record
 * so it rides along in `exportAll` / Drive backup automatically; **user-resettable**.
 *
 * It is a *cooperative* signal (forgeable/rotatable), not an enforcement mechanism, and it
 * is **not** the aggregate-contributor identity — that path stays non-identifiable.
 */

import type { Store } from "../store";

export const INSTALL_ID_KEY = "reporting.installId";

/** Read the install ID, lazily minting and persisting one on first use. */
export async function getInstallId(store: Store): Promise<string> {
  const existing = (await store.settings.get(INSTALL_ID_KEY))?.value;
  if (typeof existing === "string" && existing !== "") return existing;
  const id = crypto.randomUUID();
  await store.settings.put({ key: INSTALL_ID_KEY, value: id });
  return id;
}

/** Replace the install ID with a fresh one (a new identity + fresh soft-limit slate). */
export async function resetInstallId(store: Store): Promise<string> {
  const id = crypto.randomUUID();
  await store.settings.put({ key: INSTALL_ID_KEY, value: id });
  return id;
}
