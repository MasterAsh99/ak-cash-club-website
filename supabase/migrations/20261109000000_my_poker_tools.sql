-- =============================================================================
-- Member tools
--
-- 1. Hand notes: a private journal of hands (cards, board, position, notes).
--    Owner-only, like My Poker Log.
-- 2. Responsible play (all set by the member, all private to them):
--    - Monthly loss limit across AK Cash Club results and My Poker Log.
--      Reaching it pauses seat requests until next month. Lowering a limit
--      takes effect immediately; raising or removing it takes 24 hours.
--    - Long-session reminder: an email after N hours at an AK Cash Club game
--      (from when the host checks you in), unless you've cashed out.
--    - Take a break (1, 7, 30 or 90 days): pauses seat requests and new-game
--      emails, and withdraws pending requests. A break can't be ended early.
--    The host is not shown any of these settings.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Hand notes
-- -----------------------------------------------------------------------------

create or replace function private.cards_ok(p_hole text[], p_board text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(array_length(p_hole, 1), 0) in (0, 2)
     and coalesce(array_length(p_board, 1), 0) in (0, 3, 4, 5)
     and not exists (select 1 from unnest(coalesce(p_hole, '{}') || coalesce(p_board, '{}')) c
                      where c !~ '^[2-9TJQKA][shdc]$')
     and (select count(*) = count(distinct c)
            from unnest(coalesce(p_hole, '{}') || coalesce(p_board, '{}')) c);
$$;
revoke all on function private.cards_ok(text[], text[]) from public, anon, authenticated;

create table if not exists public.player_hand_notes (
  id         uuid primary key default gen_random_uuid(),
  player_id  uuid not null references public.profiles (id) on delete cascade,
  played_on  date not null check (played_on between date '2000-01-01' and date '2100-01-01'),
  title      text not null check (char_length(btrim(title)) between 1 and 80),
  stakes     text check (stakes is null or char_length(stakes) <= 40),
  position   text check (position is null or position in ('UTG', 'UTG+1', 'UTG+2', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB')),
  hole_cards text[] not null default '{}',
  board      text[] not null default '{}',
  notes      text check (notes is null or char_length(notes) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint player_hand_notes_cards check (private.cards_ok(hole_cards, board))
);
create index if not exists player_hand_notes_player_idx on public.player_hand_notes (player_id, played_on desc);
drop trigger if exists player_hand_notes_touch on public.player_hand_notes;
create trigger player_hand_notes_touch before update on public.player_hand_notes
  for each row execute function private.touch_updated_at();
alter table public.player_hand_notes enable row level security;
revoke all on table public.player_hand_notes from public, anon, authenticated;

create or replace function public.my_hands_list()
returns table (hand_id uuid, played_on date, title text, stakes text, "position" text,
               hole_cards text[], board text[], notes text)
language sql
stable
security definer
set search_path = ''
as $$
  select h.id, h.played_on, h.title, h.stakes, h.position, h.hole_cards, h.board, h.notes
    from public.player_hand_notes h
   where h.player_id = auth.uid()
   order by h.played_on desc, h.created_at desc
   limit 2000;
$$;

create or replace function public.my_hand_save(p_hand jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id    uuid := nullif(p_hand ->> 'id', '')::uuid;
  v_hole  text[];
  v_board text[];
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if jsonb_typeof(p_hand) <> 'object'
     or jsonb_typeof(coalesce(p_hand -> 'hole_cards', '[]')) <> 'array'
     or jsonb_typeof(coalesce(p_hand -> 'board', '[]')) <> 'array' then
    raise exception 'invalid_payload';
  end if;
  select coalesce(array_agg(x), '{}') into v_hole from jsonb_array_elements_text(coalesce(p_hand -> 'hole_cards', '[]')) x;
  select coalesce(array_agg(x), '{}') into v_board from jsonb_array_elements_text(coalesce(p_hand -> 'board', '[]')) x;
  if not private.cards_ok(v_hole, v_board) then raise exception 'invalid_cards'; end if;

  if v_id is null then
    if (select count(*) from public.player_hand_notes where player_id = auth.uid()) >= 2000 then raise exception 'log_full'; end if;
    insert into public.player_hand_notes (player_id, played_on, title, stakes, position, hole_cards, board, notes)
    values (auth.uid(), (p_hand ->> 'played_on')::date, btrim(p_hand ->> 'title'),
            nullif(btrim(p_hand ->> 'stakes'), ''), nullif(p_hand ->> 'position', ''),
            v_hole, v_board, nullif(btrim(p_hand ->> 'notes'), ''))
    returning id into v_id;
  else
    update public.player_hand_notes
       set played_on = (p_hand ->> 'played_on')::date, title = btrim(p_hand ->> 'title'),
           stakes = nullif(btrim(p_hand ->> 'stakes'), ''), position = nullif(p_hand ->> 'position', ''),
           hole_cards = v_hole, board = v_board, notes = nullif(btrim(p_hand ->> 'notes'), '')
     where id = v_id and player_id = auth.uid();
    if not found then raise exception 'hand_not_found'; end if;
  end if;
  return v_id;
end;
$$;

create or replace function public.my_hand_delete(p_hand_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  delete from public.player_hand_notes where id = p_hand_id and player_id = auth.uid();
  if not found then raise exception 'hand_not_found'; end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- 2. Responsible play
-- -----------------------------------------------------------------------------

create table if not exists public.player_wellbeing (
  player_id               uuid primary key references public.profiles (id) on delete cascade,
  loss_limit_cents        bigint check (loss_limit_cents is null or loss_limit_cents between 100 and 100000000),
  -- A raise or removal waits 24 hours (pending_*). Lowering applies at once.
  pending_limit_cents     bigint check (pending_limit_cents is null or pending_limit_cents between 100 and 100000000),
  pending_limit_change    boolean not null default false,
  pending_effective_at    timestamptz,
  session_reminder_minutes integer check (session_reminder_minutes is null or session_reminder_minutes between 30 and 720),
  break_until             timestamptz,
  updated_at              timestamptz not null default now()
);
drop trigger if exists player_wellbeing_touch on public.player_wellbeing;
create trigger player_wellbeing_touch before update on public.player_wellbeing
  for each row execute function private.touch_updated_at();
alter table public.player_wellbeing enable row level security;
revoke all on table public.player_wellbeing from public, anon, authenticated;

create or replace function private.ensure_wellbeing(p_player uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.player_wellbeing (player_id)
  select p_player where exists (select 1 from public.profiles where id = p_player)
  on conflict (player_id) do nothing;
  -- Apply a pending raise/removal once its 24 hours have passed.
  update public.player_wellbeing
     set loss_limit_cents = pending_limit_cents, pending_limit_cents = null,
         pending_limit_change = false, pending_effective_at = null
   where player_id = p_player and pending_limit_change and pending_effective_at <= now();
end;
$$;
revoke all on function private.ensure_wellbeing(uuid) from public, anon, authenticated;

-- Net result this calendar month (Toronto time): tracked AK Cash Club results
-- plus My Poker Log. Negative = down for the month.
create or replace function private.month_net_cents(p_player uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  with m as (select date_trunc('month', private.toronto_date(now()))::date as first_day)
  select (coalesce((select sum(r.net_cents)
                     from public.session_results r
                     join public.game_sessions s on s.id = r.session_id
                     join public.profiles p on p.id = r.player_id and p.tracking_enabled
                    where r.player_id = p_player and s.played_on >= (select first_day from m)), 0)
       + coalesce((select sum(l.net_cents) from public.player_poker_log l
                    where l.player_id = p_player and l.played_on >= (select first_day from m)), 0))::bigint;
$$;
revoke all on function private.month_net_cents(uuid) from public, anon, authenticated;

create or replace function private.on_break(p_player uuid)
returns boolean
language sql
stable
set search_path = ''
as $$ select coalesce((select break_until > now() from public.player_wellbeing where player_id = p_player), false); $$;
revoke all on function private.on_break(uuid) from public, anon, authenticated;

create or replace function private.loss_limit_reached(p_player uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select w.loss_limit_cents is not null and -private.month_net_cents(p_player) >= w.loss_limit_cents
                     from public.player_wellbeing w where w.player_id = p_player), false);
$$;
revoke all on function private.loss_limit_reached(uuid) from public, anon, authenticated;

create or replace function public.get_my_wellbeing()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  w public.player_wellbeing;
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  perform private.ensure_wellbeing(auth.uid());
  select * into w from public.player_wellbeing where player_id = auth.uid();
  return jsonb_build_object(
    'loss_limit_cents', w.loss_limit_cents,
    'pending_limit_change', w.pending_limit_change,
    'pending_limit_cents', w.pending_limit_cents,
    'pending_effective_at', w.pending_effective_at,
    'month_net_cents', private.month_net_cents(auth.uid()),
    'limit_reached', private.loss_limit_reached(auth.uid()),
    'session_reminder_minutes', w.session_reminder_minutes,
    'break_until', case when w.break_until > now() then w.break_until end);
end;
$$;

-- p_cents null = remove the limit.
create or replace function public.set_my_loss_limit(p_cents bigint)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  w public.player_wellbeing;
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if p_cents is not null and (p_cents < 100 or p_cents > 100000000) then raise exception 'invalid_limit'; end if;
  perform private.ensure_wellbeing(auth.uid());
  select * into w from public.player_wellbeing where player_id = auth.uid() for update;
  if p_cents is not null and (w.loss_limit_cents is null or p_cents <= w.loss_limit_cents) then
    -- Stricter (or first) limit: immediately, and cancel any pending loosening.
    update public.player_wellbeing
       set loss_limit_cents = p_cents, pending_limit_cents = null, pending_limit_change = false, pending_effective_at = null
     where player_id = auth.uid();
    return 'applied';
  end if;
  if w.loss_limit_cents is null then return 'applied'; end if;  -- removing a limit that isn't set
  update public.player_wellbeing
     set pending_limit_cents = p_cents, pending_limit_change = true, pending_effective_at = now() + interval '24 hours'
   where player_id = auth.uid();
  return 'pending';
end;
$$;

-- p_minutes null = no reminder.
create or replace function public.set_my_session_reminder(p_minutes integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if p_minutes is not null and (p_minutes < 30 or p_minutes > 720) then raise exception 'invalid_reminder'; end if;
  perform private.ensure_wellbeing(auth.uid());
  update public.player_wellbeing set session_reminder_minutes = p_minutes where player_id = auth.uid();
end;
$$;

-- Start (or extend) a break. Pending seat requests and waitlist spots are
-- withdrawn; confirmed seats are left for the member to decide.
create or replace function public.take_a_break(p_days integer)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_until timestamptz;
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if p_days not in (1, 7, 30, 90) then raise exception 'invalid_break'; end if;
  perform private.ensure_wellbeing(auth.uid());
  update public.player_wellbeing
     set break_until = greatest(coalesce(break_until, now()), now() + make_interval(days => p_days))
   where player_id = auth.uid()
  returning break_until into v_until;
  update public.seat_requests s
     set status = 'cancelled', decided_at = now()
   where s.player_id = auth.uid() and s.status in ('requested', 'waitlisted')
     and exists (select 1 from public.game_nights g where g.id = s.game_night_id and g.starts_at > now());
  return v_until;
end;
$$;

-- Seat requests now respect a break and a reached loss limit.
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
  perform private.ensure_wellbeing(auth.uid());
  if private.on_break(auth.uid()) then raise exception 'on_a_break'; end if;
  if private.loss_limit_reached(auth.uid()) then raise exception 'loss_limit_reached'; end if;

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

-- -----------------------------------------------------------------------------
-- Long-session reminder emails
-- -----------------------------------------------------------------------------

alter table private.notification_outbox drop constraint if exists notification_outbox_kind_check;
alter table private.notification_outbox add constraint notification_outbox_kind_check
  check (kind in ('results_ready', 'game_announcement', 'seat_update', 'game_reminder', 'session_reminder'));

create or replace function private.wants_email(p_player uuid, p_kind text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select case
    when p_kind = 'session_reminder' then
      coalesce((select w.session_reminder_minutes is not null from public.player_wellbeing w where w.player_id = p_player), false)
    when p_kind = 'game_announcement' and private.on_break(p_player) then false
    else coalesce((
      select case p_kind
               when 'results_ready'     then n.results_ready
               when 'game_announcement' then n.game_announcements
               when 'seat_update'       then n.seat_updates
               when 'game_reminder'     then n.game_reminders
               else false
             end
        from public.notification_preferences n
       where n.player_id = p_player), false)
  end;
$$;
revoke all on function private.wants_email(uuid, text) from public, anon, authenticated;

create or replace function private.live_players_session_reminder()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_minutes integer;
begin
  if new.player_id is null or new.checked_in_at is null then return new; end if;
  if tg_op = 'UPDATE' and old.checked_in_at is not null then return new; end if;
  select session_reminder_minutes into v_minutes from public.player_wellbeing where player_id = new.player_id;
  if v_minutes is null then return new; end if;
  insert into private.notification_outbox (player_id, kind, ref_id, dedupe_key, send_after, payload)
  values (new.player_id, 'session_reminder', new.game_night_id, 'session_reminder:' || new.id,
          new.checked_in_at + make_interval(mins => v_minutes), jsonb_build_object('minutes', v_minutes))
  on conflict (dedupe_key) do nothing;
  return new;
end;
$$;
revoke all on function private.live_players_session_reminder() from public, anon, authenticated;

drop trigger if exists live_players_session_reminder on public.live_players;
create trigger live_players_session_reminder after insert or update of checked_in_at on public.live_players
  for each row execute function private.live_players_session_reminder();

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
             when 'session_reminder' then
               o.created_at > now() - interval '18 hours'
               and exists (select 1 from public.live_players lp
                             join public.live_games lg on lg.game_night_id = lp.game_night_id
                            where lp.game_night_id = o.ref_id and lp.player_id = o.player_id
                              and lp.checked_in_at is not null and lp.cash_out_cents is null
                              and lg.finalized_at is null)
             else false
           end);
$$;
revoke all on function private.notification_still_wanted(uuid) from public, anon, authenticated;

-- Unsubscribe links can also turn off the session reminder.
create or replace function public.unsubscribe_with_token(p_token text, p_kind text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_player uuid;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then return false; end if;
  if p_kind not in ('results_ready', 'game_announcements', 'seat_updates', 'game_reminders', 'session_reminders', 'all') then
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
   where n.unsubscribe_token = p_token
  returning n.player_id into v_player;
  if v_player is null then return false; end if;
  if p_kind in ('session_reminders', 'all') then
    update public.player_wellbeing set session_reminder_minutes = null where player_id = v_player;
  end if;
  return true;
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
    'public.my_hands_list()', 'public.my_hand_save(jsonb)', 'public.my_hand_delete(uuid)',
    'public.get_my_wellbeing()', 'public.set_my_loss_limit(bigint)', 'public.set_my_session_reminder(integer)',
    'public.take_a_break(integer)', 'public.request_seat(uuid, text)']
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;
revoke all on function public.unsubscribe_with_token(text, text) from public, anon, authenticated;
grant execute on function public.unsubscribe_with_token(text, text) to anon, authenticated;
