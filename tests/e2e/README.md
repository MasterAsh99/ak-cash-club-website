# End-to-end tests

`npm run test:e2e` builds the site, runs the real Cloudflare Worker locally, and drives
Chromium through the member area:

- sign-up (including rejected host/look-alike usernames), email verification, single-use links
- opting in to tracking, attempted rename to “AK (host)”
- **direct API calls with a player’s token** against host functions (refused)
- host activation through the owner-only step, two-factor setup, session entry with
  review-before-save, editing with a reason, the audit log, the players list
- the player dashboard (exact stats, chart, privacy from other players)
- password reset (enumeration-safe message, single-use link) and logout

Supabase is replaced by `mock-supabase.mts`: a small stand-in for the Auth and RPC
endpoints the site uses. Every database call runs the **real migration and access rules**
in PGlite, as Supabase’s `anon`/`authenticated` roles with the caller’s JWT claims. The
stand-in accepts the TOTP code `123456` and exposes `/__test/*` helpers (email outbox,
make-host). It exists only for tests.

Screenshots are written to `/tmp/e2e-shots` (override with `SHOTS=`).

Requires Playwright’s Chromium: `npx playwright install chromium`.
