-- =============================================================================
-- Game nights and seat booking
--
-- - The host opens a game night (date, time, stakes, seats). Members ask for a
--   seat; the host confirms, waitlists or declines with one tap.
-- - When a confirmed player cancels (or the host adds seats), the longest-
--   waiting player on the waitlist is confirmed automatically.
-- - Members see only seat COUNTS, never who else is coming.
-- - The address is stored separately and shown only to the host and to
--   players with a confirmed seat, and only on the day of the game
--   (Toronto time). It is never put in an email.
-- - Emails (each controlled by the member's preferences): new game night,
--   seat confirmed / waitlisted / declined / promoted, game changed or
--   cancelled, and a reminder the day before.
--
-- Everything goes through the functions below; the tables have no direct
-- API access at all.
-- =============================================================================

create or replace function private.toronto_date(p timestamptz)
returns date
language sql
immutable
set search_path = ''
as $$ select (p at time zone 'America/Toronto')::date; $$;
revoke all on function private.toronto_date(timestamptz) from public, anon, authenticated;

create table if not exists public.game_nights (
  id         uuid primary key default gen_random_uuid(),
  starts_at  timestamptz not null,
  game_type  text not null default 'No-Limit Texas Hold''em' check (char_length(btrim(game_type)) between 1 and 60),
  stakes     text not null check (char_length(btrim(stakes)) between 1 and 40),
  seats      integer not null check (seats between 2 and 12),
  notes      text check (notes is null or char_length(notes) <= 500),
  -- open: taking requests; closed: no new requests; cancelled: called off
  status     text not null default 'open' check (status in ('open', 'closed', 'cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists game_nights_starts_idx on public.game_nights (starts_at desc);
drop trigger if exists game_nights_touch on public.game_nights;
create trigger game_nights_touch before update on public.game_nights
  for each row execute function private.touch_updated_at();
alter table public.game_nights enable row level security;
revoke all on table public.game_nights from public, anon, authenticated;

-- The address lives in the private schema: no API access, ever.
create table if not exists private.game_night_venue (
  game_night_id uuid primary key references public.game_nights (id) on delete cascade,
  address       text not null check (char_length(btrim(address)) between 1 and 200),
  arrival_note  text check (arrival_note is null or char_length(arrival_note) <= 300)
);
revoke all on table private.game_night_venue from public, anon, authenticated;

create table if not exists public.seat_requests (
  id            uuid primary key default gen_random_uuid(),
  game_night_id uuid not null references public.game_nights (id) on delete cascade,
  player_id     uuid not null references public.profiles (id) on delete cascade,
  status        text not null default 'requested'
                check (status in ('requested', 'confirmed', 'waitlisted', 'declined', 'cancelled')),
  note          text check (note is null or char_length(note) <= 200),
  -- When the player (re)joined the queue; waitlist order.
  queued_at     timestamptz not null default now(),
  decided_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (game_night_id, player_id)
);
create index if not exists seat_requests_night_idx on public.seat_requests (game_night_id, status, queued_at);
drop trigger if exists seat_requests_touch on public.seat_requests;
create trigger seat_requests_touch before update on public.seat_requests
  for each row execute function private.touch_updated_at();
alter table public.seat_requests enable row level security;
revoke all on table public.seat_requests from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Outbox: game emails carry a small payload (the event), and are re-checked
-- against the game and seat at send time.
-- -----------------------------------------------------------------------------

alter table private.notification_outbox
  add column if not exists payload jsonb not null default '{}'::jsonb;

create or replace function private.enqueue_game_email(
  p_player uuid, p_kind text, p_night uuid, p_event text, p_dedupe text, p_send_after timestamptz default now())
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_player is null or not private.wants_email(p_player, p_kind) then return; end if;
  insert into private.notification_outbox (player_id, kind, ref_id, dedupe_key, send_after, payload)
  values (p_player, p_kind, p_night, p_dedupe, p_send_after, jsonb_build_object('event', p_event))
  on conflict (dedupe_key) do nothing;
end;
$$;
revoke all on function private.enqueue_game_email(uuid, text, uuid, text, text, timestamptz) from public, anon, authenticated;

create or replace function private.seat_email(p_request uuid, p_event text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.seat_requests;
begin
  select * into r from public.seat_requests where id = p_request;
  if not found then return; end if;
  perform private.enqueue_game_email(
    r.player_id, 'seat_update', r.game_night_id, p_event,
    'seat_update:' || r.id || ':' || p_event || ':' || floor(extract(epoch from clock_timestamp()) * 1000)::bigint);
end;
$$;
revoke all on function private.seat_email(uuid, text) from public, anon, authenticated;

-- Fill free seats from the waitlist, oldest first. Returns how many moved up.
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
  if not found or g.status = 'cancelled' or g.starts_at <= now() then return 0; end if;
  v_free := g.seats - (select count(*) from public.seat_requests where game_night_id = p_night and status = 'confirmed');
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

-- Is the address visible to the current user for this game?
create or replace function private.can_see_address(p_night uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_host_mfa()
      or exists (
           select 1
             from public.game_nights g
             join public.seat_requests s on s.game_night_id = g.id
            where g.id = p_night
              and g.status <> 'cancelled'
              and s.player_id = auth.uid()
              and s.status = 'confirmed'
              and private.toronto_date(now()) >= private.toronto_date(g.starts_at)
              and now() < g.starts_at + interval '12 hours');
$$;
revoke all on function private.can_see_address(uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Member functions
-- -----------------------------------------------------------------------------

-- Upcoming (and just-started) game nights with counts and my own status.
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
           (select count(*)::integer from public.seat_requests s where s.game_night_id = g.id and s.status = 'confirmed'),
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

-- One game night; includes the address only when the caller may see it.
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
    'confirmed_count', (select count(*) from public.seat_requests s where s.game_night_id = g.id and s.status = 'confirmed'),
    'waitlist_count', (select count(*) from public.seat_requests s where s.game_night_id = g.id and s.status = 'waitlisted'),
    'my_status', m.status,
    'my_note', m.note,
    'my_waitlist_position', case when m.status = 'waitlisted' then
       (select count(*) from public.seat_requests s
         where s.game_night_id = g.id and s.status = 'waitlisted' and s.queued_at <= m.queued_at) end,
    'address_date', private.toronto_date(g.starts_at));
  if private.can_see_address(p_id) then
    v := v || (select jsonb_build_object('address', a.address, 'arrival_note', a.arrival_note)
                 from private.game_night_venue a where a.game_night_id = p_id);
  end if;
  return v;
end;
$$;

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
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if private.is_host() then raise exception 'host_cannot_request_seat'; end if;
  if not exists (select 1 from public.profiles where id = auth.uid()) then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if v_note is not null and char_length(v_note) > 200 then raise exception 'note_too_long'; end if;

  select * into g from public.game_nights where id = p_id;
  if not found then raise exception 'game_night_not_found'; end if;
  if g.status <> 'open' or g.starts_at <= now() then raise exception 'requests_closed'; end if;

  select * into m from public.seat_requests where game_night_id = p_id and player_id = auth.uid() for update;
  if found then
    if m.status = 'declined' then raise exception 'request_declined'; end if;
    if m.status <> 'cancelled' then raise exception 'already_requested'; end if;
    update public.seat_requests
       set status = 'requested', note = v_note, queued_at = now(), decided_at = null
     where id = m.id;
  else
    insert into public.seat_requests (game_night_id, player_id, note) values (p_id, auth.uid(), v_note);
  end if;
  return 'requested';
end;
$$;

create or replace function public.cancel_my_seat(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  m public.seat_requests;
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  select * into m from public.seat_requests where game_night_id = p_id and player_id = auth.uid() for update;
  if not found or m.status not in ('requested', 'confirmed', 'waitlisted') then raise exception 'no_active_request'; end if;
  if (select starts_at from public.game_nights where id = p_id) <= now() then raise exception 'game_started'; end if;
  update public.seat_requests set status = 'cancelled', decided_at = now() where id = m.id;
  if m.status = 'confirmed' then perform private.promote_waitlist(p_id); end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- Host functions (host + MFA)
-- -----------------------------------------------------------------------------

create or replace function public.host_list_game_nights(p_include_past boolean default false)
returns table (game_night_id uuid, starts_at timestamptz, stakes text, seats integer, status text,
               requested_count integer, confirmed_count integer, waitlist_count integer)
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
           count(*) filter (where s.status = 'waitlisted')::integer
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
           'status', g.status, 'address', a.address, 'arrival_note', a.arrival_note,
           'requests', coalesce((
             select jsonb_agg(jsonb_build_object(
                      'id', s.id, 'player_id', s.player_id, 'username', p.username, 'status', s.status,
                      'note', s.note, 'queued_at', s.queued_at, 'decided_at', s.decided_at)
                    order by case s.status when 'confirmed' then 0 when 'requested' then 1 when 'waitlisted' then 2
                                           when 'declined' then 3 else 4 end, s.queued_at)
               from public.seat_requests s join public.profiles p on p.id = s.player_id
              where s.game_night_id = g.id), '[]'::jsonb))
    into v
    from public.game_nights g
    left join private.game_night_venue a on a.game_night_id = g.id
   where g.id = p_id;
  if v is null then raise exception 'game_night_not_found'; end if;
  return v;
end;
$$;

-- The address used for the most recent game night (to pre-fill the form).
create or replace function public.host_last_venue()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.assert_host();
  return (select jsonb_build_object('address', a.address, 'arrival_note', a.arrival_note)
            from private.game_night_venue a join public.game_nights g on g.id = a.game_night_id
           order by g.created_at desc limit 1);
end;
$$;

-- Create (no id) or update a game night.
-- p_game_night: { id?, starts_local: 'YYYY-MM-DDTHH:MM' (Toronto time), game_type?, stakes, seats,
--      notes?, address, arrival_note?, status?: 'open'|'closed', announce?: bool }
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
    insert into public.game_nights (starts_at, game_type, stakes, seats, notes, status)
    values (v_starts,
            coalesce(nullif(btrim(p_game_night ->> 'game_type'), ''), 'No-Limit Texas Hold''em'),
            btrim(p_game_night ->> 'stakes'), (p_game_night ->> 'seats')::integer,
            nullif(btrim(p_game_night ->> 'notes'), ''), v_status)
    returning id into v_id;
  else
    select * into old from public.game_nights where id = v_id for update;
    if not found then raise exception 'game_night_not_found'; end if;
    if old.status = 'cancelled' then raise exception 'game_night_cancelled'; end if;
    if (p_game_night ->> 'seats')::integer < (select count(*) from public.seat_requests where game_night_id = v_id and status = 'confirmed') then
      raise exception 'seats_below_confirmed';
    end if;
    update public.game_nights
       set starts_at = v_starts,
           game_type = coalesce(nullif(btrim(p_game_night ->> 'game_type'), ''), 'No-Limit Texas Hold''em'),
           stakes    = btrim(p_game_night ->> 'stakes'),
           seats     = (p_game_night ->> 'seats')::integer,
           notes     = nullif(btrim(p_game_night ->> 'notes'), ''),
           status    = v_status
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
    -- Time changed: tell everyone with an active request.
    if old.starts_at is distinct from v_starts then
      for r in select id from public.seat_requests
                where game_night_id = v_id and status in ('requested', 'confirmed', 'waitlisted') loop
        perform private.seat_email(r.id, 'changed');
      end loop;
      -- Reminders follow the new date.
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

-- One-tap decision on a request: confirmed | waitlisted | declined
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
  if p_status not in ('confirmed', 'waitlisted', 'declined') then raise exception 'invalid_payload'; end if;
  select * into m from public.seat_requests where id = p_request_id for update;
  if not found then raise exception 'request_not_found'; end if;
  select * into g from public.game_nights where id = m.game_night_id for update;
  if g.status = 'cancelled' then raise exception 'game_night_cancelled'; end if;
  if m.status = 'cancelled' then raise exception 'request_cancelled'; end if;
  if m.status = p_status then return; end if;
  if p_status = 'confirmed' and
     (select count(*) from public.seat_requests where game_night_id = g.id and status = 'confirmed') >= g.seats then
    raise exception 'game_full';
  end if;
  update public.seat_requests
     set status = p_status, decided_at = now(),
         -- Joining the waitlist puts you at the back of it.
         queued_at = case when p_status = 'waitlisted' then now() else queued_at end
   where id = m.id;
  perform private.seat_email(m.id, p_status);
  if m.status = 'confirmed' then perform private.promote_waitlist(g.id); end if;
end;
$$;

create or replace function public.host_cancel_game_night(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
begin
  perform private.assert_host();
  update public.game_nights set status = 'cancelled' where id = p_id and status <> 'cancelled';
  if not found then raise exception 'game_night_not_found'; end if;
  for r in select id from public.seat_requests
            where game_night_id = p_id and status in ('requested', 'confirmed', 'waitlisted') loop
    perform private.seat_email(r.id, 'cancelled');
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- Day-before reminders: queued by the scheduled job, for confirmed seats.
-- Sent from 10:00 Toronto time the day before (or right away if booked later).
-- -----------------------------------------------------------------------------

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
      join public.seat_requests s on s.game_night_id = g.id and s.status = 'confirmed'
     where g.status <> 'cancelled'
       and g.starts_at > now() + interval '2 hours'
       and g.starts_at < now() + interval '3 days'
  loop
    if r.due <= now() then
      perform private.enqueue_game_email(r.player_id, 'game_reminder', r.night, 'reminder',
                                         'game_reminder:' || r.night || ':' || r.player_id);
    end if;
  end loop;
end;
$$;
revoke all on function private.enqueue_game_reminders() from public, anon, authenticated;

-- Send-time checks now cover game emails too.
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
       and case o.kind
             when 'results_ready' then
               p.tracking_enabled
               and exists (select 1 from public.session_results r
                            where r.session_id = o.ref_id and r.player_id = o.player_id)
             when 'game_announcement' then
               exists (select 1 from public.game_nights g
                        where g.id = o.ref_id and g.status = 'open' and g.starts_at > now())
             when 'game_reminder' then
               exists (select 1 from public.game_nights g
                         join public.seat_requests s on s.game_night_id = g.id
                        where g.id = o.ref_id and g.status <> 'cancelled' and g.starts_at > now()
                          and s.player_id = o.player_id and s.status = 'confirmed')
             when 'seat_update' then
               exists (select 1 from public.game_nights g where g.id = o.ref_id and g.starts_at > now())
             else false
           end);
$$;
revoke all on function private.notification_still_wanted(uuid) from public, anon, authenticated;

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

  perform private.enqueue_game_reminders();

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
           case
             when o.kind = 'results_ready' then (
               select jsonb_build_object('played_on', s.played_on, 'title', s.title, 'stakes', s.stakes)
                 from public.game_sessions s where s.id = o.ref_id)
             else o.payload || coalesce((
               select jsonb_build_object(
                        'game_night_id', g.id,
                        'starts_local', to_char(g.starts_at at time zone 'America/Toronto', 'YYYY-MM-DD"T"HH24:MI'),
                        'stakes', g.stakes, 'game_type', g.game_type)
                 from public.game_nights g where g.id = o.ref_id), '{}'::jsonb)
           end
      from private.notification_outbox o
      join public.profiles p on p.id = o.player_id
      join auth.users u on u.id = o.player_id
      join public.notification_preferences n on n.player_id = o.player_id
     where o.id = any (v_ids) and o.status = 'pending'
     order by o.send_after;
end;
$$;

-- -----------------------------------------------------------------------------
-- Privileges
-- -----------------------------------------------------------------------------

revoke all on function public.list_game_nights() from public, anon, authenticated;
revoke all on function public.get_game_night(uuid) from public, anon, authenticated;
revoke all on function public.request_seat(uuid, text) from public, anon, authenticated;
revoke all on function public.cancel_my_seat(uuid) from public, anon, authenticated;
revoke all on function public.host_list_game_nights(boolean) from public, anon, authenticated;
revoke all on function public.host_get_game_night(uuid) from public, anon, authenticated;
revoke all on function public.host_last_venue() from public, anon, authenticated;
revoke all on function public.host_save_game_night(jsonb) from public, anon, authenticated;
revoke all on function public.host_decide_seat(uuid, text) from public, anon, authenticated;
revoke all on function public.host_cancel_game_night(uuid) from public, anon, authenticated;
revoke all on function public.claim_notifications(text, integer) from public, anon, authenticated;

grant execute on function public.list_game_nights() to authenticated;
grant execute on function public.get_game_night(uuid) to authenticated;
grant execute on function public.request_seat(uuid, text) to authenticated;
grant execute on function public.cancel_my_seat(uuid) to authenticated;
grant execute on function public.host_list_game_nights(boolean) to authenticated;
grant execute on function public.host_get_game_night(uuid) to authenticated;
grant execute on function public.host_last_venue() to authenticated;
grant execute on function public.host_save_game_night(jsonb) to authenticated;
grant execute on function public.host_decide_seat(uuid, text) to authenticated;
grant execute on function public.host_cancel_game_night(uuid) to authenticated;
grant execute on function public.claim_notifications(text, integer) to anon;
