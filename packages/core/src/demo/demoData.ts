// SPDX-License-Identifier: Apache-2.0
/**
 * Curated demo inbox fixtures (design-frontend.md — Demo mode).
 *
 * A hand-authored set of ~16 senders spanning every M1 category (personal,
 * transactional, promotional, other) and a spread of trust signals (read-rate,
 * auth posture, list-unsubscribe, spam marks, a spoofed look-alike). Two addresses
 * share `retailco.com` so the workflow's domain batch-offer appears.
 *
 * The fixtures are authored as `MessageMeta` so the real scan/extraction pipeline
 * derives the senders — the demo is genuinely scan-driven, and `Scan`/`Sync` are
 * idempotent against it. `demoInbox(now)` dates messages relative to `now` so recency
 * and frequency stay sensible whenever the demo is opened.
 */

import type { MessageMeta, NativeFilter } from "../ports/GmailClient";
import type { BlockAction } from "../store/types";

/** The signed-in identity shown in demo mode (never a real account). */
export const DEMO_ACCOUNT_EMAIL = "demo.user@inboxclinic.app";

/** A stable History-API marker so demo `Sync` is an immediate no-op refresh. */
export const DEMO_HISTORY_ID = "100000";

type AuthPosture = "pass" | "partial" | "fail";
type CategoryLabel =
  | "CATEGORY_PROMOTIONS"
  | "CATEGORY_UPDATES"
  | "CATEGORY_PERSONAL"
  | "CATEGORY_SOCIAL"
  | "CATEGORY_FORUMS";

interface DemoSenderSpec {
  name: string;
  email: string;
  /** Total messages authored for this sender. */
  total: number;
  /** How many are UNREAD — drives read-rate (`1 − unread/total`). */
  unread: number;
  starred?: number;
  /** Place the sender's mail in a folder other than the inbox (for learning-scan demos). */
  folder?: "spam" | "trash";
  category?: CategoryLabel;
  listUnsub?: boolean;
  listId?: boolean;
  auth?: AuthPosture;
  /** Messages are spread over the last N days (recency + frequency). */
  withinDays: number;
}

const DAY_MS = 86_400_000;

/**
 * Curated senders. Ordering is not significant; ids are derived from the address.
 * The trust spread is intentional: engaged personal/transactional senders read high;
 * unopened promotional/social senders read low; one spoofed look-alike reads lowest.
 */
const DEMO_SENDERS: DemoSenderSpec[] = [
  // -- Personal (engaged, high trust) --------------------------------------------
  { name: "Jane Cooper", email: "jane.cooper@gmail.com", total: 5, unread: 0, starred: 2, auth: "pass", withinDays: 20 }, // prettier-ignore
  { name: "Marcus Lee", email: "marcus@fastmail.com", total: 3, unread: 0, starred: 1, auth: "pass", withinDays: 25 }, // prettier-ignore
  { name: "Priya Nair", email: "priya.nair@outlook.com", total: 2, unread: 1, auth: "pass", withinDays: 28 }, // prettier-ignore

  // -- Transactional (useful automated mail) -------------------------------------
  { name: "GitHub", email: "notifications@github.com", total: 12, unread: 3, category: "CATEGORY_UPDATES", listId: true, auth: "pass", withinDays: 14 }, // prettier-ignore
  { name: "Stripe", email: "receipts@stripe.com", total: 4, unread: 0, category: "CATEGORY_UPDATES", auth: "pass", withinDays: 30 }, // prettier-ignore
  { name: "Vercel", email: "notifications@vercel.com", total: 6, unread: 2, listId: true, auth: "pass", withinDays: 21 }, // prettier-ignore
  { name: "Bank of Aurora", email: "alerts@bankofaurora.com", total: 3, unread: 0, category: "CATEGORY_UPDATES", auth: "pass", withinDays: 18 }, // prettier-ignore

  // -- Promotional (bulk marketing; mostly unopened) -----------------------------
  { name: "RetailCo Deals", email: "deals@retailco.com", total: 18, unread: 16, category: "CATEGORY_PROMOTIONS", listUnsub: true, auth: "partial", withinDays: 14 }, // prettier-ignore
  { name: "RetailCo News", email: "news@retailco.com", total: 7, unread: 6, category: "CATEGORY_PROMOTIONS", listUnsub: true, auth: "partial", withinDays: 22 }, // prettier-ignore
  { name: "TravelNow", email: "offers@travelnow.com", total: 9, unread: 8, category: "CATEGORY_PROMOTIONS", listUnsub: true, auth: "pass", withinDays: 20 }, // prettier-ignore
  { name: "Foodie Weekly", email: "hello@foodieweekly.com", total: 6, unread: 2, listUnsub: true, auth: "pass", withinDays: 24 }, // prettier-ignore
  { name: "MegaMart", email: "no-reply@megamart.com", total: 14, unread: 13, category: "CATEGORY_PROMOTIONS", listUnsub: true, auth: "partial", withinDays: 18 }, // prettier-ignore

  // -- Other (social / forums) ---------------------------------------------------
  { name: "LinkedIn", email: "notifications@linkedin.com", total: 10, unread: 6, category: "CATEGORY_SOCIAL", listUnsub: true, auth: "pass", withinDays: 20 }, // prettier-ignore
  { name: "X", email: "info@x.com", total: 8, unread: 7, category: "CATEGORY_SOCIAL", auth: "pass", withinDays: 15 }, // prettier-ignore
  { name: "DevForum Digest", email: "digest@devforum.org", total: 5, unread: 1, category: "CATEGORY_FORUMS", listId: true, listUnsub: true, auth: "pass", withinDays: 27 }, // prettier-ignore

  // -- Spoofed look-alike that landed in the inbox (lowest trust) ----------------
  { name: "PayPal Security", email: "security@paypa1-alert.com", total: 4, unread: 4, category: "CATEGORY_PROMOTIONS", listUnsub: true, auth: "fail", withinDays: 10 }, // prettier-ignore

  // -- Already handled outside the inbox — for the "learn prior decisions" demo --
  // Spam-marked (strong signal) and unread-binned (a signal); read-then-binned is not.
  { name: "MegaCasino", email: "wins@megacasino.example", total: 5, unread: 5, folder: "spam", auth: "fail", withinDays: 12 }, // prettier-ignore
  { name: "Flash Deals", email: "blast@flashdeals.example", total: 6, unread: 6, folder: "trash", listUnsub: true, auth: "pass", withinDays: 15 }, // prettier-ignore
  { name: "Corner Shop", email: "receipts@cornershop.example", total: 4, unread: 0, folder: "trash", auth: "pass", withinDays: 20 }, // prettier-ignore
];

/** Addresses pre-decided when the store is seeded (a realistic starting mix). */
export const DEMO_DECISIONS: {
  email: string;
  decision: "trust" | "block";
  actions: BlockAction[];
}[] = [
  { email: "jane.cooper@gmail.com", decision: "trust", actions: [] },
  { email: "notifications@github.com", decision: "trust", actions: [] },
  { email: "deals@retailco.com", decision: "block", actions: ["create_filter", "archive"] },
  { email: "security@paypa1-alert.com", decision: "block", actions: ["create_filter", "delete"] },
];

/**
 * Pre-existing "legacy" Gmail filters seeded for the filter-optimisation demo: three
 * per-address rules on one domain (consolidate → `*@oldshop.example`) and a duplicate.
 */
export const DEMO_LEGACY_FILTERS: NativeFilter[] = [
  {
    id: "legacy-1",
    from: "sale@oldshop.example",
    addLabelIds: ["TRASH"],
    removeLabelIds: ["INBOX"],
  },
  {
    id: "legacy-2",
    from: "deals@oldshop.example",
    addLabelIds: ["TRASH"],
    removeLabelIds: ["INBOX"],
  },
  {
    id: "legacy-3",
    from: "news@oldshop.example",
    addLabelIds: ["TRASH"],
    removeLabelIds: ["INBOX"],
  },
  {
    id: "legacy-4",
    from: "spammer@junk.example",
    addLabelIds: ["TRASH"],
    removeLabelIds: ["INBOX"],
  },
  {
    id: "legacy-5",
    from: "spammer@junk.example",
    addLabelIds: ["TRASH"],
    removeLabelIds: ["INBOX"],
  },
];

function authHeader(posture: AuthPosture): string {
  if (posture === "pass") return "spf=pass dkim=pass dmarc=pass";
  if (posture === "partial") return "spf=pass dkim=pass dmarc=none";
  return "spf=fail dkim=fail dmarc=fail"; // spoofed
}

/** Expand one spec into its messages, dated relative to `now`. */
function expand(spec: DemoSenderSpec, now: number): MessageMeta[] {
  const out: MessageMeta[] = [];
  for (let i = 0; i < spec.total; i += 1) {
    const ageDays = Math.floor((i / spec.total) * spec.withinDays);
    const internalDate = now - ageDays * DAY_MS;

    const labelIds =
      spec.folder === "spam" ? ["SPAM"] : spec.folder === "trash" ? ["TRASH"] : ["INBOX"];
    if (spec.category !== undefined) labelIds.push(spec.category);
    if (i < spec.unread) labelIds.push("UNREAD");
    if (spec.starred !== undefined && i < spec.starred) labelIds.push("STARRED");

    const domain = spec.email.slice(spec.email.indexOf("@") + 1);
    out.push({
      id: `${spec.email}#${i}`,
      threadId: `thread:${spec.email}#${i}`,
      labelIds,
      internalDate,
      headers: {
        from: `${spec.name} <${spec.email}>`,
        subject: `Message ${i + 1} from ${spec.name}`,
        ...(spec.listUnsub === true ? { listUnsubscribe: `<mailto:unsubscribe@${domain}>` } : {}),
        ...(spec.listId === true ? { listId: `<list.${domain}>` } : {}),
        ...(spec.auth !== undefined ? { authenticationResults: authHeader(spec.auth) } : {}),
      },
    });
  }
  return out;
}

/** The full curated demo inbox, dated relative to `now`. */
export function demoInbox(now: number): MessageMeta[] {
  return DEMO_SENDERS.flatMap((spec) => expand(spec, now));
}
