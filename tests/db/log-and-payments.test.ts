/** Security tests: My Poker Log (owner-only) and host payment tracking. */
import { beforeAll, describe, expect, it } from 'vitest';
import { TestDb, errorOf, type Actor } from './harness';

let db: TestDb;
let hostId: string;
let aliceId: string;
let bobId: string;
let sessionId: string;
const host = (aal: 'aal1' | 'aal2' = 'aal2'): Actor => ({ kind: 'user', id: hostId, aal });
const as = (id: string, aal: 'aal1' | 'aal2' = 'aal1'): Actor => ({ kind: 'user', id, aal });
const entry = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ played_on: '2026-10-25', venue: 'Casino Rama', game: 'No-Limit Hold’em', format: 'cash', stakes: '$2/$5', buy_in_cents: 50000, cash_out_cents: 81000, duration_minutes: 240, notes: 'Good table', ...extra });

beforeAll(async () => {
  db = await TestDb.create();
  hostId = await db.createUser('owner@example.com', 'owner1');
  await db.makeHost(hostId);
  aliceId = await db.createUser('alice@example.com', 'alice');
  bobId = await db.createUser('bob@example.com', 'bob_99');
  await db.as(as(aliceId), 'select public.set_my_tracking(true)');
  const [s] = await db.as<{ id: string }>(host(), `select public.host_save_session($1::jsonb) as id`, [
    JSON.stringify({
      played_on: '2026-10-30', stakes: '$1/$2', adjustments: [],
      results: [
        { player_id: aliceId, initial_buy_in_cents: 20000, add_on_cents: [10000], cash_out_cents: 45000 },
        { guest_label: 'Guest 1', initial_buy_in_cents: 20000, add_on_cents: [], cash_out_cents: 0 },
        { guest_label: 'Guest 2', initial_buy_in_cents: 20000, add_on_cents: [], cash_out_cents: 15000 },
      ],
    }),
  ]);
  sessionId = s!.id;
}, 60_000);

describe('My Poker Log', () => {
  let aliceEntry: string;

  it('a member can add, list, edit and delete their own entries', async () => {
    const [r] = await db.as<{ id: string }>(as(aliceId), `select public.my_log_save($1::jsonb) as id`, [entry()]);
    aliceEntry = r!.id;
    const rows = await db.as<{ net_cents: string }>(as(aliceId), 'select * from public.my_log_list()');
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.net_cents)).toBe(31000);
    await db.as(as(aliceId), `select public.my_log_save($1::jsonb)`, [entry({ id: aliceEntry, cash_out_cents: 40000 })]);
    const [after] = await db.as<{ net_cents: string }>(as(aliceId), 'select * from public.my_log_list()');
    expect(Number(after!.net_cents)).toBe(-10000);
  });

  it('nobody else can see it: not another player, and not the host', async () => {
    expect(await db.as(as(bobId), 'select * from public.my_log_list()')).toEqual([]);
    expect(await db.as(as(bobId), 'select * from public.player_poker_log')).toEqual([]);
    expect(await db.as(host('aal2'), 'select * from public.my_log_list()')).toEqual([]);
    expect(await db.as(host('aal2'), 'select * from public.player_poker_log')).toEqual([]);
  });

  it('nobody else can change or delete it', async () => {
    expect(await errorOf(db.as(as(bobId), `select public.my_log_save($1::jsonb)`, [entry({ id: aliceEntry })]))).toMatch(/log_entry_not_found/);
    expect(await errorOf(db.as(as(bobId), `select public.my_log_delete($1)`, [aliceEntry]))).toMatch(/log_entry_not_found/);
    expect(await errorOf(db.as(host(), `select public.my_log_delete($1)`, [aliceEntry]))).toMatch(/log_entry_not_found/);
    expect(await errorOf(db.as(as(bobId), `update public.player_poker_log set notes = 'x'`))).toMatch(/permission denied/);
    expect(await errorOf(db.as(as(bobId), `insert into public.player_poker_log (player_id, played_on, venue, format, buy_in_cents, cash_out_cents) values ('${aliceId}', '2026-01-01', 'x', 'cash', 1, 1)`))).toMatch(/permission denied/);
    expect(await errorOf(db.as({ kind: 'anon' }, 'select * from public.my_log_list()'))).toMatch(/permission denied/);
  });

  it.each(['AK Cash Club', 'akcashclub', 'AK-Cash club home game', 'the AK club'])('refuses AK Cash Club games (%s)', async (venue) => {
    expect(await errorOf(db.as(as(aliceId), `select public.my_log_save($1::jsonb)`, [entry({ venue })]))).toMatch(/ak_games_tracked_separately/);
  });

  it.each([
    ['negative buy-in', { buy_in_cents: -1 }],
    ['bad format', { format: 'sng' }],
    ['blank venue', { venue: ' ' }],
    ['zero duration', { duration_minutes: 0 }],
  ])('rejects %s', async (_n, extra) => {
    expect(await errorOf(db.as(as(aliceId), `select public.my_log_save($1::jsonb)`, [entry(extra)]))).not.toBeNull();
  });

  it('is separate from tracked AK Cash Club results and removed with the account', async () => {
    const ak = await db.as(as(aliceId), 'select * from public.get_my_results()');
    expect(ak).toHaveLength(1);
    await db.as(as(bobId), `select public.my_log_save($1::jsonb)`, [entry({ venue: 'Online' })]);
    await db.as(as(bobId), 'select public.delete_my_account()');
    expect(await db.owner('select 1 from public.player_poker_log where player_id = $1', [bobId])).toEqual([]);
  });

  it('a member can delete their own entry', async () => {
    await db.as(as(aliceId), `select public.my_log_delete($1)`, [aliceEntry]);
    expect(await db.as(as(aliceId), 'select * from public.my_log_list()')).toEqual([]);
  });
});

describe('payment tracking (host only)', () => {
  type R = { id: string; guest_label: string | null; payout_paid: boolean; payout_paid_at: string | null; buy_in_method: string | null };
  const results = async () =>
    ((await db.as<{ s: { results: R[] } }>(host(), 'select public.host_get_session($1) as s', [sessionId]))[0]!.s.results);

  it('starts with every payout outstanding (except zero cash-outs)', async () => {
    const [s] = await db.as<{ payouts_outstanding: string }>(host(), 'select * from public.host_list_sessions() where session_id = $1', [sessionId]);
    expect(Number(s!.payouts_outstanding)).toBe(2);
  });

  it('the host records payment methods and ticks payouts', async () => {
    const rows = await results();
    const payload = rows.map((r) => ({
      result_id: r.id,
      buy_in_method: r.guest_label === 'Guest 1' ? 'cash' : 'etransfer',
      payout_method: r.guest_label === 'Guest 1' ? null : 'etransfer',
      payout_paid: r.guest_label !== 'Guest 2',
    }));
    await db.as(host(), 'select public.host_update_payments($1, $2::jsonb)', [sessionId, JSON.stringify(payload)]);
    const after = await results();
    expect(after.filter((r) => r.payout_paid).every((r) => r.payout_paid_at)).toBe(true);
    const [s] = await db.as<{ payouts_outstanding: string }>(host(), 'select * from public.host_list_sessions() where session_id = $1', [sessionId]);
    expect(Number(s!.payouts_outstanding)).toBe(1); // Guest 2 still to pay
  });

  it('keeps the original paid time when saved again, and clears it when unticked', async () => {
    const before = await results();
    const alice = before.find((r) => !r.guest_label)!;
    await db.as(host(), 'select public.host_update_payments($1, $2::jsonb)', [sessionId, JSON.stringify([{ result_id: alice.id, buy_in_method: 'mixed', payout_method: 'cash', payout_paid: true }])]);
    expect((await results()).find((r) => r.id === alice.id)!.payout_paid_at).toBe(alice.payout_paid_at);
    await db.as(host(), 'select public.host_update_payments($1, $2::jsonb)', [sessionId, JSON.stringify([{ result_id: alice.id, buy_in_method: 'mixed', payout_method: 'cash', payout_paid: false }])]);
    expect((await results()).find((r) => r.id === alice.id)!.payout_paid_at).toBeNull();
  });

  it('is audited', async () => {
    const logs = await db.as<{ reason: string }>(host(), `select * from public.host_get_audit($1) where action = 'update' and table_name = 'session_results'`, [sessionId]);
    expect(logs.length).toBeGreaterThanOrEqual(3);
    expect(logs.every((l) => l.reason === 'Payment details updated')).toBe(true);
  });

  it('editing results later keeps the payment details', async () => {
    const full = (await db.as<{ s: { results: Array<Record<string, unknown>>; adjustments: unknown[] } }>(host(), 'select public.host_get_session($1) as s', [sessionId]))[0]!.s;
    const payload = JSON.stringify({
      id: sessionId, played_on: '2026-10-30', stakes: '$1/$2', adjustments: [],
      results: full.results.map((r) => ({ id: r.id, player_id: r.player_id, guest_label: r.guest_label, initial_buy_in_cents: r.initial_buy_in_cents, add_on_cents: r.add_on_cents, cash_out_cents: r.cash_out_cents })),
    });
    await db.as(host(), `select public.host_save_session($1::jsonb, 'No-op edit')`, [payload]);
    expect((await results()).find((r) => r.guest_label === 'Guest 1')!.buy_in_method).toBe('cash');
  });

  it('players cannot read or change payment details', async () => {
    expect(await errorOf(db.as(as(aliceId, 'aal2'), 'select public.host_update_payments($1, $2::jsonb)', [sessionId, '[]']))).toMatch(/not_authorized/);
    expect(await errorOf(db.as(as(aliceId), 'select payout_paid from public.session_results'))).toMatch(/permission denied/);
    expect(await errorOf(db.as(as(aliceId), 'select * from public.session_results'))).toMatch(/permission denied/);
    // Their own results are still readable without the payment columns.
    expect((await db.as(as(aliceId), 'select id, net_cents from public.session_results')).length).toBe(1);
    expect((await db.as(as(aliceId), 'select * from public.get_my_results()')).length).toBe(1);
  });

  it('rejects invalid methods and rows from other sessions', async () => {
    const r = (await results())[0]!;
    expect(await errorOf(db.as(host(), 'select public.host_update_payments($1, $2::jsonb)', [sessionId, JSON.stringify([{ result_id: r.id, buy_in_method: 'crypto', payout_paid: false }])]))).toMatch(/check constraint/);
    expect(await errorOf(db.as(host(), 'select public.host_update_payments(gen_random_uuid(), $1::jsonb)', [JSON.stringify([{ result_id: r.id, payout_paid: true }])]))).toMatch(/result_not_found/);
  });
});
