# Setting up the member area

This guide covers everything that needs your accounts or your explicit action.
Allow about an hour, plus waiting time for a domain to verify with the email provider.

> **Order matters.** Do the steps top to bottom. The site is safe to deploy
> before setup is finished: until Supabase is connected, the login pages simply say
> “The member area is being set up”.

Dashboard menus change from time to time. If a label below doesn’t match exactly, look for the closest equivalent.

---

## 0. Accounts you’ll need

| Service | What it’s for | Cost |
| --- | --- | --- |
| **Supabase** | Login, email verification, password resets, database | Free to start; **Pro $25 USD/month** recommended before real players use it (no inactivity pausing, daily backups) |
| **Resend** | Sends the verification / reset emails | Free tier: 3,000 emails/month, 100/day |
| **A domain name** | Required to send email to players | ~$10–20/year (e.g. via Cloudflare Registrar) |
| **An authenticator app** | Host two-factor login (Google Authenticator, Microsoft Authenticator, 1Password, Authy…) | Free |
| Cloudflare, GitHub | Already set up | Free |

Why a domain is required: Supabase’s built-in email sender is only for testing (a few
emails per hour, and only to your own team), and Resend only sends to other people from
a domain you’ve verified. A personal Gmail account isn’t needed or recommended.

---

## 1. Buy a domain (Cloudflare)

1. Cloudflare dashboard → **Domain Registration → Register Domains**.
2. Pick a name (the club uses `akcashclub.com`) and complete the purchase.
3. *(Optional, recommended)* Point the website at it: **Workers & Pages →
   ak-cash-club-website → Settings → Domains & Routes → Add → Custom domain**.
   If you do, use that address everywhere this guide says “your site address”, and
   update `site` in `astro.config.mjs` and `PUBLIC_SITE_URL` in `wrangler.jsonc`.

The club’s address is **`https://akcashclub.com`** (with `www.` redirecting to it). The original
`https://ak-cash-club-website.aaronkara99.workers.dev` address keeps working too.

---

## 2. Create the Supabase project

1. Sign up at supabase.com and create a **New project**.
   - **Region:** choose **Canada (Central)** if offered, so member data stays in Canada.
   - **Database password:** generate a strong one and store it in a password manager.
2. **Create the database tables and security rules.** For **each file** in
   `supabase/migrations/`, in name order, open **SQL Editor → New query**, paste the
   file’s entire contents, and press **Run**. Each should finish with
   “Success. No rows returned”:
   1. `20261103000000_player_portal.sql` (accounts, sessions, results, audit log)
   2. `20261104000000_host_expenses.sql` (host expense tracker)
   3. `20261105000000_poker_log_and_payments.sql` (My Poker Log, payment tracking)
   4. `20261106000000_notifications.sql` (email preferences, “your result is ready” emails)
   5. `20261107000000_game_nights.sql` (game nights, seat requests, waitlist, reminders)

   When a new file is added in future, run just that file.
   *(Alternative for developers: `npx supabase link` then `npx supabase db push`.)*
3. **Check the API only exposes the `public` schema:** **Project Settings → Data API →
   Exposed schemas** should list `public` (and possibly `graphql_public`), and **not**
   `private`.

### Authentication settings

**Authentication → URL Configuration**
- **Site URL:** `https://akcashclub.com`
- **Redirect URLs:** add `https://akcashclub.com/**` and
  `https://ak-cash-club-website.aaronkara99.workers.dev/**`. The `**` allows the
  `?flow=…` marker the site adds to email links.

**Authentication → Sign In / Providers → Email**
- Email provider: **enabled**
- **Confirm email: ON** (accounts can’t log in until verified)
- **Secure email change: ON** (both old and new address must confirm)
- **Secure password change: ON**
- **Minimum password length: 10**
- **Prevent use of leaked passwords: ON** (Pro plan feature; turn on when you upgrade)
- Email OTP / link expiry: **3600 seconds** (1 hour)
- Disable every other provider (Google, Apple, phone…) and **anonymous sign-ins**.

**Authentication → Multi-Factor**
- **TOTP (authenticator app): enabled.** Phone MFA: disabled.

**Authentication → Rate Limits**
- Defaults are fine. After step 3, raise *emails sent per hour* to about 30.

**Authentication → Emails → Templates** (do after step 3 so test emails send)

For each template, set the subject and paste the HTML file’s contents:

| Template | Subject | File |
| --- | --- | --- |
| Confirm signup | `Verify your email · AK Cash Club` | `supabase/templates/confirmation.html` |
| Reset password | `Reset your password · AK Cash Club` | `supabase/templates/recovery.html` |
| Change email address | `Confirm your email change · AK Cash Club` | `supabase/templates/email_change.html` |
| *(optional)* Password changed notification | `Your password was changed · AK Cash Club` | `supabase/templates/password_changed_notification.html` |
| *(optional)* Email changed notification | `Your email address was changed · AK Cash Club` | `supabase/templates/email_changed_notification.html` |

The links in these templates use `{{ .SiteURL }}/auth/confirm?token_hash=…`, so the
**Site URL** above must be your live address.

### Copy the two values the website needs

**Project Settings → API Keys** (and Data API for the URL):
- **Project URL**, e.g. `https://abcd1234.supabase.co`
- **Publishable key**, starts with `sb_publishable_`. (If your project only shows legacy
  keys, the `anon` `public` key works the same way.)

**Never** copy the *secret* / `service_role` key anywhere. This site doesn’t use it.

---

## 3. Set up email sending (Resend)

1. Sign up at resend.com.
2. **Domains → Add Domain.** Use a subdomain of your domain, e.g. `mail.akcashclub.com`.
3. Add the DNS records Resend shows (SPF, DKIM, and the MX record) in **Cloudflare → your
   domain → DNS → Records**. Resend can add them for you automatically if you sign in to
   Cloudflare when prompted.
4. Also add a DMARC record: Type `TXT`, Name `_dmarc.mail`, Content `v=DMARC1; p=none;`.
5. Wait until Resend shows the domain as **Verified** (minutes to a few hours).
6. **API Keys → Create API Key**, permission **Sending access**, restricted to that domain.
   Copy it (you only see it once).
7. In **Supabase → Authentication → Emails → SMTP Settings**, enable custom SMTP:

   | Field | Value |
   | --- | --- |
   | Sender email | `no-reply@mail.akcashclub.com` (your verified domain) |
   | Sender name | `AK Cash Club` |
   | Host | `smtp.resend.com` |
   | Port | `465` |
   | Username | `resend` |
   | Password | the Resend API key from step 6 |

8. Now paste the email templates (section 2) and raise the email rate limit.

---

## 4. Connect the website to Supabase (Cloudflare)

Cloudflare dashboard → **Workers & Pages → ak-cash-club-website → Settings →
Variables and Secrets → Add**:

| Type | Name | Value |
| --- | --- | --- |
| **Secret** | `SUPABASE_URL` | the Project URL |
| **Secret** | `SUPABASE_PUBLISHABLE_KEY` | the publishable key |

Use type **Secret** for both. (`wrangler.jsonc` also sets `keep_vars: true`, so even
plain dashboard variables are no longer removed by a deploy.)

If the login page ever says **“The member area is being set up”**, these two values are
missing. Check this page first.

Then merge the pull request. Cloudflare rebuilds and deploys automatically.

### Notification emails (“Your result is ready”)

The site sends these itself, every 10 minutes, through Resend. It needs three more
settings in the same **Variables and Secrets** page:

1. **Create the outbox secret.** In **Supabase → SQL Editor → New query**, run:

   ```sql
   select private.rotate_outbox_secret();
   ```

   Copy the long value it returns (you only see it once; running it again makes a new one
   and the old one stops working).
2. **Create a Resend API key for the website:** Resend → **API Keys → Create API Key**,
   permission **Sending access**, restricted to your verified domain. (A separate key from
   the one Supabase uses means either can be revoked on its own.)
3. Add in Cloudflare:

   | Type | Name | Value |
   | --- | --- | --- |
   | **Secret** | `NOTIFY_SECRET` | the value from step 1 |
   | **Secret** | `RESEND_API_KEY` | the key from step 2 |
   | **Text** (variable) | `EMAIL_FROM` | `AK Cash Club <no-reply@your-verified-domain>`, the same sender address you used for Supabase SMTP in section 3 |

Until all three are set, nothing is sent and emails simply wait (for up to 3 days).
To check it’s working: **Workers & Pages → ak-cash-club-website → Logs** shows
`notify: sent 1, failed 0` after an email goes out.

---

## 5. Activate your host account (requires you)

The host role can’t be granted by the website, by any username, or by any API.
It’s a single database row that only the Supabase project owner can add.

1. On the live site, **Sign up** with your own email and any username (it will be
   replaced with “AK (host)”). Open the verification email and confirm.
2. In Supabase, **Authentication → Users**, find your email and copy the **User UID**.
3. In **SQL Editor**, run (with your UID):

   ```sql
   insert into private.host_account (user_id) values ('PASTE-YOUR-USER-UID-HERE');

   -- Check it worked: should return "AK (host)"
   select username from public.profiles where id = 'PASTE-YOUR-USER-UID-HERE';
   ```

4. On the site, log out and back in, then open **Host Dashboard**. You’ll be asked to set
   up two-factor authentication: scan the QR code with your authenticator app and enter
   the 6-digit code. From then on, the Host Dashboard asks for a code each time you log in.

The host identity is deliberately **immutable**: running that insert a second time, or
updating/deleting the row, is refused by the database.

### Recovering host access

- **Forgot your password:** use “Forgot your password?” like anyone else.
- **Lost your authenticator phone:** Supabase → **Authentication → Users →** your user →
  remove the MFA factor (or in SQL Editor:
  `delete from auth.mfa_factors where user_id = 'YOUR-UID';`). Then log in and set up
  two-factor again.
- **Changing who the host is** (rare): this deliberately needs SQL in the Supabase
  dashboard, not the website. Ask a developer, or run:

  ```sql
  begin;
  alter table private.host_account disable trigger host_account_no_update;
  update private.host_account set user_id = 'NEW-HOST-UID';
  alter table private.host_account enable trigger host_account_no_update;
  update public.profiles set username = username where id = 'NEW-HOST-UID';
  commit;
  ```

  The previous host keeps a profile named “AK (host)”; rename it in SQL if needed.

---

## 6. After launch: quick checks

1. Sign up as a test player with a second email address → the verification email arrives,
   looks right, and the link works.
2. Log in → **My Dashboard** shows the opt-in screen. Turn tracking on in **Account**.
3. As the host, record a small test session including the test player, review, save.
4. As the test player, check the dashboard shows the session, stats and chart.
5. Try **Forgot your password?** with the test address.
6. Delete the test session (Host Dashboard → session → Delete) and the test account
   (Account → Delete account).

## Backups and the free plan

- On the **free** Supabase plan, projects pause after a week without activity (data is
  kept; you restore it from the dashboard) and there are no automatic backups. Download a
  backup regularly: **Database → Backups**, or `npx supabase db dump`.
- **Pro** includes daily backups and no pausing. Recommended once players rely on it.
