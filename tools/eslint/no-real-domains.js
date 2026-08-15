// SPDX-License-Identifier: Apache-2.0
/**
 * ESLint rule: fixture data must not name a domain someone could really own.
 *
 * Test, demo and e2e fixtures must use the names RFC 2606 / RFC 6761 reserve for
 * exactly this — `.test`, `.example`, `.invalid`, `.localhost`, and `example.com`
 * / `.net` / `.org` — so no committed test can be read as being about a real
 * organisation's mail, and no fixture can ever resolve.
 *
 * **Ownable is decided by `tldts`, not by a TLD list.** A name is ownable iff its
 * public suffix is in the Public Suffix List — `isIcann` for `com`/`co.uk`/`xyz`,
 * `isPrivate` for `github.io`/`pages.dev`. The reserved TLDs are in neither
 * section, which is precisely what makes them safe. Hand-maintaining a list of
 * TLDs instead would silently miss `.shop`, `.email`, `.xyz` and the next 1,000.
 * `tldts` is already this codebase's authority on domain structure
 * (`packages/core/src/domains/registrableDomain.ts`), so this stays in step with
 * the semantics the app itself applies.
 *
 * Two false-positive classes disappear by construction, because this walks the
 * AST rather than the text:
 *   * comments are never visited, so a comment citing a real measurement — the
 *     #210 finding that `from:*@google.com` returns `docs.google.com` — is
 *     evidence that stays put;
 *   * `sender.email` is a MemberExpression, not a string, so a property access is
 *     never mistaken for a domain.
 *
 * To exempt a file that genuinely needs a real suffix — a Public Suffix List test
 * cannot be written with a fictional suffix — disable it at the top of the file
 * with the reason:
 *
 *   \/* eslint-disable local/no-real-domains -- tests the PSL itself *\/
 *
 * See docs/design-testing.md and CONTRIBUTING.md.
 */

import { parse } from "tldts";

/** Reserved second-level names: RFC 2606 says these are always safe. */
const RESERVED_SLD = /^(.*\.)?example\.(com|net|org)$/;

/**
 * Real names a fixture may still legitimately carry: the app's own origin, and
 * the project's issue tracker (a report link is a real URL or it is not a link).
 */
const ALLOWED = new Set(["inboxclinic.app", "github.com", "api.github.com"]);

/** Extensions that make a dotted token a filename, not a hostname (`README.md`). */
const FILE_EXTENSIONS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "json",
  "md",
  "css",
  "html",
  "htm",
  "svg",
  "png",
  "jpg",
  "ico",
  "webp",
  "sh",
  "yml",
  "yaml",
  "lock",
  "txt",
  "map",
]);

/** Dotted, hostname-shaped tokens inside a string — URL hosts and bare domains alike. */
const CANDIDATE = /[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+/gi;

function offendingDomains(value) {
  const found = new Set();
  for (const match of value.matchAll(CANDIDATE)) {
    const candidate = match[0];
    // A dotted local part is not a domain: in `foo.bar@x.test` only `x.test` is
    // the host, and `.bar` happens to be a real gTLD.
    if (value[match.index + candidate.length] === "@") continue;
    const host = candidate.toLowerCase();
    const lastLabel = host.slice(host.lastIndexOf(".") + 1);
    if (FILE_EXTENSIONS.has(lastLabel)) continue;
    if (RESERVED_SLD.test(host) || ALLOWED.has(host)) continue;
    // `allowPrivateDomains` so a PRIVATE-section suffix (`github.io`) counts as
    // ownable too — one tenant's name is as real as any registrar's.
    const { isIcann, isPrivate } = parse(host, {
      allowPrivateDomains: true,
      extractHostname: false,
    });
    if (isIcann === true || isPrivate === true) found.add(host);
  }
  return [...found];
}

/** @type {import("eslint").Rule.RuleModule} */
export default {
  meta: {
    type: "problem",
    docs: {
      description: "Fixture data must use domain names reserved by RFC 2606 / RFC 6761.",
    },
    schema: [],
    messages: {
      realDomain:
        '"{{domain}}" is a domain someone can really own. Fixtures must use reserved names — ' +
        "{{suggestion}}, or example.com / .net / .org. RFC 6761 reserves the whole `.test` TLD, " +
        "so there are as many distinct fictional organisations as a test needs.",
    },
  },
  create(context) {
    const check = (node, value) => {
      if (typeof value !== "string" || value === "") return;
      for (const domain of offendingDomains(value)) {
        const label = domain.slice(0, domain.indexOf("."));
        context.report({
          node,
          messageId: "realDomain",
          data: { domain, suggestion: `${label}.test` },
        });
      }
    };
    return {
      Literal: (node) => check(node, node.value),
      TemplateElement: (node) => check(node, node.value.cooked),
    };
  },
};
