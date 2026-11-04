-- =============================================================================
-- Email notifications
--
-- 1. notification_preferences: what each member wants to be emailed about.
--    "Your result is ready" and game announcements are opt-in (off until the
--    member turns them on). Seat updates and reminders about a seat the
--    member booked are on by default and can be turned off.
-- 2. private.notification_outbox: emails waiting to be sent. Rows are created
--    only by the database itself (triggers), never through the API.
-- 3. claim_notifications / complete_notification: used by the site's
--    scheduled job to pick up and mark emails. They can be called with the
--    publishable key but refuse to do anything without the outbox secret.
--    Only the secret's SHA-256 hash is stored, in private.app_settings.
--    The owner creates the secret once with:  select private.rotate_outbox_secret();
-- 4. Unsubscribe tokens: every email carries a link that turns that kind of
--    email off without logging in.
--
-- Emails never include amounts or other players. A results email only says
-- that a result was posted and links to the dashboard.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Settings readable only inside the database (no API access at all)
-- -----------------------------------------------------------------------------

create table if not exists private.app_settings (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);
revoke all on table private.app_settings from public, anon, authenticated;

create or replace function private.random_token()
returns text
language sql
volatile
set search_path = ''
as $$
  -- Two random UUIDs: 64 hex characters, about 244 random bits.
  select replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
$$;
revoke all on function private.random_token() from public, anon, authenticated;

-- Owner-only (SQL editor). Creates a new outbox secret, stores its hash and
-- returns the secret once. Paste it into Cloudflare as NOTIFY_SECRET.
create or replace function private.rotate_outbox_secret()
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_secret text := private.random_token();
begin
  insert into private.app_settings (key, value)
  values ('outbox_secret_sha256', encode(sha256(convert_to(v_secret, 'UTF8')), 'hex'))
  on conflict (key) do update set value = excluded.value, updated_at = now();
  return v_secret;
end;
$$;
revoke all on function private.rotate_outbox_secret() from public, anon, authenticated;

create or replace function private.assert_outbox_secret(p_secret text)
returns void
language plpgsql
stable
set search_path = ''
as $$
declare
  v_hash text;
begin
  select value into v_hash from private.app_settings where key = 'outbox_secret_sha256';
  if v_hash is null
     or p_secret is null
     or char_length(p_secret) < 32
     or char_length(p_secret) > 200
     or encode(sha256(convert_to(p_secret, 'UTF8')), 'hex') <> v_hash then
    raise exception 'forbidden' using errcode = '42501';
  end if;
end;
$$;
revoke all on function private.assert_outbox_secret(text) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Preferences
-- -----------------------------------------------------------------------------

create table if not exists public.notification_preferences (
  player_id          uuid primary key references public.profiles (id) on delete cascade,
  results_ready      boolean not null default false,
  game_announcements boolean not null default false,
  seat_updates       boolean not null default true,
  game_reminders     boolean not null default true,
  -- When each opt-in was given (consent record; null while off).
  results_ready_consented_at      timestamptz,
  game_announcements_consented_at timestamptz,
  unsubscribe_token  text not null unique default private.random_token(),
  updated_at         timestamptz not null default now(),
  constraint notification_preferences_results_consent
    check (results_ready = (results_ready_consented_at is not null)),
  constraint notification_preferences_announce_consent
    check (game_announcements = (game_announcements_consented_at is not null))
);

drop trigger if exists notification_preferences_touch on public.notification_preferences;
create trigger notification_preferences_touch before update on public.notification_preferences
  for each row execute function private.touch_updated_at();

-- No direct API access (the row holds the unsubscribe token). Members use the
-- RPCs below.
alter table public.notification_preferences enable row level security;
revoke all on table public.notification_preferences from public, anon, authenticated;

-- Every profile gets a preferences row (defaults), now and for new sign-ups.
insert into public.notification_preferences (player_id)
select id from public.profiles
on conflict (player_id) do nothing;

create or replace function private.profiles_create_prefs()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.notification_preferences (player_id) values (new.id)
  on conflict (player_id) do nothing;
  return new;
end;
$$;
revoke all on function private.profiles_create_prefs() from public, anon, authenticated;

drop trigger if exists profiles_create_prefs on public.profiles;
create trigger profiles_create_prefs after insert on public.profiles
  for each row execute function private.profiles_create_prefs();

-- Does this member want this kind of email?
create or replace function private.wants_email(p_player uuid, p_kind text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce((
    select case p_kind
             when 'results_ready'     then n.results_ready
             when 'game_announcement' then n.game_announcements
             when 'seat_update'       then n.seat_updates
             when 'game_reminder'     then n.game_reminders
             else false
           end
      from public.notification_preferences n
     where n.player_id = p_player), false);
$$;
revoke all on function private.wants_email(uuid, text) from public, anon, authenticated;

create or replace function public.get_my_notification_prefs()
returns table (results_ready boolean, game_announcements boolean,
               seat_updates boolean, game_reminders boolean)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  insert into public.notification_preferences (player_id)
  select auth.uid() where exists (select 1 from public.profiles p where p.id = auth.uid())
  on conflict (player_id) do nothing;
  return query
    select n.results_ready, n.game_announcements, n.seat_updates, n.game_reminders
      from public.notification_preferences n
     where n.player_id = auth.uid();
end;
$$;

-- p_prefs: any of { results_ready, game_announcements, seat_updates, game_reminders } as booleans.
-- Keys that are missing keep their current value.
create or replace function public.set_my_notification_prefs(p_prefs jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  k text;
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if jsonb_typeof(p_prefs) <> 'object' then raise exception 'invalid_payload'; end if;
  for k in select jsonb_object_keys(p_prefs) loop
    if k not in ('results_ready', 'game_announcements', 'seat_updates', 'game_reminders')
       or jsonb_typeof(p_prefs -> k) <> 'boolean' then
      raise exception 'invalid_payload';
    end if;
  end loop;

  insert into public.notification_preferences (player_id)
  select auth.uid() where exists (select 1 from public.profiles p where p.id = auth.uid())
  on conflict (player_id) do nothing;

  update public.notification_preferences n
     set results_ready      = coalesce((p_prefs ->> 'results_ready')::boolean, n.results_ready),
         game_announcements = coalesce((p_prefs ->> 'game_announcements')::boolean, n.game_announcements),
         seat_updates       = coalesce((p_prefs ->> 'seat_updates')::boolean, n.seat_updates),
         game_reminders     = coalesce((p_prefs ->> 'game_reminders')::boolean, n.game_reminders),
         results_ready_consented_at = case
           when not coalesce((p_prefs ->> 'results_ready')::boolean, n.results_ready) then null
           else coalesce(n.results_ready_consented_at, now()) end,
         game_announcements_consented_at = case
           when not coalesce((p_prefs ->> 'game_announcements')::boolean, n.game_announcements) then null
           else coalesce(n.game_announcements_consented_at, now()) end
   where n.player_id = auth.uid();
  if not found then raise exception 'not_authenticated' using errcode = '42501'; end if;
end;
$$;

-- Turn off one kind of email (or all) from an email link, without logging in.
-- p_kind: results_ready | game_announcements | seat_updates | game_reminders | all
create or replace function public.unsubscribe_with_token(p_token text, p_kind text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then return false; end if;
  if p_kind not in ('results_ready', 'game_announcements', 'seat_updates', 'game_reminders', 'all') then
    raise exception 'invalid_payload';
  end if;
  update public.notification_preferences n
     set results_ready      = case when p_kind in ('results_ready', 'all') then false else n.results_ready end,
         game_announcements = case when p_kind in ('game_announcements', 'all') then false else n.game_announcements end,
         seat_updates       = case when p_kind in ('seat_updates', 'all') then false else n.seat_updates end,
         game_reminders     = case when p_kind in ('game_reminders', 'all') then false else n.game_reminders end,
         results_ready_consented_at =
           case when p_kind in ('results_ready', 'all') then null else n.results_ready_consented_at end,
         game_announcements_consented_at =
           case when p_kind in ('game_announcements', 'all') then null else n.game_announcements_consented_at end
   where n.unsubscribe_token = p_token;
  return found;
end;
$$;

revoke all on function public.get_my_notification_prefs() from public, anon, authenticated;
revoke all on function public.set_my_notification_prefs(jsonb) from public, anon, authenticated;
revoke all on function public.unsubscribe_with_token(text, text) from public, anon, authenticated;
grant execute on function public.get_my_notification_prefs() to authenticated;
grant execute on function public.set_my_notification_prefs(jsonb) to authenticated;
grant execute on function public.unsubscribe_with_token(text, text) to anon, authenticated;

-- -----------------------------------------------------------------------------
-- Outbox
-- -----------------------------------------------------------------------------

create table if not exists private.notification_outbox (
  id           uuid primary key default gen_random_uuid(),
  player_id    uuid not null references public.profiles (id) on delete cascade,
  kind         text not null check (kind in ('results_ready', 'game_announcement', 'seat_update', 'game_reminder')),
  ref_id       uuid,
  -- One email per event: e.g. results_ready:<session id>:<player id>
  dedupe_key   text not null unique check (char_length(dedupe_key) <= 200),
  status       text not null default 'pending' check (status in ('pending', 'sent', 'failed', 'skipped')),
  send_after   timestamptz not null default now(),
  attempts     integer not null default 0,
  locked_until timestamptz,
  last_error   text check (last_error is null or char_length(last_error) <= 300),
  created_at   timestamptz not null default now(),
  sent_at      timestamptz
);
create index if not exists notification_outbox_due_idx
  on private.notification_outbox (send_after) where status = 'pending';
revoke all on table private.notification_outbox from public, anon, authenticated;

create or replace function private.enqueue_notification(
  p_player uuid, p_kind text, p_ref uuid, p_dedupe text, p_send_after timestamptz default now())
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_player is null or not private.wants_email(p_player, p_kind) then return; end if;
  insert into private.notification_outbox (player_id, kind, ref_id, dedupe_key, send_after)
  values (p_player, p_kind, p_ref, p_dedupe, p_send_after)
  on conflict (dedupe_key) do nothing;
end;
$$;
revoke all on function private.enqueue_notification(uuid, text, uuid, text, timestamptz)
  from public, anon, authenticated;

-- "Your result is ready": when the host links a result to a tracked player.
-- Waits 15 minutes so quick corrections settle first, and skips back-filled
-- games more than a week old.
create or replace function private.session_results_notify()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.player_id is null then return new; end if;
  if tg_op = 'UPDATE' and new.player_id is not distinct from old.player_id then return new; end if;
  if exists (
       select 1
         from public.game_sessions s
         join public.profiles p on p.id = new.player_id
        where s.id = new.session_id
          and p.tracking_enabled
          and s.played_on >= current_date - 7) then
    perform private.enqueue_notification(
      new.player_id, 'results_ready', new.session_id,
      'results_ready:' || new.session_id || ':' || new.player_id,
      now() + interval '15 minutes');
  end if;
  return new;
end;
$$;
revoke all on function private.session_results_notify() from public, anon, authenticated;

drop trigger if exists session_results_notify on public.session_results;
create trigger session_results_notify after insert or update of player_id on public.session_results
  for each row execute function private.session_results_notify();

-- Is a queued email still appropriate right now? (Preferences, tracking and
-- the result itself are re-checked at send time.)
create or replace function private.notification_still_wanted(p_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1
      from private.notification_outbox o
      join public.profiles p on p.id = o.player_id
      join auth.users u on u.id = o.player_id
     where o.id = p_id
       and u.email is not null
       and private.wants_email(o.player_id, o.kind)
       and (o.kind <> 'results_ready' or (
             p.tracking_enabled
             and exists (select 1 from public.session_results r
                          where r.session_id = o.ref_id and r.player_id = o.player_id))));
$$;
revoke all on function private.notification_still_wanted(uuid) from public, anon, authenticated;

-- Pick up to p_limit due emails for sending. Each is locked for 10 minutes.
create or replace function public.claim_notifications(p_secret text, p_limit integer default 25)
returns table (notification_id uuid, kind text, email text, username text,
               unsubscribe_token text, payload jsonb)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_ids uuid[];
begin
  perform private.assert_outbox_secret(p_secret);

  -- Housekeeping: keep the outbox small.
  delete from private.notification_outbox
   where status <> 'pending' and created_at < now() - interval '30 days';
  update private.notification_outbox
     set status = 'failed', last_error = 'expired', locked_until = null
   where status = 'pending' and created_at < now() - interval '3 days';

  select coalesce(array_agg(o.id), '{}') into v_ids
    from (select o.id
            from private.notification_outbox o
           where o.status = 'pending'
             and o.send_after <= now()
             and (o.locked_until is null or o.locked_until < now())
             and o.attempts < 5
           order by o.send_after
           limit greatest(1, least(coalesce(p_limit, 25), 50))
           for update skip locked) o;

  update private.notification_outbox o
     set status = 'skipped', locked_until = null
   where o.id = any (v_ids) and not private.notification_still_wanted(o.id);

  update private.notification_outbox o
     set attempts = o.attempts + 1, locked_until = now() + interval '10 minutes'
   where o.id = any (v_ids) and o.status = 'pending';

  return query
    select o.id, o.kind, u.email::text, p.username, n.unsubscribe_token,
           case o.kind
             when 'results_ready' then (
               select jsonb_build_object('played_on', s.played_on, 'title', s.title, 'stakes', s.stakes)
                 from public.game_sessions s where s.id = o.ref_id)
             else '{}'::jsonb
           end
      from private.notification_outbox o
      join public.profiles p on p.id = o.player_id
      join auth.users u on u.id = o.player_id
      join public.notification_preferences n on n.player_id = o.player_id
     where o.id = any (v_ids) and o.status = 'pending'
     order by o.send_after;
end;
$$;

-- Report the outcome of one claimed email. p_error null = sent.
create or replace function public.complete_notification(p_secret text, p_id uuid, p_error text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.assert_outbox_secret(p_secret);
  if p_error is null then
    update private.notification_outbox
       set status = 'sent', sent_at = now(), locked_until = null, last_error = null
     where id = p_id and status = 'pending';
  else
    update private.notification_outbox
       set last_error   = left(p_error, 300),
           locked_until = null,
           status       = case when attempts >= 5 then 'failed' else 'pending' end,
           send_after   = now() + make_interval(mins => 5 * attempts * attempts)
     where id = p_id and status = 'pending';
  end if;
end;
$$;

revoke all on function public.claim_notifications(text, integer) from public, anon, authenticated;
revoke all on function public.complete_notification(text, uuid, text) from public, anon, authenticated;
grant execute on function public.claim_notifications(text, integer) to anon;
grant execute on function public.complete_notification(text, uuid, text) to anon;
