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
      msgFrom("promo@ads.test"),
      msgFrom("news@mail.ads.test"),
      msgFrom("deep@a.b.ads.test"),
    ]);

    expect(await matched(gmail, "*@ads.test")).toEqual([
      "promo@ads.test",
      "news@mail.ads.test",
      "deep@a.b.ads.test",
    ]);
  });

  it("matches on a label boundary, so a lookalike domain is not swept", async () => {
    const gmail = new MockGmailClient([
      msgFrom("real@ads.test"),
      // Neither of these is under `ads.test`, though both contain it as a substring — the
      // failure mode of the `includes("@" + domain)` test this replaced.
      msgFrom("other@notads.test"),
      msgFrom("spoof@ads.test.evil.test"),
    ]);

    expect(await matched(gmail, "*@ads.test")).toEqual(["real@ads.test"]);
  });

  it("reads the address out of a display-name header", async () => {
    const gmail = new MockGmailClient([msgFrom("Ads Team <promo@mail.ads.test>")]);

    expect(await matched(gmail, "*@ads.test")).toEqual(["Ads Team <promo@mail.ads.test>"]);
  });

  it("carves out an excepted address without dropping the rest of the subtree (#145)", async () => {
    const gmail = new MockGmailClient([
      msgFrom("promo@ads.test"),
      msgFrom("vip@ads.test"),
      msgFrom("news@mail.ads.test"),
    ]);

    expect(await matched(gmail, "*@ads.test", "vip@ads.test")).toEqual([
      "promo@ads.test",
      "news@mail.ads.test",
    ]);
  });

  it("carves out a whole subdomain when the exclusion is itself a wildcard (#210)", async () => {
    const gmail = new MockGmailClient([
      msgFrom("promo@ads.test"),
      msgFrom("news@mail.ads.test"),
      msgFrom("alert@deep.mail.ads.test"),
      msgFrom("other@shop.ads.test"),
    ]);

    // Gmail accepts `-from:(*@sub.domain)` and it measurably removed that subdomain's mail
    // (#210). The carve-out has to take the excluded subdomain's OWN subtree with it.
    expect(await matched(gmail, "*@ads.test", "*@mail.ads.test")).toEqual([
      "promo@ads.test",
      "other@shop.ads.test",
    ]);
  });

  it("combines address and subdomain carve-outs in one OR-joined exclusion", async () => {
    const gmail = new MockGmailClient([
      msgFrom("promo@ads.test"),
      msgFrom("vip@ads.test"),
      msgFrom("news@mail.ads.test"),
      msgFrom("keep@shop.ads.test"),
    ]);

    expect(await matched(gmail, "*@ads.test", "vip@ads.test OR *@mail.ads.test")).toEqual([
      "promo@ads.test",
      "keep@shop.ads.test",
    ]);
  });

  it("matches an address-scope query against that address alone", async () => {
    const gmail = new MockGmailClient([msgFrom("promo@ads.test"), msgFrom("news@mail.ads.test")]);

    expect(await matched(gmail, "promo@ads.test")).toEqual(["promo@ads.test"]);
  });
});
