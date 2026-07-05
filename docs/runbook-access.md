# Runbook: Access (allowlist) management

> Maintainer runbook for onboarding users to the **hosted** Inbox Clinic instance.
> Design rationale: [design-deployment.md](design-deployment.md) (Access / Request-access).

The hosted app runs in a Google Cloud OAuth project in **"testing" mode**, which only
permits **allowlisted test users** (≤100). Onboarding is a **manual** step (appropriate at
this scale). Self-hosters run their own OAuth client and are their own only test user, so
this runbook does not apply to them.

## Onboard a requester

A request arrives via the **Tally request-access form** (`VITE_REQUEST_ACCESS_URL`),
delivered privately to the maintainer, containing a **Google email** (+ optional note).

1. **Add the test user.** Google Cloud Console → *APIs & Services* → *OAuth consent
   screen* → **Test users** → **+ Add users** → paste the requester's Google email → save.
2. **Confirm.** Reply to the requester that they've been added and can sign in at the app
   URL (they'll consent to the requested scopes on first use).
3. **Delete the request.** Remove the entry from the Tally submissions so no unnecessary
   personal data is retained.

## Remove a user

Google Cloud Console → *OAuth consent screen* → **Test users** → remove the email. Their
**on-device** data is unaffected (it lives only in their browser); they simply can no
longer obtain new tokens for the hosted client.

## Notes

- The ≤100 test-user cap is a Google limit for testing-mode apps; it naturally bounds the
  hosted user base and avoids restricted-scope verification / CASA (design-deployment.md).
- No backend stores any of this — the allowlist lives in Google Cloud, requests live in
  Tally, and neither is part of this repository.
