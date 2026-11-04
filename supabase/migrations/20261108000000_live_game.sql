-- =============================================================================
-- Live game-night mode (host only)
--
-- During a game the host checks players in, records each buy-in / rebuy with
-- how it was paid (cash or e-Transfer), and records cash-outs. At the end,
-- "Finalize" turns it into a normal recorded session (the same audited
-- host_save_session as manual entry) with payment details filled in.
--
-- Members who have tracking ON are linked to their account. Everyone else is
-- recorded as a guest row (labelled with their username, visible only to the
-- host), exactly like a manually entered guest, so nothing is linked to an
-- account without consent.
--
-- Money is integer cents throughout. No direct API access to these tables.
-- =============================================================================

create table if not exists public.live_games (
  game_night_id        uuid primary key references public.game_nights (id) on delete cascade,
  started_at           timestamptz not null default now(),
  finalized_at         timestamptz,
  finalized_session_id uuid references public.game_sessions (id) on delete set null
);

create table if not exists public.live_players (
  id             uuid primary key default gen_random_uuid(),
  game_night_id  uuid not null references public.live_games (game_night_id) on delete cascade,
  player_id      uuid references public.profiles (id) on delete set null,
  guest_label    text check (guest_label is null or char_length(btrim(guest_label)) between 1 and 40),
  checked_in_at  timestamptz,
  cash_out_cents bigint check (cash_out_cents is null or cash_out_cents between 0 and 1000000000),
  payout_method  text check (payout_method is null or payout_method in ('cash', 'etransfer')),
  created_at     timestamptz not null default now(),
  constraint live_players_who check (player_id is not null or guest_label is not null),
  constraint live_players_cash_out_method check ((cash_out_cents is null) = (payout_method is null))
);
create unique index if not exists live_players_one_per_member on public.live_players (game_night_id, player_id) where player_id is not null;
create unique index if not exists live_players_one_per_guest on public.live_players (game_night_id, lower(btrim(guest_label))) where player_id is null;

create table if not exists public.live_buyins (
  id             uuid primary key default gen_random_uuid(),
  live_player_id uuid not null references public.live_players (id) on delete cascade,
  amount_cents   bigint not null check (amount_cents between 1 and 100000000),
  method         text not null check (method in ('cash', 'etransfer')),
  created_at     timestamptz not null default clock_timestamp()
);
create index if not exists live_buyins_player_idx on public.live_buyins (live_player_id, created_at);

alter table public.live_games enable row level security;
alter table public.live_players enable row level security;
alter table public.live_buyins enable row level security;
revoke all on table public.live_games, public.live_players, public.live_buyins from public, anon, authenticated;

-- The live game a player row belongs to, locked, and still editable.
create or replace function private.live_assert_open(p_game_night_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  lg public.live_games;
begin
  select * into lg from public.live_games where game_night_id = p_game_night_id for update;
  if not found then raise exception 'live_game_not_started'; end if;
  if lg.finalized_at is not null then raise exception 'live_game_finalized'; end if;
end;
$$;
revoke all on function private.live_assert_open(uuid) from public, anon, authenticated;

create or replace function private.live_night_of(p_live_player_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$ select game_night_id from public.live_players where id = p_live_player_id; $$;
revoke all on function private.live_night_of(uuid) from public, anon, authenticated;

-- Start (or reopen) live mode. Confirmed seats are added, not yet checked in.
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
  insert into public.live_players (game_night_id, player_id)
  select p_game_night_id, s.player_id
    from public.seat_requests s
   where s.game_night_id = p_game_night_id and s.status = 'confirmed'
     and not exists (select 1 from public.live_players l where l.game_night_id = p_game_night_id and l.player_id = s.player_id)
     and (select finalized_at from public.live_games where game_night_id = p_game_night_id) is null;
end;
$$;

create or replace function public.host_live_get(p_game_night_id uuid)
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
           'game_night_id', lg.game_night_id, 'started_at', lg.started_at,
           'finalized_at', lg.finalized_at, 'finalized_session_id', lg.finalized_session_id,
           'starts_at', g.starts_at, 'stakes', g.stakes, 'game_type', g.game_type,
           'players', coalesce((
             select jsonb_agg(jsonb_build_object(
                      'id', l.id, 'player_id', l.player_id, 'username', p.username,
                      'tracking_enabled', coalesce(p.tracking_enabled, false),
                      'guest_label', l.guest_label, 'checked_in_at', l.checked_in_at,
                      'cash_out_cents', l.cash_out_cents, 'payout_method', l.payout_method,
                      'buyins', coalesce((
                        select jsonb_agg(jsonb_build_object('id', b.id, 'amount_cents', b.amount_cents,
                                                            'method', b.method, 'created_at', b.created_at)
                                         order by b.created_at)
                          from public.live_buyins b where b.live_player_id = l.id), '[]'::jsonb))
                    order by (l.checked_in_at is null), l.checked_in_at, l.created_at)
               from public.live_players l left join public.profiles p on p.id = l.player_id
              where l.game_night_id = lg.game_night_id), '[]'::jsonb))
    into v
    from public.live_games lg join public.game_nights g on g.id = lg.game_night_id
   where lg.game_night_id = p_game_night_id;
  return v;  -- null when live mode hasn't been started
end;
$$;

-- Add a member (by id) or a guest (by label) who wasn't on the seat list.
create or replace function public.host_live_add_player(p_game_night_id uuid, p_player_id uuid default null, p_guest_label text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_label text := nullif(btrim(coalesce(p_guest_label, '')), '');
begin
  perform private.assert_host();
  perform private.live_assert_open(p_game_night_id);
  if (p_player_id is null) = (v_label is null) then raise exception 'invalid_payload'; end if;
  if p_player_id is not null then
    if exists (select 1 from private.host_account h where h.user_id = p_player_id) then raise exception 'host_cannot_be_player'; end if;
    if not exists (select 1 from public.profiles where id = p_player_id) then raise exception 'player_not_found'; end if;
  end if;
  if (select count(*) from public.live_players where game_night_id = p_game_night_id) >= 40 then raise exception 'too_many_players'; end if;
  insert into public.live_players (game_night_id, player_id, guest_label, checked_in_at)
  values (p_game_night_id, p_player_id, v_label, now())
  returning id into v_id;
  return v_id;
exception when unique_violation then
  raise exception 'already_in_game';
end;
$$;

create or replace function public.host_live_remove_player(p_live_player_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.assert_host();
  perform private.live_assert_open(private.live_night_of(p_live_player_id));
  if exists (select 1 from public.live_buyins where live_player_id = p_live_player_id) then
    raise exception 'player_has_buyins';
  end if;
  delete from public.live_players where id = p_live_player_id;
end;
$$;

create or replace function public.host_live_check_in(p_live_player_id uuid, p_checked_in boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.assert_host();
  perform private.live_assert_open(private.live_night_of(p_live_player_id));
  if not p_checked_in and exists (select 1 from public.live_buyins where live_player_id = p_live_player_id) then
    raise exception 'player_has_buyins';
  end if;
  update public.live_players
     set checked_in_at = case when p_checked_in then coalesce(checked_in_at, now()) end
   where id = p_live_player_id;
end;
$$;

-- Record a buy-in or rebuy (also checks the player in).
create or replace function public.host_live_buy_in(p_live_player_id uuid, p_amount_cents bigint, p_method text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform private.assert_host();
  perform private.live_assert_open(private.live_night_of(p_live_player_id));
  if p_method not in ('cash', 'etransfer') then raise exception 'invalid_payload'; end if;
  if (select cash_out_cents from public.live_players where id = p_live_player_id) is not null then
    raise exception 'player_cashed_out';
  end if;
  insert into public.live_buyins (live_player_id, amount_cents, method)
  values (p_live_player_id, p_amount_cents, p_method)
  returning id into v_id;
  update public.live_players set checked_in_at = coalesce(checked_in_at, now()) where id = p_live_player_id;
  return v_id;
end;
$$;

create or replace function public.host_live_undo_buy_in(p_buyin_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_player uuid;
begin
  perform private.assert_host();
  select live_player_id into v_player from public.live_buyins where id = p_buyin_id;
  if v_player is null then raise exception 'buyin_not_found'; end if;
  perform private.live_assert_open(private.live_night_of(v_player));
  if (select cash_out_cents from public.live_players where id = v_player) is not null then
    raise exception 'player_cashed_out';
  end if;
  delete from public.live_buyins where id = p_buyin_id;
end;
$$;

-- Record (or clear, with null) a cash-out.
create or replace function public.host_live_cash_out(p_live_player_id uuid, p_amount_cents bigint, p_method text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.assert_host();
  perform private.live_assert_open(private.live_night_of(p_live_player_id));
  if p_amount_cents is not null then
    if p_method not in ('cash', 'etransfer') then raise exception 'invalid_payload'; end if;
    if not exists (select 1 from public.live_buyins where live_player_id = p_live_player_id) then
      raise exception 'no_buyins';
    end if;
  end if;
  update public.live_players
     set cash_out_cents = p_amount_cents,
         payout_method  = case when p_amount_cents is null then null else p_method end
   where id = p_live_player_id;
end;
$$;

-- Turn the live game into a recorded session. Everyone with a buy-in must be
-- cashed out. Returns the new session id.
create or replace function public.host_live_finalize(p_game_night_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  g public.game_nights;
  l record;
  v_results jsonb := '[]'::jsonb;
  v_session uuid;
  v_label text;
  v_labels text[] := '{}';
  v_n integer;
  v_pay jsonb := '[]'::jsonb;
  v_map jsonb := '[]'::jsonb;
  v_method text;
  m jsonb;
  v_rid uuid;
begin
  perform private.assert_host();
  perform private.live_assert_open(p_game_night_id);
  select * into g from public.game_nights where id = p_game_night_id;

  if exists (select 1 from public.live_players lp
              where lp.game_night_id = p_game_night_id and lp.cash_out_cents is null
                and exists (select 1 from public.live_buyins b where b.live_player_id = lp.id)) then
    raise exception 'players_not_cashed_out';
  end if;

  for l in
    select lp.*, p.username, coalesce(p.tracking_enabled, false) as tracking,
           (select array_agg(b.amount_cents order by b.created_at) from public.live_buyins b where b.live_player_id = lp.id) as amounts
      from public.live_players lp left join public.profiles p on p.id = lp.player_id
     where lp.game_night_id = p_game_night_id
       and exists (select 1 from public.live_buyins b where b.live_player_id = lp.id)
     order by lp.checked_in_at, lp.created_at
  loop
    select case when count(distinct b.method) > 1 then 'mixed' else min(b.method) end
      into v_method from public.live_buyins b where b.live_player_id = l.id;
    if l.player_id is not null and l.tracking then
      v_map := v_map || jsonb_build_array(jsonb_build_object(
        'player_id', l.player_id, 'buy_in_method', v_method, 'payout_method', l.payout_method));
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'player_id', l.player_id,
        'initial_buy_in_cents', l.amounts[1],
        'add_on_cents', to_jsonb(coalesce(l.amounts[2:], '{}'::bigint[])),
        'cash_out_cents', l.cash_out_cents));
    else
      -- Not linked to any account: a guest row, labelled for the host only.
      v_label := left(coalesce(l.guest_label, l.username, 'Guest'), 40);
      v_n := 2;
      while lower(v_label) = any (v_labels) loop
        v_label := left(coalesce(l.guest_label, l.username, 'Guest'), 36) || ' (' || v_n || ')';
        v_n := v_n + 1;
      end loop;
      v_labels := v_labels || lower(v_label);
      v_map := v_map || jsonb_build_array(jsonb_build_object(
        'guest_label', v_label, 'buy_in_method', v_method, 'payout_method', l.payout_method));
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'guest_label', v_label,
        'initial_buy_in_cents', l.amounts[1],
        'add_on_cents', to_jsonb(coalesce(l.amounts[2:], '{}'::bigint[])),
        'cash_out_cents', l.cash_out_cents));
    end if;
  end loop;

  if jsonb_array_length(v_results) = 0 then raise exception 'no_buyins'; end if;

  v_session := public.host_save_session(jsonb_build_object(
    'played_on', private.toronto_date(g.starts_at),
    'game_type', g.game_type,
    'stakes', g.stakes,
    'title', null,
    'results', v_results,
    'adjustments', '[]'::jsonb), 'Recorded from live game mode');

  -- Payment details: how each player paid in and how they were paid out.
  for m in select * from jsonb_array_elements(v_map) loop
    select sr.id into v_rid from public.session_results sr
     where sr.session_id = v_session
       and case when m ? 'player_id' then sr.player_id = (m ->> 'player_id')::uuid
                else sr.player_id is null and lower(sr.guest_label) = lower(m ->> 'guest_label') end;
    v_pay := v_pay || jsonb_build_array(jsonb_build_object(
      'result_id', v_rid, 'buy_in_method', m ->> 'buy_in_method',
      'payout_method', m ->> 'payout_method', 'payout_paid', false));
  end loop;
  perform public.host_update_payments(v_session, v_pay);

  update public.live_games set finalized_at = now(), finalized_session_id = v_session
   where game_night_id = p_game_night_id;
  return v_session;
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.host_live_start(uuid)', 'public.host_live_get(uuid)',
    'public.host_live_add_player(uuid, uuid, text)', 'public.host_live_remove_player(uuid)',
    'public.host_live_check_in(uuid, boolean)', 'public.host_live_buy_in(uuid, bigint, text)',
    'public.host_live_undo_buy_in(uuid)', 'public.host_live_cash_out(uuid, bigint, text)',
    'public.host_live_finalize(uuid)']
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;
