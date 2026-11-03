-- =============================================================================
-- AK Cash Club — player portal schema
--
-- Security model (read this before changing anything):
--   * Every table has Row Level Security enabled.
--   * Players NEVER receive INSERT/UPDATE/DELETE privileges on any table.
--     All writes go through the functions below, which validate input.
--   * Host status = "your auth user id is the single row in private.host_account".
--     It is never derived from a username. No API path can write that table;
--     it is set once, by the project owner, in the Supabase SQL editor.
--   * Every host function first calls private.assert_host(), which also
--     requires a multi-factor (aal2) session.
--   * Money is stored as integer cents (bigint). No floating point anywhere.
--   * Every change to financial records is written to public.audit_log by
--     triggers. Nobody (including the host) can edit or delete audit rows.
-- =============================================================================

create schema if not exists private;
revoke all on schema private from public;
-- API roles need USAGE only so RLS policies can call private.is_host_mfa().
grant usage on schema private to authenticated;

-- -----------------------------------------------------------------------------
-- Small pure helpers
-- -----------------------------------------------------------------------------

-- Sum of a bigint[] (immutable so it can be used in generated columns).
create or replace function private.array_sum(a bigint[])
returns bigint
language sql
immutable
parallel safe
set search_path = ''
as $$
  select coalesce(sum(x), 0)::bigint from unnest(a) as x;
$$;

-- True when every element is > 0 (empty array => true).
create or replace function private.all_positive(a bigint[])
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select coalesce(bool_and(x > 0), true) from unnest(a) as x;
$$;

-- "Skeleton" of a username, used for case-insensitive uniqueness and to stop
-- look-alike impersonation:  "AK-H0st", "ak_host", "AK (host)" -> "akhost".
create or replace function private.username_skeleton(p text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select translate(
           regexp_replace(lower(coalesce(p, '')), '[^a-z0-9]', '', 'g'),
           '013457|i',
           'oleastll'
         );
$$;

-- The host's fixed public name.
create or replace function private.host_display_name()
returns text language sql immutable set search_path = '' as $$ select 'AK (host)'::text $$;

-- Usernames nobody but the host may use (compared by skeleton).
create or replace function private.username_is_reserved(p text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  with k as (select private.username_skeleton(p) as s)
  select
    -- exact reserved words
    k.s in (
      select private.username_skeleton(w) from unnest(array[
        'ak', 'akhost', 'host', 'thehost', 'admin', 'administrator', 'root',
        'owner', 'moderator', 'mod', 'staff', 'support', 'help', 'dealer',
        'system', 'official', 'akcash', 'akcashclub', 'cashclub', 'null',
        'undefined', 'anonymous', 'removed', 'deleted', 'guest', 'account',
        'dashboard', 'security', 'billing'
      ]) as w
    )
    -- anything containing these look-alike fragments
    or k.s like '%' || private.username_skeleton('akhost') || '%'
    or k.s like '%' || private.username_skeleton('admin') || '%'
    or k.s like '%' || private.username_skeleton('akcashclub') || '%'
    or k.s like '%' || private.username_skeleton('moderator') || '%'
  from k;
$$;

-- Player username format: 3-20 chars, ASCII letters/digits and . _ -,
-- starting and ending with a letter or digit, no doubled separators.
create or replace function private.username_format_ok(p text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p is not null
     and char_length(p) between 3 and 20
     and p ~ '^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$'
     and p !~ '[._-]{2,}';
$$;

-- -----------------------------------------------------------------------------
-- Host identity (private schema: not reachable through the Supabase API)
-- -----------------------------------------------------------------------------

create table if not exists private.host_account (
  singleton  boolean primary key default true check (singleton),
  user_id    uuid not null unique references auth.users (id) on delete restrict,
  created_at timestamptz not null default now()
);
revoke all on table private.host_account from public, anon, authenticated;

-- The host identity is immutable once set. Changing it requires the project
-- owner to deliberately drop this trigger in the SQL editor.
create or replace function private.host_account_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'host_account_is_immutable'
    using hint = 'The host identity can only be changed by the project owner in the SQL editor.';
end;
$$;

drop trigger if exists host_account_no_update on private.host_account;
create trigger host_account_no_update
  before update or delete on private.host_account
  for each row execute function private.host_account_immutable();

create or replace function private.is_host()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from private.host_account h where h.user_id = auth.uid()
  );
$$;

-- Host AND signed in with a second factor (Supabase sets aal = 'aal2').
create or replace function private.is_host_mfa()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_host()
     and coalesce(auth.jwt() ->> 'aal', '') = 'aal2';
$$;

create or replace function private.assert_host()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not private.is_host() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'mfa_required' using errcode = '42501';
  end if;
end;
$$;

revoke all on function private.is_host() from public, anon, authenticated;
revoke all on function private.is_host_mfa() from public, anon, authenticated;
revoke all on function private.assert_host() from public, anon, authenticated;
grant execute on function private.is_host() to authenticated;
grant execute on function private.is_host_mfa() to authenticated;
grant execute on function private.assert_host() to authenticated;

-- -----------------------------------------------------------------------------
-- Profiles
-- -----------------------------------------------------------------------------

create table if not exists public.profiles (
  id                    uuid primary key references auth.users (id) on delete cascade,
  username              text not null,
  username_key          text not null,
  tracking_enabled      boolean not null default false,
  tracking_consented_at timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint profiles_username_key_unique unique (username_key),
  constraint profiles_consent_consistent
    check (tracking_enabled = (tracking_consented_at is not null))
);

-- Validates usernames and keeps the host's name fixed.
create or replace function private.profiles_before_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_is_host boolean;
begin
  if tg_op = 'UPDATE' and new.id <> old.id then
    raise exception 'profile_id_immutable';
  end if;

  select exists (select 1 from private.host_account h where h.user_id = new.id)
    into v_is_host;

  if v_is_host then
    -- The host's public name is fixed and cannot be changed.
    new.username := private.host_display_name();
    new.username_key := private.username_skeleton(private.host_display_name());
  elsif tg_op = 'UPDATE' and new.username is not distinct from old.username then
    -- Username unchanged (e.g. a tracking toggle): don't re-validate it, so a
    -- rule added later can't lock an existing player out of their settings.
    new.username_key := old.username_key;
  else
    new.username := btrim(new.username);
    if not private.username_format_ok(new.username) then
      raise exception 'username_invalid';
    end if;
    if private.username_is_reserved(new.username) then
      raise exception 'username_reserved';
    end if;
    if exists (
      select 1 from public.blocked_username_terms b
      where private.username_skeleton(new.username) like '%' || b.skeleton || '%'
    ) then
      raise exception 'username_blocked';
    end if;
    new.username_key := private.username_skeleton(new.username);
  end if;

  new.updated_at := now();
  return new;
end;
$$;

-- Host-maintained list of offensive terms (compared by skeleton). Kept in the
-- database so the host can extend it without a code change. The app also runs
-- a profanity filter before submitting.
create table if not exists public.blocked_username_terms (
  skeleton   text primary key check (skeleton ~ '^[a-z0-9]{3,30}$'),
  created_at timestamptz not null default now()
);

drop trigger if exists profiles_validate on public.profiles;
create trigger profiles_validate
  before insert or update on public.profiles
  for each row execute function private.profiles_before_write();

-- Create a profile automatically when a Supabase auth user is created.
-- The username comes from the sign-up metadata and is validated by the
-- trigger above; an invalid/taken name makes the whole sign-up fail.
create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, username)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'username', ''));
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

-- When the host row is created, rename the host's profile to "AK (host)".
create or replace function private.host_account_after_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.profiles set username = username where id = new.user_id;
  return new;
end;
$$;

drop trigger if exists host_account_sync_profile on private.host_account;
create trigger host_account_sync_profile
  after insert on private.host_account
  for each row execute function private.host_account_after_insert();

-- -----------------------------------------------------------------------------
-- Game sessions, results, adjustments
-- -----------------------------------------------------------------------------

create table if not exists public.game_sessions (
  id         uuid primary key default gen_random_uuid(),
  played_on  date not null check (played_on between date '2020-01-01' and date '2100-01-01'),
  game_type  text not null default 'No-Limit Texas Hold''em'
             check (char_length(btrim(game_type)) between 1 and 60),
  stakes     text not null check (char_length(btrim(stakes)) between 1 and 40),
  title      text check (title is null or char_length(title) <= 80),
  host_notes text check (host_notes is null or char_length(host_notes) <= 2000),
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists game_sessions_played_on_idx on public.game_sessions (played_on desc);

create table if not exists public.session_results (
  id                   uuid primary key default gen_random_uuid(),
  session_id           uuid not null references public.game_sessions (id) on delete cascade,
  -- null when the row belongs to a guest (not tracked) or a removed account
  player_id            uuid references public.profiles (id) on delete set null,
  -- shown to the host only; required when player_id is null
  guest_label          text check (guest_label is null or char_length(btrim(guest_label)) between 1 and 40),
  initial_buy_in_cents bigint not null check (initial_buy_in_cents between 0 and 100000000),
  add_on_cents         bigint[] not null default '{}'
                       check (private.all_positive(add_on_cents)
                              and cardinality(add_on_cents) <= 50
                              and private.array_sum(add_on_cents) <= 100000000),
  cash_out_cents       bigint not null check (cash_out_cents between 0 and 1000000000),
  total_buy_in_cents   bigint generated always as
                       (initial_buy_in_cents + private.array_sum(add_on_cents)) stored,
  net_cents            bigint generated always as
                       (cash_out_cents - initial_buy_in_cents - private.array_sum(add_on_cents)) stored,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint session_results_owner_present check (player_id is not null or guest_label is not null),
  constraint session_results_one_row_per_player unique (session_id, player_id)
);

create unique index if not exists session_results_one_row_per_guest
  on public.session_results (session_id, lower(btrim(guest_label)))
  where player_id is null and guest_label is not null;

create index if not exists session_results_player_idx on public.session_results (player_id);

-- Documented money that did not flow back to players (positive) or that was
-- added from outside the table (negative). Used to reconcile a session:
--   unexplained = sum(net_cents) + sum(adjustment amount_cents)  ->  should be 0
create table if not exists public.session_adjustments (
  id           uuid primary key default gen_random_uuid(),
  session_id   uuid not null references public.game_sessions (id) on delete cascade,
  amount_cents bigint not null check (amount_cents <> 0 and abs(amount_cents) <= 100000000),
  reason       text not null check (char_length(btrim(reason)) between 3 and 200),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- When an account is deleted, keep its rows for table reconciliation but
-- detach them from the person.
create or replace function private.profiles_before_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.session_results
     set guest_label = 'Removed account', player_id = null
   where player_id = old.id;
  return old;
end;
$$;

drop trigger if exists profiles_detach_results on public.profiles;
create trigger profiles_detach_results
  before delete on public.profiles
  for each row execute function private.profiles_before_delete();

create or replace function private.touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists game_sessions_touch on public.game_sessions;
create trigger game_sessions_touch before update on public.game_sessions
  for each row execute function private.touch_updated_at();
drop trigger if exists session_results_touch on public.session_results;
create trigger session_results_touch before update on public.session_results
  for each row execute function private.touch_updated_at();
drop trigger if exists session_adjustments_touch on public.session_adjustments;
create trigger session_adjustments_touch before update on public.session_adjustments
  for each row execute function private.touch_updated_at();

-- -----------------------------------------------------------------------------
-- Audit log (append-only)
-- -----------------------------------------------------------------------------

create table if not exists public.audit_log (
  id          bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  actor_id    uuid,                -- auth.uid() of whoever made the change
  action      text not null check (action in ('insert', 'update', 'delete')),
  table_name  text not null,
  record_id   uuid,
  session_id  uuid,
  reason      text,
  old_data    jsonb,
  new_data    jsonb
);

create index if not exists audit_log_session_idx on public.audit_log (session_id, occurred_at desc);

create or replace function private.write_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  v_new jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
  v_row jsonb := coalesce(v_new, v_old);
  v_session uuid;
begin
  if tg_op = 'UPDATE' and (v_old - 'updated_at') = (v_new - 'updated_at') then
    return new;
  end if;

  v_session := case
    when tg_table_name = 'game_sessions' then (v_row ->> 'id')::uuid
    when tg_table_name = 'profiles' then null
    else (v_row ->> 'session_id')::uuid
  end;

  insert into public.audit_log (actor_id, action, table_name, record_id, session_id, reason, old_data, new_data)
  values (
    auth.uid(),
    lower(tg_op),
    tg_table_name,
    (v_row ->> 'id')::uuid,
    v_session,
    nullif(current_setting('app.audit_reason', true), ''),
    v_old,
    v_new
  );
  return coalesce(new, old);
end;
$$;

drop trigger if exists audit_game_sessions on public.game_sessions;
create trigger audit_game_sessions after insert or update or delete on public.game_sessions
  for each row execute function private.write_audit();
drop trigger if exists audit_session_results on public.session_results;
create trigger audit_session_results after insert or update or delete on public.session_results
  for each row execute function private.write_audit();
drop trigger if exists audit_session_adjustments on public.session_adjustments;
create trigger audit_session_adjustments after insert or update or delete on public.session_adjustments
  for each row execute function private.write_audit();

-- Consent changes are audited too (only the tracking columns).
create or replace function private.audit_consent()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.tracking_enabled is distinct from old.tracking_enabled then
    insert into public.audit_log (actor_id, action, table_name, record_id, old_data, new_data)
    values (
      auth.uid(), 'update', 'profiles', new.id,
      jsonb_build_object('tracking_enabled', old.tracking_enabled),
      jsonb_build_object('tracking_enabled', new.tracking_enabled,
                         'tracking_consented_at', new.tracking_consented_at)
    );
  end if;
  return new;
end;
$$;

drop trigger if exists audit_profiles_consent on public.profiles;
create trigger audit_profiles_consent after update on public.profiles
  for each row execute function private.audit_consent();

-- -----------------------------------------------------------------------------
-- Privileges + Row Level Security
-- (Supabase grants broad default privileges on new public objects; we revoke
-- them and grant back only what is needed.)
-- -----------------------------------------------------------------------------

alter table public.profiles               enable row level security;
alter table public.game_sessions          enable row level security;
alter table public.session_results        enable row level security;
alter table public.session_adjustments    enable row level security;
alter table public.audit_log              enable row level security;
alter table public.blocked_username_terms enable row level security;

revoke all on table public.profiles, public.game_sessions, public.session_results,
  public.session_adjustments, public.audit_log, public.blocked_username_terms
  from public, anon, authenticated;

-- Read-only grants (column-limited where useful). No write grants at all.
grant select (id, username, tracking_enabled, tracking_consented_at, created_at)
  on public.profiles to authenticated;
grant select (id, played_on, game_type, stakes, title)
  on public.game_sessions to authenticated;
grant select on public.session_results to authenticated;
grant select on public.session_adjustments to authenticated;
grant select on public.audit_log to authenticated;

-- profiles: you see yourself; the host (with MFA) sees everyone.
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated
  using (id = auth.uid() or private.is_host_mfa());

-- results: your own rows, only while tracking is on; the host sees all.
drop policy if exists session_results_select on public.session_results;
create policy session_results_select on public.session_results
  for select to authenticated
  using (
    private.is_host_mfa()
    or (
      player_id = auth.uid()
      and exists (select 1 from public.profiles p where p.id = auth.uid() and p.tracking_enabled)
    )
  );

-- sessions: those you have a visible result in; the host sees all.
drop policy if exists game_sessions_select on public.game_sessions;
create policy game_sessions_select on public.game_sessions
  for select to authenticated
  using (
    private.is_host_mfa()
    or exists (
      select 1 from public.session_results r
      join public.profiles p on p.id = r.player_id
      where r.session_id = game_sessions.id
        and r.player_id = auth.uid()
        and p.tracking_enabled
    )
  );

drop policy if exists session_adjustments_select on public.session_adjustments;
create policy session_adjustments_select on public.session_adjustments
  for select to authenticated using (private.is_host_mfa());

drop policy if exists audit_log_select on public.audit_log;
create policy audit_log_select on public.audit_log
  for select to authenticated using (private.is_host_mfa());

-- blocked_username_terms: no API access at all (managed in the SQL editor).

-- =============================================================================
-- Functions callable through the API
-- =============================================================================

-- ---- Anyone: check a username before signing up -----------------------------
-- Returns 'ok' | 'invalid' | 'reserved' | 'blocked' | 'taken'.
create or replace function public.check_username(p_username text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v text := btrim(coalesce(p_username, ''));
begin
  if not private.username_format_ok(v) then return 'invalid'; end if;
  if private.username_is_reserved(v) then return 'reserved'; end if;
  if exists (
    select 1 from public.blocked_username_terms b
    where private.username_skeleton(v) like '%' || b.skeleton || '%'
  ) then return 'blocked'; end if;
  if exists (
    select 1 from public.profiles p
    where p.username_key = private.username_skeleton(v)
      and (auth.uid() is null or p.id <> auth.uid())
  ) then return 'taken'; end if;
  return 'ok';
end;
$$;

-- ---- Signed-in user: who am I? ---------------------------------------------
create or replace function public.my_access()
returns table (user_id uuid, username text, is_host boolean, mfa_verified boolean,
               tracking_enabled boolean, tracking_consented_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, p.username, private.is_host(),
         coalesce(auth.jwt() ->> 'aal', '') = 'aal2',
         p.tracking_enabled, p.tracking_consented_at
    from public.profiles p
   where p.id = auth.uid();
$$;

-- ---- Signed-in player: profile changes --------------------------------------
create or replace function public.update_my_username(p_username text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text;
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if private.is_host() then raise exception 'host_name_is_fixed'; end if;
  update public.profiles set username = p_username where id = auth.uid()
    returning username into v_name;
  return v_name;
end;
$$;

create or replace function public.set_my_tracking(p_enabled boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  update public.profiles
     set tracking_enabled = p_enabled,
         tracking_consented_at = case when p_enabled then now() else null end
   where id = auth.uid();
end;
$$;

-- Detach every past result from my account (rows stay, anonymised, for the
-- host's table reconciliation). Returns the number of rows detached.
create or replace function public.unlink_my_history()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer;
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  perform set_config('app.audit_reason', 'Player removed their history from their account', true);
  update public.session_results
     set guest_label = 'Unlinked member', player_id = null
   where player_id = auth.uid();
  get diagnostics n = row_count;
  return n;
end;
$$;

-- My results (only while tracking is enabled), newest first.
create or replace function public.get_my_results()
returns table (
  result_id uuid, session_id uuid, played_on date, game_type text, stakes text, title text,
  initial_buy_in_cents bigint, add_on_cents bigint[], total_buy_in_cents bigint,
  cash_out_cents bigint, net_cents bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select r.id, s.id, s.played_on, s.game_type, s.stakes, s.title,
         r.initial_buy_in_cents, r.add_on_cents, r.total_buy_in_cents,
         r.cash_out_cents, r.net_cents
    from public.session_results r
    join public.game_sessions s on s.id = r.session_id
    join public.profiles p on p.id = r.player_id
   where r.player_id = auth.uid()
     and p.tracking_enabled
   order by s.played_on desc, s.created_at desc;
$$;

-- Delete my account. Results are detached first (see profiles_before_delete).
create or replace function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if private.is_host() then raise exception 'host_cannot_self_delete'; end if;
  perform set_config('app.audit_reason', 'Player deleted their account', true);
  delete from auth.users where id = v_uid;
end;
$$;

-- ---- Host only (every function starts with private.assert_host()) -----------

create or replace function public.host_list_players(p_query text default null, p_limit integer default 50)
returns table (player_id uuid, username text, tracking_enabled boolean,
               tracking_consented_at timestamptz, joined_at timestamptz, sessions_tracked bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform private.assert_host();
  return query
    select p.id, p.username, p.tracking_enabled, p.tracking_consented_at, p.created_at,
           (select count(*) from public.session_results r where r.player_id = p.id)
      from public.profiles p
     where not exists (select 1 from private.host_account h where h.user_id = p.id)
       and (p_query is null or btrim(p_query) = ''
            or p.username_key like '%' || private.username_skeleton(p_query) || '%')
     order by p.tracking_enabled desc, lower(p.username)
     limit least(greatest(coalesce(p_limit, 50), 1), 200);
end;
$$;

create or replace function public.host_list_sessions(p_limit integer default 50, p_offset integer default 0)
returns table (session_id uuid, played_on date, game_type text, stakes text, title text,
               player_count bigint, total_buy_in_cents bigint, total_cash_out_cents bigint,
               total_net_cents bigint, adjustments_cents bigint, unexplained_cents bigint,
               updated_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform private.assert_host();
  return query
    select s.id, s.played_on, s.game_type, s.stakes, s.title,
           coalesce(r.n, 0), coalesce(r.buy, 0), coalesce(r.cash, 0), coalesce(r.net, 0),
           coalesce(a.adj, 0), coalesce(r.net, 0) + coalesce(a.adj, 0), s.updated_at
      from public.game_sessions s
      left join lateral (
        select count(*) n, sum(total_buy_in_cents)::bigint buy, sum(cash_out_cents)::bigint cash,
               sum(net_cents)::bigint net
          from public.session_results x where x.session_id = s.id
      ) r on true
      left join lateral (
        select sum(amount_cents)::bigint adj from public.session_adjustments y where y.session_id = s.id
      ) a on true
     order by s.played_on desc, s.created_at desc
     limit least(greatest(coalesce(p_limit, 50), 1), 200)
     offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

create or replace function public.host_get_session(p_session_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v jsonb;
begin
  perform private.assert_host();
  select jsonb_build_object(
    'session', to_jsonb(s),
    'results', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', r.id, 'player_id', r.player_id, 'username', p.username,
               'guest_label', r.guest_label, 'tracking_enabled', p.tracking_enabled,
               'initial_buy_in_cents', r.initial_buy_in_cents, 'add_on_cents', to_jsonb(r.add_on_cents),
               'total_buy_in_cents', r.total_buy_in_cents, 'cash_out_cents', r.cash_out_cents,
               'net_cents', r.net_cents) order by lower(coalesce(p.username, r.guest_label)))
        from public.session_results r
        left join public.profiles p on p.id = r.player_id
       where r.session_id = s.id), '[]'::jsonb),
    'adjustments', coalesce((
      select jsonb_agg(jsonb_build_object('id', a.id, 'amount_cents', a.amount_cents, 'reason', a.reason)
                       order by a.created_at)
        from public.session_adjustments a where a.session_id = s.id), '[]'::jsonb)
  ) into v
  from public.game_sessions s
  where s.id = p_session_id;

  if v is null then raise exception 'session_not_found'; end if;
  return v;
end;
$$;

-- Create or update a whole session atomically.
--
-- p_session = {
--   "id": uuid | null,                    -- null => create
--   "played_on": "YYYY-MM-DD", "game_type": text, "stakes": text,
--   "title": text|null, "host_notes": text|null,
--   "results": [ { "id": uuid|null, "player_id": uuid|null, "guest_label": text|null,
--                  "initial_buy_in_cents": int, "add_on_cents": [int...], "cash_out_cents": int } ],
--   "adjustments": [ { "id": uuid|null, "amount_cents": int, "reason": text } ]
-- }
-- Results/adjustments missing from the payload are deleted. Everything runs in
-- one transaction: any error rolls the whole save back.
create or replace function public.host_save_session(p_session jsonb, p_reason text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id       uuid := nullif(p_session ->> 'id', '')::uuid;
  v_is_new   boolean := v_id is null;
  v_result   jsonb;
  v_adj      jsonb;
  v_rid      uuid;
  v_player   uuid;
  v_keep_r   uuid[] := '{}';
  v_keep_a   uuid[] := '{}';
  v_add_ons  bigint[];
begin
  perform private.assert_host();

  if jsonb_typeof(p_session) <> 'object' then raise exception 'invalid_payload'; end if;
  if jsonb_typeof(coalesce(p_session -> 'results', '[]'::jsonb)) <> 'array'
     or jsonb_typeof(coalesce(p_session -> 'adjustments', '[]'::jsonb)) <> 'array' then
    raise exception 'invalid_payload';
  end if;
  if jsonb_array_length(coalesce(p_session -> 'results', '[]'::jsonb)) > 40 then
    raise exception 'too_many_players';
  end if;

  if not v_is_new and coalesce(btrim(p_reason), '') = '' then
    raise exception 'edit_reason_required';
  end if;
  perform set_config('app.audit_reason',
                     coalesce(nullif(btrim(p_reason), ''), case when v_is_new then 'Session created' end),
                     true);

  if v_is_new then
    insert into public.game_sessions (played_on, game_type, stakes, title, host_notes, created_by)
    values (
      (p_session ->> 'played_on')::date,
      coalesce(nullif(btrim(p_session ->> 'game_type'), ''), 'No-Limit Texas Hold''em'),
      btrim(p_session ->> 'stakes'),
      nullif(btrim(p_session ->> 'title'), ''),
      nullif(btrim(p_session ->> 'host_notes'), ''),
      auth.uid()
    )
    returning id into v_id;
  else
    update public.game_sessions
       set played_on  = (p_session ->> 'played_on')::date,
           game_type  = coalesce(nullif(btrim(p_session ->> 'game_type'), ''), 'No-Limit Texas Hold''em'),
           stakes     = btrim(p_session ->> 'stakes'),
           title      = nullif(btrim(p_session ->> 'title'), ''),
           host_notes = nullif(btrim(p_session ->> 'host_notes'), '')
     where id = v_id;
    if not found then raise exception 'session_not_found'; end if;
  end if;

  -- Results
  for v_result in select * from jsonb_array_elements(coalesce(p_session -> 'results', '[]'::jsonb))
  loop
    v_rid    := nullif(v_result ->> 'id', '')::uuid;
    v_player := nullif(v_result ->> 'player_id', '')::uuid;

    select coalesce(array_agg(x::bigint), '{}')
      into v_add_ons
      from jsonb_array_elements_text(coalesce(v_result -> 'add_on_cents', '[]'::jsonb)) as x;

    if v_player is not null then
      if exists (select 1 from private.host_account h where h.user_id = v_player) then
        raise exception 'host_cannot_be_player';
      end if;
      if not exists (select 1 from public.profiles p where p.id = v_player) then
        raise exception 'player_not_found';
      end if;
      -- Consent: a NEW association requires the player to have tracking on.
      if not exists (
            select 1 from public.session_results r
             where r.session_id = v_id and r.player_id = v_player)
         and not exists (
            select 1 from public.profiles p where p.id = v_player and p.tracking_enabled) then
        raise exception 'player_not_tracking';
      end if;
    end if;

    if v_rid is not null then
      update public.session_results
         set player_id            = v_player,
             guest_label          = case when v_player is null then nullif(btrim(v_result ->> 'guest_label'), '') end,
             initial_buy_in_cents = (v_result ->> 'initial_buy_in_cents')::bigint,
             add_on_cents         = v_add_ons,
             cash_out_cents       = (v_result ->> 'cash_out_cents')::bigint
       where id = v_rid and session_id = v_id;
      if not found then raise exception 'result_not_found'; end if;
    else
      insert into public.session_results
        (session_id, player_id, guest_label, initial_buy_in_cents, add_on_cents, cash_out_cents)
      values (
        v_id, v_player,
        case when v_player is null then nullif(btrim(v_result ->> 'guest_label'), '') end,
        (v_result ->> 'initial_buy_in_cents')::bigint,
        v_add_ons,
        (v_result ->> 'cash_out_cents')::bigint
      )
      returning id into v_rid;
    end if;
    v_keep_r := v_keep_r || v_rid;
  end loop;

  delete from public.session_results
   where session_id = v_id and not (id = any (v_keep_r));

  -- Adjustments
  for v_adj in select * from jsonb_array_elements(coalesce(p_session -> 'adjustments', '[]'::jsonb))
  loop
    v_rid := nullif(v_adj ->> 'id', '')::uuid;
    if v_rid is not null then
      update public.session_adjustments
         set amount_cents = (v_adj ->> 'amount_cents')::bigint,
             reason       = btrim(v_adj ->> 'reason')
       where id = v_rid and session_id = v_id;
      if not found then raise exception 'adjustment_not_found'; end if;
    else
      insert into public.session_adjustments (session_id, amount_cents, reason)
      values (v_id, (v_adj ->> 'amount_cents')::bigint, btrim(v_adj ->> 'reason'))
      returning id into v_rid;
    end if;
    v_keep_a := v_keep_a || v_rid;
  end loop;

  delete from public.session_adjustments
   where session_id = v_id and not (id = any (v_keep_a));

  return v_id;
end;
$$;

create or replace function public.host_delete_session(p_session_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.assert_host();
  if coalesce(btrim(p_reason), '') = '' then raise exception 'edit_reason_required'; end if;
  perform set_config('app.audit_reason', btrim(p_reason), true);
  delete from public.game_sessions where id = p_session_id;
  if not found then raise exception 'session_not_found'; end if;
end;
$$;

create or replace function public.host_get_player_results(p_player_id uuid)
returns table (session_id uuid, played_on date, stakes text, title text,
               total_buy_in_cents bigint, cash_out_cents bigint, net_cents bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform private.assert_host();
  return query
    select s.id, s.played_on, s.stakes, s.title, r.total_buy_in_cents, r.cash_out_cents, r.net_cents
      from public.session_results r
      join public.game_sessions s on s.id = r.session_id
     where r.player_id = p_player_id
     order by s.played_on desc, s.created_at desc;
end;
$$;

create or replace function public.host_get_audit(p_session_id uuid default null, p_limit integer default 100)
returns table (id bigint, occurred_at timestamptz, actor_id uuid, action text, table_name text,
               record_id uuid, session_id uuid, reason text, old_data jsonb, new_data jsonb)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform private.assert_host();
  return query
    select a.id, a.occurred_at, a.actor_id, a.action, a.table_name, a.record_id, a.session_id,
           a.reason, a.old_data, a.new_data
      from public.audit_log a
     where p_session_id is null or a.session_id = p_session_id
     order by a.occurred_at desc, a.id desc
     limit least(greatest(coalesce(p_limit, 100), 1), 500);
end;
$$;

-- ---- Function privileges ----------------------------------------------------
-- Supabase grants EXECUTE to PUBLIC *and directly* to anon/authenticated by
-- default, so each must be revoked explicitly before granting back.

revoke all on function public.check_username(text) from public, anon, authenticated;
revoke all on function public.my_access() from public, anon, authenticated;
revoke all on function public.update_my_username(text) from public, anon, authenticated;
revoke all on function public.set_my_tracking(boolean) from public, anon, authenticated;
revoke all on function public.unlink_my_history() from public, anon, authenticated;
revoke all on function public.get_my_results() from public, anon, authenticated;
revoke all on function public.delete_my_account() from public, anon, authenticated;
revoke all on function public.host_list_players(text, integer) from public, anon, authenticated;
revoke all on function public.host_list_sessions(integer, integer) from public, anon, authenticated;
revoke all on function public.host_get_session(uuid) from public, anon, authenticated;
revoke all on function public.host_save_session(jsonb, text) from public, anon, authenticated;
revoke all on function public.host_delete_session(uuid, text) from public, anon, authenticated;
revoke all on function public.host_get_player_results(uuid) from public, anon, authenticated;
revoke all on function public.host_get_audit(uuid, integer) from public, anon, authenticated;

grant execute on function public.check_username(text) to anon, authenticated;
grant execute on function public.my_access() to authenticated;
grant execute on function public.update_my_username(text) to authenticated;
grant execute on function public.set_my_tracking(boolean) to authenticated;
grant execute on function public.unlink_my_history() to authenticated;
grant execute on function public.get_my_results() to authenticated;
grant execute on function public.delete_my_account() to authenticated;
grant execute on function public.host_list_players(text, integer) to authenticated;
grant execute on function public.host_list_sessions(integer, integer) to authenticated;
grant execute on function public.host_get_session(uuid) to authenticated;
grant execute on function public.host_save_session(jsonb, text) to authenticated;
grant execute on function public.host_delete_session(uuid, text) to authenticated;
grant execute on function public.host_get_player_results(uuid) to authenticated;
grant execute on function public.host_get_audit(uuid, integer) to authenticated;

-- Internal helpers must not be callable directly by API roles.
revoke all on function private.array_sum(bigint[]) from public, anon, authenticated;
revoke all on function private.all_positive(bigint[]) from public, anon, authenticated;
revoke all on function private.username_skeleton(text) from public, anon, authenticated;
revoke all on function private.host_display_name() from public, anon, authenticated;
revoke all on function private.username_is_reserved(text) from public, anon, authenticated;
revoke all on function private.username_format_ok(text) from public, anon, authenticated;
revoke all on function private.handle_new_user() from public, anon, authenticated;
revoke all on function private.profiles_before_write() from public, anon, authenticated;
revoke all on function private.profiles_before_delete() from public, anon, authenticated;
revoke all on function private.host_account_after_insert() from public, anon, authenticated;
revoke all on function private.host_account_immutable() from public, anon, authenticated;
revoke all on function private.write_audit() from public, anon, authenticated;
revoke all on function private.audit_consent() from public, anon, authenticated;
revoke all on function private.touch_updated_at() from public, anon, authenticated;
-- (Generated columns and check constraints that use these run inside the
-- SECURITY DEFINER host functions, so API roles never need EXECUTE on them.)
