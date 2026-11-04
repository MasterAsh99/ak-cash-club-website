# Security model

## Principles

1. **The database is the security boundary.** Every permission is enforced in Postgres
   (Row Level Security, column grants, and checks inside functions). The website’s page
   guards only decide what to *show*; a hand-crafted API request gets the same answer.
2. **Least privilege.** API roles (`anon`, `authenticated`) have **no** INSERT/UPDATE/DELETE
   privilege on any table. All writes go through a small set of functions that validate
   their input.
3. **No privileged keys in the app.** The Worker only has the Supabase *publishable* key.
   There is no service-role key anywhere in the project or its configuration.
4. **Host identity is data, not a name.** Host = the single row in `private.host_account`.
   The `private` schema isn’t exposed through the API, and the row can only be added by
   the project owner in the SQL editor. The row is immutable once set.

## How each requirement is enforced

| Requirement | Where |
| --- | --- |
| Passwords never stored or retrievable | Supabase Auth (salted bcrypt). The app never stores passwords. |
| Email verification before login | Supabase *Confirm email* setting; the login page explains unverified accounts. |
| Reset links time-limited and single-use | Supabase one-time `token_hash` (1h expiry). `/auth/confirm` only consumes it on submit, so email scanners can’t burn it. |
| No account enumeration | Sign-up, resend and reset always show the same message. Login says “Incorrect email or password”. |
| Secure sessions | `@supabase/ssr` cookies forced to `HttpOnly; Secure; SameSite=Lax`; `getClaims()` verifies the JWT on every request; member pages are `Cache-Control: private, no-store`. |
| CSRF | Astro `security.checkOrigin` rejects cross-site form posts; SameSite cookies; logout is POST-only. |
| Rate limits | Cloudflare Rate Limiting bindings (per IP and per hashed email) on sign-up, login, resend, reset, verify, re-auth and MFA; plus Supabase Auth’s own limits. |
| Only the host writes results | All host functions call `private.assert_host()`, which requires the host user id **and** an `aal2` (MFA) session. |
| Players can’t impersonate the host | Usernames are 3–20 ASCII chars (no spaces/brackets); reserved/look-alike names (`akhost`, `AK-H0st`, `admin`…) are rejected by a database trigger using a “skeleton” comparison. The host’s name is forced to “AK (host)” and can’t be changed. |
| Players see only their own data | RLS: own rows only, and only while tracking is on. Column grants hide `host_notes`; adjustments and the audit log are host-only. |
| Consent | Results can be linked only to players with tracking on. Turning it off hides results immediately. Consent changes are audited. |
| Atomic saves | `host_save_session` runs in one transaction; any invalid row rolls back the whole save. Unique constraints stop duplicate players and guest labels. |
| Exact money | `bigint` cents in the database (net is a generated column); `BigInt` in the app; no floating point. |
| Host expenses | `host_expenses` is readable only with `private.is_host_mfa()`; writes go through `host_save_expense` / `host_delete_expense` (host + MFA, reason required to edit or delete). Players get an empty result or “permission denied”. |
| Audit trail | Triggers write every insert/update/delete of sessions, results, adjustments and consent to `audit_log` with actor id, time, reason, and before/after values. No role can modify or delete audit rows. |
| XSS | Astro escapes all output; strict Content-Security-Policy; no user HTML is rendered. |
| SQL injection | No SQL is built in the app; all access is parameterised PostgREST/RPC calls. |
| Error handling | Database/auth errors are mapped to friendly messages; details go to server logs only. |
| Account deletion | `delete_my_account()` removes the auth user and profile; results are kept only as anonymous amounts. |

## Tests

- `tests/db/security.test.ts` runs the **real migration** in Postgres (PGlite) with
  Supabase’s roles and default privileges, then acts as anonymous visitors, players and
  the host, including direct table writes and direct function calls.
- `tests/unit/lib.test.ts` covers money parsing/formatting, statistics, chart geometry,
  username/password rules, redirect safety and the session form.
- `tests/e2e/` drives a real browser through the built Worker against a local Supabase
  stand-in backed by the same migration (sign-up, verification, consent, host MFA,
  session entry/edit, audit log, password reset, direct API attacks).

## Known limitations

- Cloudflare’s rate limiter is approximate and per-location (a coarse filter, not a hard cap).
- The host, as Supabase project owner, can see account emails in the Supabase dashboard.
  The privacy notice says so.
- Unverified sign-ups reserve their username until the account is removed. Supabase can
  be configured to clean these up.
