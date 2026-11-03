# Handling corrections and data requests

Players are told (in the privacy notice) to message **@akcashclub on Instagram** for
corrections, copies of their data, or deletion help. Aim to respond within **30 days**.
Keep a simple log of each request (date received, what was asked, what was done, date
closed). A note in your phone or a spreadsheet is fine.

Before acting on a request, **confirm it’s really them**. Ask for the email address on
their account, then send a short confirmation message to that address (from your own
email) and wait for their reply. Don’t act on an Instagram message alone for deletions
or data copies.

## “A result is wrong”

1. Host Dashboard → **Sessions** → open the session.
2. Fix the amount, enter a **reason** (e.g. “Corrected cash-out per player request on
   Nov 4”), **Review**, then **Confirm and save**.
3. The change is recorded permanently in the **Audit log** with before/after values.

If you disagree with the player, keep the record as is, and note the disagreement in the
session’s private host notes.

## “Please send me my data”

They can already see everything tracked about them on **My Dashboard**. For a full copy,
run this in the Supabase SQL editor (replace the id) and send them the result:

```sql
select * from public.profiles where id = 'PLAYER-UID';
select s.played_on, s.stakes, s.title, r.initial_buy_in_cents, r.add_on_cents,
       r.cash_out_cents, r.net_cents
  from public.session_results r join public.game_sessions s on s.id = r.session_id
 where r.player_id = 'PLAYER-UID' order by s.played_on;
```

Find the player’s UID under **Authentication → Users** (search their email).

## “Please delete my data”

Players can do this themselves: **Account → Delete account** (or **Remove my history**
to keep the account but detach past results). If they can’t log in:

1. Supabase → **Authentication → Users** → find the user → **Delete user**.
2. This deletes their login, email and profile. Their past results stay only as anonymous
   amounts labelled “Removed account”, so table totals still reconcile.

To also erase those anonymous amounts (rarely needed), delete or edit the sessions from
the Host Dashboard, giving a reason.

## “Stop tracking me”

They can turn tracking off themselves in **Account**. Their results disappear from their
dashboard immediately and nothing new can be linked to them.
