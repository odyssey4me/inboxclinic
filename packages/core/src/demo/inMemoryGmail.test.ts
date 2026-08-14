// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { MockGmailClient, messageMetaBuilder } from "../testing";
import type { MessageMeta } from "../ports/GmailClient";

/**
 * The in-memory client is the reference implementation of the `GmailClient` port, so its
 * matching IS the app's belief about Gmail — design-testing.md Decision 3 and Decision 9.
 * These assert the belief the real account actually supports (#210), rather than the one that
 * happened to be convenient: `from:*@domain` spans the domain's whole subtree.
 */
/**
 * A message whose id **is** its `From` header, so a failing expectation names the sender that
 * was wrongly swept or spared rather than an opaque `msg-7`.
 */
const msgFrom = (from: string): MessageMeta => messageMetaBuilder({ id: from, headers: { from } });

const matched = (client: MockGmailClient, from: string, excludeFrom?: string): Promise<string[]> =>
  client.listMessageIdsForSender(from, undefined, excludeFrom);

describe("MockGmailClient.listMessageIdsForSender", () => {
  it("spans the whole subtree for *@domain, as Gmail's matching does (#210)", async () => {
    const gmail = new MockGmailClient([
      msgFrom("promo@ads.com"),
      msgFrom("news@mail.ads.com"),
      msgFrom("deep@a.b.ads.com"),
    ]);

    expect(await matched(gmail, "*@ads.com")).toEqual([
      "promo@ads.com",
      "news@mail.ads.com",
      "deep@a.b.ads.com",
    ]);
  });

  it("matches on a label boundary, so a lookalike domain is not swept", async () => {
    const gmail = new MockGmailClient([
      msgFrom("real@ads.com"),
      // Neither of these is under `ads.com`, though both contain it as a substring — the
      // failure mode of the `includes("@" + domain)` test this replaced.
      msgFrom("other@notads.com"),
      msgFrom("spoof@ads.com.evil.com"),
    ]);

    expect(await matched(gmail, "*@ads.com")).toEqual(["real@ads.com"]);
  });

  it("reads the address out of a display-name header", async () => {
    const gmail = new MockGmailClient([msgFrom("Ads Team <promo@mail.ads.com>")]);

    expect(await matched(gmail, "*@ads.com")).toEqual(["Ads Team <promo@mail.ads.com>"]);
  });

  it("carves out an excepted address without dropping the rest of the subtree (#145)", async () => {
    const gmail = new MockGmailClient([
      msgFrom("promo@ads.com"),
      msgFrom("vip@ads.com"),
      msgFrom("news@mail.ads.com"),
    ]);

    expect(await matched(gmail, "*@ads.com", "vip@ads.com")).toEqual([
      "promo@ads.com",
      "news@mail.ads.com",
    ]);
  });

  it("carves out a whole subdomain when the exclusion is itself a wildcard (#210)", async () => {
    const gmail = new MockGmailClient([
      msgFrom("promo@ads.com"),
      msgFrom("news@mail.ads.com"),
      msgFrom("alert@deep.mail.ads.com"),
      msgFrom("other@shop.ads.com"),
    ]);

    // Gmail accepts `-from:(*@sub.domain)` and it measurably removed that subdomain's mail
    // (#210). The carve-out has to take the excluded subdomain's OWN subtree with it.
    expect(await matched(gmail, "*@ads.com", "*@mail.ads.com")).toEqual([
      "promo@ads.com",
      "other@shop.ads.com",
    ]);
  });

  it("combines address and subdomain carve-outs in one OR-joined exclusion", async () => {
    const gmail = new MockGmailClient([
      msgFrom("promo@ads.com"),
      msgFrom("vip@ads.com"),
      msgFrom("news@mail.ads.com"),
      msgFrom("keep@shop.ads.com"),
    ]);

    expect(await matched(gmail, "*@ads.com", "vip@ads.com OR *@mail.ads.com")).toEqual([
      "promo@ads.com",
      "keep@shop.ads.com",
    ]);
  });

  it("matches an address-scope query against that address alone", async () => {
    const gmail = new MockGmailClient([msgFrom("promo@ads.com"), msgFrom("news@mail.ads.com")]);

    expect(await matched(gmail, "promo@ads.com")).toEqual(["promo@ads.com"]);
  });
});
