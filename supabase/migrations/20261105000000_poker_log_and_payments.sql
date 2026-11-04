-- =============================================================================
-- 1. My Poker Log: each member's private record of games OUTSIDE AK Cash Club.
--    Visible only to its owner (not to the host or anyone else through the
--    API). AK Cash Club games are tracked separately by the host.
--
-- 2. Payment tracking on session results (host only): how each player paid
--    their buy-ins, how they were paid out, and whether the payout is done.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. My Poker Log
-- -----------------------------------------------------------------------------

create table if not exists public.player_poker_log (
  id               uuid primary key default gen_random_uuid(),
  player_id        uuid not null references public.profiles (id) on delete cascade,
  played_on        date not null check (played_on between date '2000-01-01' and date '2100-01-01'),
  venue            text not null check (char_length(btrim(venue)) between 1 and 80),
  game             text not null default 'No-Limit Texas Hold''em' check (char_length(btrim(game)) between 1 and 60),
  format           text not null check (format in ('cash', 'tournament', 'other')),
  stakes           text check (stakes is null or char_length(stakes) <= 40),
  buy_in_cents     bigint not null check (buy_in_cents between 0 and 100000000),
  cash_out_cents   bigint not null check (cash_out_cents between 0 and 1000000000),
  net_cents        bigint generated always as (cash_out_cents - buy_in_cents) stored,
  duration_minutes integer check (duration_minutes is null or duration_minutes between 1 and 4320),
  notes            text check (notes is null or char_length(notes) <= 500),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists player_poker_log_player_idx on public.player_poker_log (player_id, played_on desc);

drop trigger if exists player_poker_log_touch on public.player_poker_log;
create trigger player_poker_log_touch before update on public.player_poker_log
  for each row execute function private.touch_updated_at();

alter table public.player_poker_log enable row level security;
revoke all on table public.player_poker_log from public, anon, authenticated;
grant select on public.player_poker_log to authenticated;

-- Owner only. Deliberately no host clause: this is the member's private log.
drop policy if exists player_poker_log_select on public.player_poker_log;
create policy player_poker_log_select on public.player_poker_log
  for select to authenticated using (player_id = auth.uid());

-- AK Cash Club games must not be entered here; they're tracked by the host.
create or replace function private.mentions_ak_cash_club(p text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select private.username_skeleton(p) like '%akcash%'
      or private.username_skeleton(p) like '%akclub%';
$$;
revoke all on function private.mentions_ak_cash_club(text) from public, anon, authenticated;

create or replace function public.my_log_list()
returns table (entry_id uuid, played_on date, venue text, game text, format text, stakes text,
               buy_in_cents bigint, cash_out_cents bigint, net_cents bigint,
               duration_minutes integer, notes text)
language sql
stable
security definer
set search_path = ''
as $$
  select l.id, l.played_on, l.venue, l.game, l.format, l.stakes,
         l.buy_in_cents, l.cash_out_cents, l.net_cents, l.duration_minutes, l.notes
    from public.player_poker_log l
   where l.player_id = auth.uid()
   order by l.played_on desc, l.created_at desc
   limit 5000;
$$;

-- Create (no id) or update (own entry) one log entry.
create or replace function public.my_log_save(p_entry jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid := nullif(p_entry ->> 'id', '')::uuid;
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if jsonb_typeof(p_entry) <> 'object' then raise exception 'invalid_payload'; end if;
  if private.mentions_ak_cash_club(coalesce(p_entry ->> 'venue', ''))
     or private.mentions_ak_cash_club(coalesce(p_entry ->> 'game', '')) then
    raise exception 'ak_games_tracked_separately';
  end if;

  if v_id is null then
    if (select count(*) from public.player_poker_log where player_id = auth.uid()) >= 5000 then
      raise exception 'log_full';
    end if;
    insert into public.player_poker_log
      (player_id, played_on, venue, game, format, stakes, buy_in_cents, cash_out_cents, duration_minutes, notes)
    values (
      auth.uid(),
      (p_entry ->> 'played_on')::date,
      btrim(p_entry ->> 'venue'),
      coalesce(nullif(btrim(p_entry ->> 'game'), ''), 'No-Limit Texas Hold''em'),
      p_entry ->> 'format',
      nullif(btrim(p_entry ->> 'stakes'), ''),
      (p_entry ->> 'buy_in_cents')::bigint,
      (p_entry ->> 'cash_out_cents')::bigint,
      nullif(p_entry ->> 'duration_minutes', '')::integer,
      nullif(btrim(p_entry ->> 'notes'), '')
    )
    returning id into v_id;
  else
    update public.player_poker_log
       set played_on        = (p_entry ->> 'played_on')::date,
           venue            = btrim(p_entry ->> 'venue'),
           game             = coalesce(nullif(btrim(p_entry ->> 'game'), ''), 'No-Limit Texas Hold''em'),
           format           = p_entry ->> 'format',
           stakes           = nullif(btrim(p_entry ->> 'stakes'), ''),
           buy_in_cents     = (p_entry ->> 'buy_in_cents')::bigint,
           cash_out_cents   = (p_entry ->> 'cash_out_cents')::bigint,
           duration_minutes = nullif(p_entry ->> 'duration_minutes', '')::integer,
           notes            = nullif(btrim(p_entry ->> 'notes'), '')
     where id = v_id and player_id = auth.uid();
    if not found then raise exception 'log_entry_not_found'; end if;
  end if;
  return v_id;
end;
$$;

create or replace function public.my_log_delete(p_entry_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  delete from public.player_poker_log where id = p_entry_id and player_id = auth.uid();
  if not found then raise exception 'log_entry_not_found'; end if;
end;
$$;

revoke all on function public.my_log_list() from public, anon, authenticated;
revoke all on function public.my_log_save(jsonb) from public, anon, authenticated;
revoke all on function public.my_log_delete(uuid) from public, anon, authenticated;
grant execute on function public.my_log_list() to authenticated;
grant execute on function public.my_log_save(jsonb) to authenticated;
grant execute on function public.my_log_delete(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- 2. Payment tracking (host only)
-- -----------------------------------------------------------------------------

alter table public.session_results
  add column if not exists buy_in_method text
    check (buy_in_method is null or buy_in_method in ('cash', 'etransfer', 'mixed')),
  add column if not exists payout_method text
    check (payout_method is null or payout_method in ('cash', 'etransfer', 'mixed')),
  add column if not exists payout_paid boolean not null default false,
  add column if not exists payout_paid_at timestamptz;

alter table public.session_results drop constraint if exists session_results_paid_has_time;
alter table public.session_results add constraint session_results_paid_has_time
  check (payout_paid = (payout_paid_at is not null));

-- Payment details are the host's records; players' direct reads must not
-- include them. Replace the table-wide SELECT with a column list.
revoke select on public.session_results from authenticated;
grant select (id, session_id, player_id, guest_label, initial_buy_in_cents, add_on_cents,
              cash_out_cents, total_buy_in_cents, net_cents, created_at, updated_at)
  on public.session_results to authenticated;

-- Update payment details for some rows of one session.
-- p_rows = [ { "result_id": uuid, "buy_in_method": "cash"|"etransfer"|"mixed"|null,
--              "payout_method": ...|null, "payout_paid": bool } ]
create or replace function public.host_update_payments(p_session_id uuid, p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row jsonb;
  v_id  uuid;
  v_paid boolean;
  n integer := 0;
begin
  perform private.assert_host();
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 60 then raise exception 'invalid_payload'; end if;
  perform set_config('app.audit_reason', 'Payment details updated', true);

  for v_row in select * from jsonb_array_elements(p_rows) loop
    v_id := nullif(v_row ->> 'result_id', '')::uuid;
    v_paid := coalesce((v_row ->> 'payout_paid')::boolean, false);
    update public.session_results r
       set buy_in_method  = nullif(v_row ->> 'buy_in_method', ''),
           payout_method  = nullif(v_row ->> 'payout_method', ''),
           payout_paid    = v_paid,
           payout_paid_at = case
                              when v_paid and r.payout_paid then r.payout_paid_at
                              when v_paid then now()
                              else null
                            end
     where r.id = v_id and r.session_id = p_session_id;
    if not found then raise exception 'result_not_found'; end if;
    n := n + 1;
  end loop;
  return n;
end;
$$;

revoke all on function public.host_update_payments(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.host_update_payments(uuid, jsonb) to authenticated;

-- host_get_session: include payment details.
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
               'net_cents', r.net_cents,
               'buy_in_method', r.buy_in_method, 'payout_method', r.payout_method,
               'payout_paid', r.payout_paid, 'payout_paid_at', r.payout_paid_at)
             order by lower(coalesce(p.username, r.guest_label)))
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

-- host_list_sessions: add payouts still to be made (rows with a cash-out not yet ticked).
drop function if exists public.host_list_sessions(integer, integer);
create function public.host_list_sessions(p_limit integer default 50, p_offset integer default 0)
returns table (session_id uuid, played_on date, game_type text, stakes text, title text,
               player_count bigint, total_buy_in_cents bigint, total_cash_out_cents bigint,
               total_net_cents bigint, adjustments_cents bigint, unexplained_cents bigint,
               updated_at timestamptz, payouts_outstanding bigint)
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
           coalesce(a.adj, 0), coalesce(r.net, 0) + coalesce(a.adj, 0), s.updated_at,
           coalesce(r.unpaid, 0)
      from public.game_sessions s
      left join lateral (
        select count(*) n, sum(total_buy_in_cents)::bigint buy, sum(cash_out_cents)::bigint cash,
               sum(net_cents)::bigint net,
               count(*) filter (where x.cash_out_cents > 0 and not x.payout_paid) unpaid
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
revoke all on function public.host_list_sessions(integer, integer) from public, anon, authenticated;
grant execute on function public.host_list_sessions(integer, integer) to authenticated;
