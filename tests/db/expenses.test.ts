/** Security tests for the host-only expense tracker. */
import { beforeAll, describe, expect, it } from 'vitest';
import { TestDb, errorOf, type Actor } from './harness';

let db: TestDb;
let hostId: string;
let playerId: string;
let sessionId: string;
const host = (aal: 'aal1' | 'aal2' = 'aal2'): Actor => ({ kind: 'user', id: hostId, aal });
const player = (aal: 'aal1' | 'aal2' = 'aal1'): Actor => ({ kind: 'user', id: playerId, aal });
const expense = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ spent_on: '2026-10-30', category: 'food', description: 'Pizza for Friday', amount_cents: 6450, ...extra });

beforeAll(async () => {
  db = await TestDb.create();
  hostId = await db.createUser('owner@example.com', 'owner1');
  await db.makeHost(hostId);
  playerId = await db.createUser('p@example.com', 'player1');
  const [s] = await db.as<{ id: string }>(
    host(),
    `select public.host_save_session($1::jsonb) as id`,
    [JSON.stringify({ played_on: '2026-10-30', stakes: '$1/$2', results: [{ guest_label: 'Guest 1', initial_buy_in_cents: 100, add_on_cents: [], cash_out_cents: 100 }], adjustments: [] })],
  );
  sessionId = s!.id;
}, 60_000);

describe('host expenses', () => {
  let expenseId: string;

  it('the host (with MFA) can add an expense linked to a game', async () => {
    const [r] = await db.as<{ id: string }>(host(), `select public.host_save_expense($1::jsonb) as id`, [expense({ session_id: sessionId })]);
    expenseId = r!.id;
    const rows = await db.as<{ amount_cents: string; session_title: string | null }>(host(), `select * from public.host_list_expenses()`);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.amount_cents)).toBe(6450);
  });

  it('players cannot read or change expenses, even with MFA or direct queries', async () => {
    for (const actor of [player(), player('aal2')]) {
      expect(await db.as(actor, 'select * from public.host_expenses')).toEqual([]);
      expect(await errorOf(db.as(actor, 'select * from public.host_list_expenses()'))).toMatch(/not_authorized/);
      expect(await errorOf(db.as(actor, `select public.host_save_expense($1::jsonb)`, [expense()]))).toMatch(/not_authorized/);
      expect(await errorOf(db.as(actor, `select public.host_delete_expense($1, 'x')`, [expenseId]))).toMatch(/not_authorized/);
      expect(await errorOf(db.as(actor, `insert into public.host_expenses (spent_on, category, description, amount_cents, created_by) values ('2026-01-01','food','x',1,'${playerId}')`))).toMatch(/permission denied/);
      expect(await errorOf(db.as(actor, `delete from public.host_expenses`))).toMatch(/permission denied/);
    }
  });

  it('anonymous visitors are refused', async () => {
    expect(await errorOf(db.as({ kind: 'anon' }, 'select * from public.host_list_expenses()'))).toMatch(/permission denied/);
    expect(await errorOf(db.as({ kind: 'anon' }, 'select * from public.host_expenses'))).toMatch(/permission denied/);
  });

  it('the host without MFA is refused', async () => {
    expect(await errorOf(db.as(host('aal1'), 'select * from public.host_list_expenses()'))).toMatch(/mfa_required/);
    expect(await db.as(host('aal1'), 'select * from public.host_expenses')).toEqual([]);
  });

  it.each([
    ['zero amount', { amount_cents: 0 }],
    ['negative amount', { amount_cents: -5 }],
    ['unknown category', { category: 'rake' }],
    ['blank description', { description: ' ' }],
    ['fractional cents', { amount_cents: '10.5' }],
  ])('rejects %s', async (_n, extra) => {
    expect(await errorOf(db.as(host(), `select public.host_save_expense($1::jsonb)`, [expense(extra)]))).not.toBeNull();
  });

  it('editing requires a reason and is audited with old and new values', async () => {
    const upd = expense({ id: expenseId, session_id: sessionId, amount_cents: 7000 });
    expect(await errorOf(db.as(host(), `select public.host_save_expense($1::jsonb)`, [upd]))).toMatch(/edit_reason_required/);
    await db.as(host(), `select public.host_save_expense($1::jsonb, 'Added the tip')`, [upd]);
    const [log] = await db.as<{ reason: string; old_data: { amount_cents: number }; new_data: { amount_cents: number }; session_id: string }>(
      host(),
      `select * from public.host_get_audit() where table_name = 'host_expenses' and action = 'update'`,
    );
    expect(log!.reason).toBe('Added the tip');
    expect(log!.old_data.amount_cents).toBe(6450);
    expect(log!.new_data.amount_cents).toBe(7000);
    expect(log!.session_id).toBe(sessionId);
  });

  it('filters by game and keeps expenses as general when the game is deleted', async () => {
    await db.as(host(), `select public.host_save_expense($1::jsonb)`, [expense({ category: 'cards', description: 'New KEM decks', amount_cents: 10899 })]);
    expect(await db.as(host(), `select * from public.host_list_expenses(null, null, $1)`, [sessionId])).toHaveLength(1);
    await db.as(host(), `select public.host_delete_session($1, 'Test data')`, [sessionId]);
    const rows = await db.as<{ session_id: string | null }>(host(), `select * from public.host_list_expenses()`);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.session_id === null)).toBe(true);
  });

  it('deleting requires a reason and is audited', async () => {
    expect(await errorOf(db.as(host(), `select public.host_delete_expense($1, '')`, [expenseId]))).toMatch(/edit_reason_required/);
    await db.as(host(), `select public.host_delete_expense($1, 'Entered twice')`, [expenseId]);
    const logs = await db.as(host(), `select * from public.host_get_audit() where table_name = 'host_expenses' and action = 'delete'`);
    expect(logs).toHaveLength(1);
  });
});
