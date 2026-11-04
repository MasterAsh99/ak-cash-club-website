-- =============================================================================
-- Host-only expense tracker
--
-- Records what the host spends on hosting (food, non-alcoholic drinks, cards,
-- equipment...), optionally linked to a game. Only the host, with an MFA
-- (aal2) session, can read or change it. Every change is audited.
-- This tracks spending only; it has no concept of player fees or rake.
-- =============================================================================

create table if not exists public.host_expenses (
  id           uuid primary key default gen_random_uuid(),
  -- optional link to a game; kept (as a general expense) if the game is deleted
  session_id   uuid references public.game_sessions (id) on delete set null,
  spent_on     date not null check (spent_on between date '2020-01-01' and date '2100-01-01'),
  category     text not null check (category in ('food', 'drinks', 'cards', 'equipment', 'supplies', 'other')),
  description  text not null check (char_length(btrim(description)) between 2 and 200),
  amount_cents bigint not null check (amount_cents > 0 and amount_cents <= 100000000),
  created_by   uuid not null references auth.users (id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists host_expenses_spent_on_idx on public.host_expenses (spent_on desc);
create index if not exists host_expenses_session_idx on public.host_expenses (session_id);

drop trigger if exists host_expenses_touch on public.host_expenses;
create trigger host_expenses_touch before update on public.host_expenses
  for each row execute function private.touch_updated_at();

drop trigger if exists audit_host_expenses on public.host_expenses;
create trigger audit_host_expenses after insert or update or delete on public.host_expenses
  for each row execute function private.write_audit();

alter table public.host_expenses enable row level security;
revoke all on table public.host_expenses from public, anon, authenticated;
grant select on public.host_expenses to authenticated;

drop policy if exists host_expenses_select on public.host_expenses;
create policy host_expenses_select on public.host_expenses
  for select to authenticated using (private.is_host_mfa());

-- -----------------------------------------------------------------------------
-- Host functions
-- -----------------------------------------------------------------------------

-- Create (no id) or update (with id) one expense.
-- p_expense = { "id": uuid|null, "session_id": uuid|null, "spent_on": "YYYY-MM-DD",
--               "category": text, "description": text, "amount_cents": int }
create or replace function public.host_save_expense(p_expense jsonb, p_reason text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id      uuid := nullif(p_expense ->> 'id', '')::uuid;
  v_session uuid := nullif(p_expense ->> 'session_id', '')::uuid;
begin
  perform private.assert_host();
  if jsonb_typeof(p_expense) <> 'object' then raise exception 'invalid_payload'; end if;

  if v_session is not null and not exists (select 1 from public.game_sessions s where s.id = v_session) then
    raise exception 'session_not_found';
  end if;

  if v_id is null then
    perform set_config('app.audit_reason', 'Expense added', true);
    insert into public.host_expenses (session_id, spent_on, category, description, amount_cents, created_by)
    values (
      v_session,
      (p_expense ->> 'spent_on')::date,
      p_expense ->> 'category',
      btrim(p_expense ->> 'description'),
      (p_expense ->> 'amount_cents')::bigint,
      auth.uid()
    )
    returning id into v_id;
  else
    if coalesce(btrim(p_reason), '') = '' then raise exception 'edit_reason_required'; end if;
    perform set_config('app.audit_reason', btrim(p_reason), true);
    update public.host_expenses
       set session_id   = v_session,
           spent_on     = (p_expense ->> 'spent_on')::date,
           category     = p_expense ->> 'category',
           description  = btrim(p_expense ->> 'description'),
           amount_cents = (p_expense ->> 'amount_cents')::bigint
     where id = v_id;
    if not found then raise exception 'expense_not_found'; end if;
  end if;
  return v_id;
end;
$$;

create or replace function public.host_delete_expense(p_expense_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.assert_host();
  if coalesce(btrim(p_reason), '') = '' then raise exception 'edit_reason_required'; end if;
  perform set_config('app.audit_reason', btrim(p_reason), true);
  delete from public.host_expenses where id = p_expense_id;
  if not found then raise exception 'expense_not_found'; end if;
end;
$$;

-- Expenses (newest first), optionally filtered by date range or game.
create or replace function public.host_list_expenses(
  p_from date default null,
  p_to date default null,
  p_session_id uuid default null,
  p_limit integer default 500
)
returns table (expense_id uuid, spent_on date, category text, description text, amount_cents bigint,
               session_id uuid, session_played_on date, session_title text, session_stakes text)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform private.assert_host();
  return query
    select e.id, e.spent_on, e.category, e.description, e.amount_cents,
           e.session_id, s.played_on, s.title, s.stakes
      from public.host_expenses e
      left join public.game_sessions s on s.id = e.session_id
     where (p_from is null or e.spent_on >= p_from)
       and (p_to is null or e.spent_on <= p_to)
       and (p_session_id is null or e.session_id = p_session_id)
     order by e.spent_on desc, e.created_at desc
     limit least(greatest(coalesce(p_limit, 500), 1), 2000);
end;
$$;

revoke all on function public.host_save_expense(jsonb, text) from public, anon, authenticated;
revoke all on function public.host_delete_expense(uuid, text) from public, anon, authenticated;
revoke all on function public.host_list_expenses(date, date, uuid, integer) from public, anon, authenticated;
grant execute on function public.host_save_expense(jsonb, text) to authenticated;
grant execute on function public.host_delete_expense(uuid, text) to authenticated;
grant execute on function public.host_list_expenses(date, date, uuid, integer) to authenticated;
