-- =============================================================================
-- Games hub: host-managed attendance, guests, masked names, waitlist control
--
-- 1. The host can add people to a game directly:
--      - registered members (linked to their account), or
--      - guests with no account. A guest's real name is stored in the private
--        schema and is visible only to the host. Everyone else sees
--        "Guest 1", "Guest 2"... numbered per game, never reused.
-- 2. Members can see who is confirmed for a game, masked: the first letter
--    of the username plus five asterisks ("A*****"). Guests appear as
--    "Guest N". A member sees their own name in full. Masking happens in the
--    database; full names are never sent to other members.
-- 3. Waitlist: a member asking for a seat at a full game goes straight onto
--    the waitlist. The host can reorder it and move people into seats.
--    Automatic filling of open seats from the waitlist is a per-game setting
--    (off for new games; existing games keep the behaviour they had).
--    Seat allocation locks the game row, so simultaneous requests can't
--    overbook.
-- 4. Games can be marked completed (automatically when a live game is
--    finalized).
-- 5. A short announcement from the host, shown to signed-in members.
--
-- Non-destructive: existing rows are kept; constraints are widened.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Schema changes
-- -----------------------------------------------------------------------------

alter table public.game_nights
  add column if not exists auto_fill_waitlist boolean not null default false,
  add column if not exists guest_seq integer not null default 0;

-- Games created before this change filled seats from the waitlist
-- automatically; keep that for them.
update public.game_nights set auto_fill_waitlist = true
 where created_at < now() and auto_fill_waitlist = false
   and not exists (select 1 from private.app_settings where key = 'games_hub_migrated');
insert into private.app_settings (key, value) values ('games_hub_migrated', now()::text)
on conflict (key) do nothing;

alter table public.game_nights drop constraint if exists game_nights_status_check;
alter table public.game_nights add constraint game_nights_status_check
  check (status in ('open', 'closed', 'cancelled', 'completed'));

-- Seats can now belong to a guest (no account) instead of a member.
alter table public.seat_requests alter column player_id drop not null;
alter table public.seat_requests add column if not exists guest_number integer check (guest_number is null or guest_number > 0);
alter table public.seat_requests drop constraint if exists seat_requests_member_or_guest;
alter table public.seat_requests add constraint seat_requests_member_or_guest
  check ((player_id is null) <> (guest_number is null));
create unique index if not exists seat_requests_guest_number on public.seat_requests (game_night_id, guest_number)
  where guest_number is not null;

-- Guests' real names: private schema, no API access of any kind.
create table if not exists private.seat_guests (
  seat_request_id uuid primary key references public.seat_requests (id) on delete cascade,
  game_night_id   uuid not null references public.game_nights (id) on delete cascade,
  real_name       text not null check (char_length(btrim(real_name)) between 1 and 60),
  created_at      timestamptz not null default now()
);
create unique index if not exists seat_guests_one_name_per_game
  on private.seat_guests (game_night_id, lower(btrim(real_name)));
revoke all on table private.seat_guests from public, anon, authenticated;

-- Announcement (one row).
create table if not exists public.club_announcement (
  id         integer primary key default 1 check (id = 1),
  body       text check (body is null or char_length(body) <= 280),
  updated_at timestamptz not null default now()
);
alter table public.club_announcement enable row level security;
revoke all on table public.club_announcement from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Helpers
-- -----------------------------------------------------------------------------

-- "A*****": first character of the username, upper-cased, then exactly five
-- asterisks, whatever the name's length.
create or replace function private.mask_name(p text)
returns text
language sql
immutable
set search_path = ''
as $$ select upper(left(btrim(coalesce(p, '?')), 1)) || '*****'; $$;
revoke all on function private.mask_name(text) from public, anon, authenticated;

create or replace function private.confirmed_count(p_night uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$ select count(*)::integer from public.seat_requests where game_night_id = p_night and status = 'confirmed'; $$;
revoke all on function private.confirmed_count(uuid) from public, anon, authenticated;

-- Fill free seats from the waitlist, oldest first, only when the game allows
-- it (or when forced by the host). Returns how many moved up.
create or replace function private.promote_waitlist(p_night uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  g public.game_nights;
  v_free integer;
  v_id uuid;
  n integer := 0;
begin
  select * into g from public.game_nights where id = p_night for update;
  if not found or not g.auto_fill_waitlist or g.status in ('cancelled', 'completed') or g.starts_at <= now() then
    return 0;
  end if;
  v_free := g.seats - private.confirmed_count(p_night);
  while v_free > 0 loop
    select id into v_id from public.seat_requests
     where game_night_id = p_night and status = 'waitlisted'
     order by queued_at limit 1;
    exit when v_id is null;
    update public.seat_requests set status = 'confirmed', decided_at = now() where id = v_id;
    perform private.seat_email(v_id, 'promoted');
    v_free := v_free - 1;
    n := n + 1;
    v_id := null;
  end loop;
  return n;
end;
$$;
revoke all on function private.promote_waitlist(uuid) from public, anon, authenticated;

-- Live game finalized => game completed.
create or replace function private.live_games_complete_night()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.finalized_at is not null and old.finalized_at is null then
    update public.game_nights set status = 'completed' where id = new.game_night_id and status <> 'cancelled';
  end if;
  return new;
end;
$$;
revoke all on function private.live_games_complete_night() from public, anon, authenticated;
drop trigger if exists live_games_complete_night on public.live_games;
create trigger live_games_complete_night after update of finalized_at on public.live_games
  for each row execute function private.live_games_complete_night();

-- Guest names are deleted 12 months after the game (the "Guest N" seat stays).
create or replace function private.purge_old_guest_names()
returns void
language sql
security definer
set search_path = ''
as $$
  delete from private.seat_guests sg
   using public.game_nights g
   where g.id = sg.game_night_id and g.starts_at < now() - interval '12 months';
$$;
revoke all on function private.purge_old_guest_names() from public, anon, authenticated;

-- The scheduled job (every 10 minutes) already calls this; it now also runs
-- the guest-name retention clean-up.
create or replace function private.enqueue_game_reminders()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
begin
  for r in
    select s.player_id, g.id as night,
           ((private.toronto_date(g.starts_at) - 1)::timestamp + time '10:00') at time zone 'America/Toronto' as due
      from public.game_nights g
      join public.seat_requests s on s.game_night_id = g.id and s.status = 'confirmed' and s.player_id is not null
     where g.status in ('open', 'closed')
       and g.starts_at > now() + interval '2 hours'
       and g.starts_at < now() + interval '3 days'
  loop
    if r.due <= now() then
      perform private.enqueue_game_email(r.player_id, 'game_reminder', r.night, 'reminder',
                                         'game_reminder:' || r.night || ':' || r.player_id);
    end if;
  end loop;
  perform private.purge_old_guest_names();
end;
$$;
revoke all on function private.enqueue_game_reminders() from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Member functions
-- -----------------------------------------------------------------------------

drop function if exists public.list_game_nights();
create or replace function public.list_game_nights()
returns table (game_night_id uuid, starts_at timestamptz, game_type text, stakes text, seats integer,
               notes text, status text, confirmed_count integer, waitlist_count integer,
               my_status text, my_waitlist_position integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  return query
    select g.id, g.starts_at, g.game_type, g.stakes, g.seats, g.notes, g.status,
           private.confirmed_count(g.id),
           (select count(*)::integer from public.seat_requests s where s.game_night_id = g.id and s.status = 'waitlisted'),
           m.status,
           case when m.status = 'waitlisted' then
             (select count(*)::integer from public.seat_requests s
               where s.game_night_id = g.id and s.status = 'waitlisted' and s.queued_at <= m.queued_at)
           end
      from public.game_nights g
      left join public.seat_requests m on m.game_night_id = g.id and m.player_id = auth.uid()
     where g.starts_at > now() - interval '12 hours'
     order by g.starts_at
     limit 50;
end;
$$;

-- One game night, with the confirmed list masked for privacy.
create or replace function public.get_game_night(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  g public.game_nights;
  m public.seat_requests;
  v jsonb;
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  select * into g from public.game_nights where id = p_id;
  if not found then raise exception 'game_night_not_found'; end if;
  select * into m from public.seat_requests where game_night_id = p_id and player_id = auth.uid();

  v := jsonb_build_object(
    'id', g.id, 'starts_at', g.starts_at, 'game_type', g.game_type, 'stakes', g.stakes,
    'seats', g.seats, 'notes', g.notes, 'status', g.status,
    'confirmed_count', private.confirmed_count(g.id),
    'waitlist_count', (select count(*) from public.seat_requests s where s.game_night_id = g.id and s.status = 'waitlisted'),
    'my_status', m.status,
    'my_note', m.note,
    'my_waitlist_position', case when m.status = 'waitlisted' then
       (select count(*) from public.seat_requests s
         where s.game_night_id = g.id and s.status = 'waitlisted' and s.queued_at <= m.queued_at) end,
    'address_date', private.toronto_date(g.starts_at),
    -- Confirmed seats. Labels only: never another member's username, never a guest's name.
    'attendees', coalesce((
      select jsonb_agg(jsonb_build_object(
               'label', case when s.guest_number is not null then 'Guest ' || s.guest_number
                             when s.player_id = auth.uid() then p.username
                             else private.mask_name(p.username) end,
               'is_me', s.player_id is not distinct from auth.uid() and s.player_id is not null,
               'is_guest', s.guest_number is not null)
             order by coalesce(s.decided_at, s.queued_at), s.created_at)
        from public.seat_requests s left join public.profiles p on p.id = s.player_id
       where s.game_night_id = g.id and s.status = 'confirmed'), '[]'::jsonb));
  if private.can_see_address(p_id) then
    v := v || (select jsonb_build_object('address', a.address, 'arrival_note', a.arrival_note)
                 from private.game_night_venue a where a.game_night_id = p_id);
  end if;
  return v;
end;
$$;

-- Ask for a seat. Open seat => "requested" (the host confirms). Full table =>
-- straight onto the waitlist. The game row is locked so counts can't race.
create or replace function public.request_seat(p_id uuid, p_note text default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  g public.game_nights;
  m public.seat_requests;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_status text;
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if private.is_host() then raise exception 'host_cannot_request_seat'; end if;
  if not exists (select 1 from public.profiles where id = auth.uid()) then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if v_note is not null and char_length(v_note) > 200 then raise exception 'note_too_long'; end if;
  perform private.ensure_wellbeing(auth.uid());
  if private.on_break(auth.uid()) then raise exception 'on_a_break'; end if;
  if private.loss_limit_reached(auth.uid()) then raise exception 'loss_limit_reached'; end if;

  select * into g from public.game_nights where id = p_id for update;
  if not found then raise exception 'game_night_not_found'; end if;
  if g.status <> 'open' or g.starts_at <= now() then raise exception 'requests_closed'; end if;
  v_status := case when private.confirmed_count(p_id) >= g.seats then 'waitlisted' else 'requested' end;

  select * into m from public.seat_requests where game_night_id = p_id and player_id = auth.uid() for update;
  if found then
    if m.status = 'declined' then raise exception 'request_declined'; end if;
    if m.status <> 'cancelled' then raise exception 'already_requested'; end if;
    update public.seat_requests
       set status = v_status, note = v_note, queued_at = now(), decided_at = null
     where id = m.id;
  else
    insert into public.seat_requests (game_night_id, player_id, note, status)
    values (p_id, auth.uid(), v_note, v_status);
  end if;
  return v_status;
end;
$$;

-- -----------------------------------------------------------------------------
-- Host functions (host + MFA)
-- -----------------------------------------------------------------------------

drop function if exists public.host_list_game_nights(boolean);
create or replace function public.host_list_game_nights(p_include_past boolean default false)
returns table (game_night_id uuid, starts_at timestamptz, stakes text, seats integer, status text,
               requested_count integer, confirmed_count integer, waitlist_count integer, guest_count integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform private.assert_host();
  return query
    select g.id, g.starts_at, g.stakes, g.seats, g.status,
           count(*) filter (where s.status = 'requested')::integer,
           count(*) filter (where s.status = 'confirmed')::integer,
           count(*) filter (where s.status = 'waitlisted')::integer,
           count(*) filter (where s.guest_number is not null and s.status in ('requested', 'confirmed', 'waitlisted'))::integer
      from public.game_nights g
      left join public.seat_requests s on s.game_night_id = g.id
     where p_include_past or g.starts_at > now() - interval '12 hours'
     group by g.id
     order by case when g.starts_at > now() - interval '12 hours' then 0 else 1 end,
              case when g.starts_at > now() - interval '12 hours' then g.starts_at end asc,
              g.starts_at desc
     limit 100;
end;
$$;

create or replace function public.host_get_game_night(p_id uuid)
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
           'id', g.id, 'starts_at', g.starts_at,
           'starts_local', to_char(g.starts_at at time zone 'America/Toronto', 'YYYY-MM-DD"T"HH24:MI'),
           'game_type', g.game_type, 'stakes', g.stakes, 'seats', g.seats, 'notes', g.notes,
           'status', g.status, 'auto_fill_waitlist', g.auto_fill_waitlist,
           'address', a.address, 'arrival_note', a.arrival_note,
           'requests', coalesce((
             select jsonb_agg(jsonb_build_object(
                      'id', s.id, 'player_id', s.player_id, 'username', p.username,
                      'guest_number', s.guest_number, 'guest_name', sg.real_name,
                      'status', s.status, 'note', s.note, 'queued_at', s.queued_at, 'decided_at', s.decided_at)
                    order by case s.status when 'confirmed' then 0 when 'requested' then 1 when 'waitlisted' then 2
                                           when 'declined' then 3 else 4 end, s.queued_at)
               from public.seat_requests s
               left join public.profiles p on p.id = s.player_id
               left join private.seat_guests sg on sg.seat_request_id = s.id
              where s.game_night_id = g.id), '[]'::jsonb))
    into v
    from public.game_nights g
    left join private.game_night_venue a on a.game_night_id = g.id
   where g.id = p_id;
  if v is null then raise exception 'game_night_not_found'; end if;
  return v;
end;
$$;

-- Create (no id) or update a game night. Adds auto_fill_waitlist (boolean).
create or replace function public.host_save_game_night(p_game_night jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id      uuid := nullif(p_game_night ->> 'id', '')::uuid;
  v_new     boolean := v_id is null;
  v_starts  timestamptz;
  v_status  text := coalesce(nullif(p_game_night ->> 'status', ''), 'open');
  v_auto    boolean := coalesce((p_game_night ->> 'auto_fill_waitlist')::boolean, false);
  old       public.game_nights;
  r         record;
begin
  perform private.assert_host();
  if jsonb_typeof(p_game_night) <> 'object' then raise exception 'invalid_payload'; end if;
  if v_status not in ('open', 'closed') then raise exception 'invalid_payload'; end if;
  if coalesce(p_game_night ->> 'starts_local', '') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$' then raise exception 'invalid_start'; end if;
  v_starts := (p_game_night ->> 'starts_local')::timestamp at time zone 'America/Toronto';
  if coalesce(btrim(p_game_night ->> 'address'), '') = '' then raise exception 'address_required'; end if;

  if v_new then
    if v_starts <= now() then raise exception 'start_in_past'; end if;
    if v_starts > now() + interval '1 year' then raise exception 'invalid_start'; end if;
    insert into public.game_nights (starts_at, game_type, stakes, seats, notes, status, auto_fill_waitlist)
    values (v_starts,
            coalesce(nullif(btrim(p_game_night ->> 'game_type'), ''), 'No-Limit Texas Hold''em'),
            btrim(p_game_night ->> 'stakes'), (p_game_night ->> 'seats')::integer,
            nullif(btrim(p_game_night ->> 'notes'), ''), v_status, v_auto)
    returning id into v_id;
  else
    select * into old from public.game_nights where id = v_id for update;
    if not found then raise exception 'game_night_not_found'; end if;
    if old.status = 'cancelled' then raise exception 'game_night_cancelled'; end if;
    if old.status = 'completed' then raise exception 'game_night_completed'; end if;
    if (p_game_night ->> 'seats')::integer < private.confirmed_count(v_id) then
      raise exception 'seats_below_confirmed';
    end if;
    update public.game_nights
       set starts_at = v_starts,
           game_type = coalesce(nullif(btrim(p_game_night ->> 'game_type'), ''), 'No-Limit Texas Hold''em'),
           stakes    = btrim(p_game_night ->> 'stakes'),
           seats     = (p_game_night ->> 'seats')::integer,
           notes     = nullif(btrim(p_game_night ->> 'notes'), ''),
           status    = v_status,
           auto_fill_waitlist = v_auto
     where id = v_id;
  end if;

  insert into private.game_night_venue (game_night_id, address, arrival_note)
  values (v_id, btrim(p_game_night ->> 'address'), nullif(btrim(p_game_night ->> 'arrival_note'), ''))
  on conflict (game_night_id) do update set address = excluded.address, arrival_note = excluded.arrival_note;

  if v_new then
    if coalesce((p_game_night ->> 'announce')::boolean, false) and v_status = 'open' then
      for r in select pr.id from public.profiles pr
                where not exists (select 1 from private.host_account h where h.user_id = pr.id) loop
        perform private.enqueue_game_email(r.id, 'game_announcement', v_id, 'new', 'game_announcement:' || v_id || ':' || r.id);
      end loop;
    end if;
  else
    if old.starts_at is distinct from v_starts then
      for r in select id from public.seat_requests
                where game_night_id = v_id and status in ('requested', 'confirmed', 'waitlisted') and player_id is not null loop
        perform private.seat_email(r.id, 'changed');
      end loop;
      delete from private.notification_outbox
       where kind = 'game_reminder' and ref_id = v_id and status = 'pending';
      update private.notification_outbox set dedupe_key = dedupe_key || ':old:' || id
       where kind = 'game_reminder' and ref_id = v_id;
    end if;
    perform private.promote_waitlist(v_id);
  end if;
  return v_id;
end;
$$;

-- Add someone to a game: a member (p_player_id) or a guest (p_guest_name).
-- p_status: requested | confirmed | waitlisted. Returns the seat id.
create or replace function public.host_add_seat(p_game_night_id uuid, p_player_id uuid, p_guest_name text, p_status text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  g public.game_nights;
  m public.seat_requests;
  v_name text := nullif(btrim(coalesce(p_guest_name, '')), '');
  v_id uuid;
  v_num integer;
begin
  perform private.assert_host();
  if p_status not in ('requested', 'confirmed', 'waitlisted') then raise exception 'invalid_payload'; end if;
  if (p_player_id is null) = (v_name is null) then raise exception 'invalid_payload'; end if;
  if v_name is not null and char_length(v_name) > 60 then raise exception 'guest_name_too_long'; end if;

  select * into g from public.game_nights where id = p_game_night_id for update;
  if not found then raise exception 'game_night_not_found'; end if;
  if g.status in ('cancelled', 'completed') then raise exception 'game_night_closed_for_changes'; end if;
  if p_status = 'confirmed' and private.confirmed_count(g.id) >= g.seats then raise exception 'game_full'; end if;

  if p_player_id is not null then
    if exists (select 1 from private.host_account h where h.user_id = p_player_id) then raise exception 'host_cannot_be_player'; end if;
    if not exists (select 1 from public.profiles where id = p_player_id) then raise exception 'player_not_found'; end if;
    select * into m from public.seat_requests where game_night_id = g.id and player_id = p_player_id for update;
    if found then
      if m.status in ('requested', 'confirmed', 'waitlisted') then raise exception 'already_in_game'; end if;
      update public.seat_requests
         set status = p_status, queued_at = now(), decided_at = case when p_status = 'requested' then null else now() end
       where id = m.id
      returning id into v_id;
    else
      insert into public.seat_requests (game_night_id, player_id, status, decided_at)
      values (g.id, p_player_id, p_status, case when p_status = 'requested' then null else now() end)
      returning id into v_id;
    end if;
    if p_status <> 'requested' then perform private.seat_email(v_id, p_status); end if;
  else
    if exists (select 1 from private.seat_guests where game_night_id = g.id and lower(btrim(real_name)) = lower(v_name)) then
      raise exception 'guest_already_added';
    end if;
    update public.game_nights set guest_seq = guest_seq + 1 where id = g.id returning guest_seq into v_num;
    insert into public.seat_requests (game_night_id, guest_number, status, decided_at)
    values (g.id, v_num, p_status, now())
    returning id into v_id;
    insert into private.seat_guests (seat_request_id, game_night_id, real_name) values (v_id, g.id, v_name);
  end if;
  return v_id;
end;
$$;

create or replace function public.host_rename_guest(p_seat_id uuid, p_guest_name text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text := nullif(btrim(coalesce(p_guest_name, '')), '');
begin
  perform private.assert_host();
  if v_name is null or char_length(v_name) > 60 then raise exception 'guest_name_required'; end if;
  update private.seat_guests set real_name = v_name where seat_request_id = p_seat_id;
  if not found then raise exception 'request_not_found'; end if;
exception when unique_violation then
  raise exception 'guest_already_added';
end;
$$;

-- Remove someone from a game entirely (member or guest).
create or replace function public.host_remove_seat(p_seat_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  m public.seat_requests;
begin
  perform private.assert_host();
  select * into m from public.seat_requests where id = p_seat_id for update;
  if not found then raise exception 'request_not_found'; end if;
  perform 1 from public.game_nights where id = m.game_night_id for update;
  delete from public.seat_requests where id = p_seat_id;
  if m.status = 'confirmed' then perform private.promote_waitlist(m.game_night_id); end if;
end;
$$;

-- Change a seat's status: requested | confirmed | waitlisted | declined
create or replace function public.host_decide_seat(p_request_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  m public.seat_requests;
  g public.game_nights;
begin
  perform private.assert_host();
  if p_status not in ('requested', 'confirmed', 'waitlisted', 'declined') then raise exception 'invalid_payload'; end if;
  select * into m from public.seat_requests where id = p_request_id;
  if not found then raise exception 'request_not_found'; end if;
  select * into g from public.game_nights where id = m.game_night_id for update;
  select * into m from public.seat_requests where id = p_request_id for update;
  if g.status in ('cancelled', 'completed') then raise exception 'game_night_closed_for_changes'; end if;
  if m.status = 'cancelled' then raise exception 'request_cancelled'; end if;
  if m.status = p_status then return; end if;
  if p_status = 'confirmed' and private.confirmed_count(g.id) >= g.seats then raise exception 'game_full'; end if;
  update public.seat_requests
     set status = p_status, decided_at = now(),
         queued_at = case when p_status = 'waitlisted' then now() else queued_at end
   where id = m.id;
  if m.player_id is not null and p_status <> 'requested' then perform private.seat_email(m.id, p_status); end if;
  if m.status = 'confirmed' then perform private.promote_waitlist(g.id); end if;
end;
$$;

-- Move someone up or down the waitlist by swapping places with a neighbour.
create or replace function public.host_move_waitlist(p_seat_id uuid, p_direction text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  m public.seat_requests;
  other public.seat_requests;
begin
  perform private.assert_host();
  if p_direction not in ('up', 'down') then raise exception 'invalid_payload'; end if;
  select * into m from public.seat_requests where id = p_seat_id;
  if not found or m.status <> 'waitlisted' then raise exception 'not_on_waitlist'; end if;
  perform 1 from public.game_nights where id = m.game_night_id for update;
  if p_direction = 'up' then
    select * into other from public.seat_requests
     where game_night_id = m.game_night_id and status = 'waitlisted' and (queued_at, id) < (m.queued_at, m.id)
     order by queued_at desc, id desc limit 1;
  else
    select * into other from public.seat_requests
     where game_night_id = m.game_night_id and status = 'waitlisted' and (queued_at, id) > (m.queued_at, m.id)
     order by queued_at, id limit 1;
  end if;
  if other.id is null then return; end if;
  update public.seat_requests set queued_at = other.queued_at where id = m.id;
  update public.seat_requests set queued_at = m.queued_at where id = other.id;
end;
$$;

create or replace function public.host_complete_game_night(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.assert_host();
  update public.game_nights set status = 'completed' where id = p_id and status in ('open', 'closed');
  if not found then raise exception 'game_night_closed_for_changes'; end if;
end;
$$;

-- Live mode now also brings in confirmed guests (labelled with their real
-- name, which only the host sees).
create or replace function public.host_live_start(p_game_night_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  g public.game_nights;
begin
  perform private.assert_host();
  select * into g from public.game_nights where id = p_game_night_id;
  if not found then raise exception 'game_night_not_found'; end if;
  if g.status = 'cancelled' then raise exception 'game_night_cancelled'; end if;
  insert into public.live_games (game_night_id) values (p_game_night_id) on conflict do nothing;
  if (select finalized_at from public.live_games where game_night_id = p_game_night_id) is not null then return; end if;
  insert into public.live_players (game_night_id, player_id)
  select p_game_night_id, s.player_id
    from public.seat_requests s
   where s.game_night_id = p_game_night_id and s.status = 'confirmed' and s.player_id is not null
     and not exists (select 1 from public.live_players l where l.game_night_id = p_game_night_id and l.player_id = s.player_id);
  insert into public.live_players (game_night_id, guest_label)
  select p_game_night_id, left(btrim(coalesce(sg.real_name, 'Guest ' || s.guest_number)), 40)
    from public.seat_requests s left join private.seat_guests sg on sg.seat_request_id = s.id
   where s.game_night_id = p_game_night_id and s.status = 'confirmed' and s.guest_number is not null
  on conflict do nothing;
end;
$$;

-- -----------------------------------------------------------------------------
-- Announcement
-- -----------------------------------------------------------------------------

create or replace function public.get_announcement()
returns text
language sql
stable
security definer
set search_path = ''
as $$ select body from public.club_announcement where id = 1 and auth.uid() is not null; $$;

create or replace function public.host_set_announcement(p_body text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.assert_host();
  if p_body is not null and char_length(btrim(p_body)) > 280 then raise exception 'announcement_too_long'; end if;
  insert into public.club_announcement (id, body, updated_at) values (1, nullif(btrim(p_body), ''), now())
  on conflict (id) do update set body = excluded.body, updated_at = now();
end;
$$;

-- -----------------------------------------------------------------------------
-- Privileges
-- -----------------------------------------------------------------------------

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.list_game_nights()', 'public.get_game_night(uuid)', 'public.request_seat(uuid, text)',
    'public.host_list_game_nights(boolean)', 'public.host_get_game_night(uuid)',
    'public.host_save_game_night(jsonb)', 'public.host_add_seat(uuid, uuid, text, text)',
    'public.host_rename_guest(uuid, text)', 'public.host_remove_seat(uuid)',
    'public.host_decide_seat(uuid, text)', 'public.host_move_waitlist(uuid, text)',
    'public.host_complete_game_night(uuid)', 'public.host_live_start(uuid)',
    'public.get_announcement()', 'public.host_set_announcement(text)']
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;
