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
| My Poker Log | `player_poker_log` rows are readable only by their owner (`player_id = auth.uid()`). There's deliberately no host clause. Writes go through `my_log_save` / `my_log_delete`, which only touch the caller's rows and refuse entries naming AK Cash Club. Deleted with the account. |
| Payment tracking | `buy_in_method`, `payout_method` and `payout_paid` on `session_results` are excluded from players' column grants. They're changed only by `host_update_payments` (host + MFA), and the changes are audited. |
| Notification emails | Queued only by database triggers into `private.notification_outbox` (no API access). Sending runs in the Worker’s scheduled job: `claim_notifications` / `complete_notification` are callable with the publishable key but refuse without `NOTIFY_SECRET`, whose SHA-256 hash is the only copy stored (`private.app_settings`). Preferences and unsubscribe tokens are reachable only through `get_my_notification_prefs` / `set_my_notification_prefs` (own row) and `unsubscribe_with_token` (64-hex token, rate-limited page, POST to confirm). Preferences, tracking and the result itself are re-checked at send time. Emails contain no amounts or other players. |
| Game nights | `game_nights` and `seat_requests` have no direct API access; members use `list_game_nights` / `get_game_night` / `request_seat` / `cancel_my_seat`, which return seat **counts** only, never other players. The address is in `private.game_night_venue` and is returned only by `get_game_night` when `private.can_see_address()` allows it: the host (MFA), or a player whose seat is **confirmed**, on the game’s date in Toronto time, until 12 hours after the start. It is never emailed. Confirming, waitlisting, declining and cancelling games are host + MFA only. |
| Live game mode | `live_games`, `live_players` and `live_buyins` have no API access; every `host_live_*` function requires host + MFA. Amounts are `bigint` cents with range checks. Finalizing calls the same audited `host_save_session` (reason “Recorded from live game mode”) and `host_update_payments`; members without tracking are written as host-only guest rows, so nothing is linked to an account without consent. A finalized live game is locked. |
| Hand notes | `player_hand_notes` is owner-only through `my_hands_list` / `my_hand_save` / `my_hand_delete` (no host access, no table grants). Cards are validated in the database (valid codes, 0 or 2 hole cards, 0/3/4/5 board cards, no duplicates). |
| Responsible play | `player_wellbeing` has no table grants; members read and change only their own row through `get_my_wellbeing`, `set_my_loss_limit`, `set_my_session_reminder` and `take_a_break`. `request_seat` refuses while on a break or after the monthly loss limit is reached (enforced in the database). Raising/removing a limit is delayed 24 hours; a break can’t be shortened. The host can’t see any of it. |
| Guests and attendance | Guests' real names are in `private.seat_guests` (no API access). Only `host_get_game_night` (host + MFA) returns them. Members get confirmed seats from `get_game_night` as labels built in the database: "Guest N" for guests, `private.mask_name()` (first letter + five asterisks) for other members, and their own username for themselves. No member ids or full usernames of others are returned. Adding, removing, reordering and status changes are host-only functions; seat allocation locks the game row (`select … for update`) so capacity can't be exceeded by simultaneous requests. Guest names are purged 12 months after the game by the scheduled job. |
| Installable app | `/sw.js` never stores pages (member pages always come from the network); it caches only fingerprinted build files, brand images and the offline page. |
| Audit trail | Triggers write every insert/update/delete of sessions, results, adjustments and consent to `audit_log` with actor id, time, reason, and before/after values. No role can modify or delete audit rows. |
| XSS | Astro escapes all output; strict Content-Security-Policy; no user HTML is rendered. |
| SQL injection | No SQL is built in the app; all access is parameterised PostgREST/RPC calls. |
| Error handling | Database/auth errors are mapped to friendly messages; details go to server logs only. |
| Account deletion | `delete_my_account()` removes the auth user and profile; results are kept only as anonymous amounts. |

## Tests

- `tests/db/security.test.ts` runs the **real migration** in Postgres (PGlite) with
  Supabase’s roles and default privileges, then acts as anonymous visitors, players and
  the host, including direct table writes and direct function calls.
- `tests/db/notifications.test.ts` covers email preferences, the outbox secret, send-time
  re-checks, unsubscribe tokens, and checks the full list of functions anonymous visitors
  can run.
- `tests/unit/notify.test.ts` covers the email content (no amounts, escaping, links) and the
  Resend sender against a fake API.
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
