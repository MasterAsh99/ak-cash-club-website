/** Hand notes and responsible-play tools. */
import { beforeAll, describe, expect, it } from 'vitest';
import { TestDb, errorOf, type Actor } from './harness';

let db: TestDb;
let hostId: string;
let alice: string;
let bob: string;
const host = (): Actor => ({ kind: 'user', id: hostId, aal: 'aal2' });
const as = (id: string): Actor => ({ kind: 'user', id, aal: 'aal1' });
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto' }).format(new Date());
const hand = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ played_on: today, title: 'Big river call', stakes: '$1/$2', position: 'BTN', hole_cards: ['As', 'Kd'], board: ['Ah', '7c', '2d', 'Ks', '9h'], notes: 'Villain shoved river.', ...extra });
const wellbeing = async (who: string) => (await db.as<{ w: Record<string, unknown> }>(as(who), 'select public.get_my_wellbeing() as w'))[0]!.w;

async function newNight(): Promise<string> {
  const local = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + 2 * 86_400_000));
  const [n] = await db.as<{ id: string }>(host(), 'select public.host_save_game_night($1::jsonb) as id', [JSON.stringify({ starts_local: `${local}T19:30`, stakes: '$1/$2', seats: 6, address: 'x' })]);
  return n!.id;
}

beforeAll(async () => {
  db = await TestDb.create();
  hostId = await db.createUser('owner@example.com', 'owner1');
  await db.makeHost(hostId);
  alice = await db.createUser('alice@example.com', 'alice');
  bob = await db.createUser('bob@example.com', 'bob_99');
}, 60_000);

describe('hand notes', () => {
  let id: string;
  it('a member saves, lists and edits their own hands', async () => {
    const [r] = await db.as<{ id: string }>(as(alice), 'select public.my_hand_save($1::jsonb) as id', [hand()]);
    id = r!.id;
    const rows = await db.as<Record<string, unknown>>(as(alice), 'select * from public.my_hands_list()');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: 'Big river call', position: 'BTN', hole_cards: ['As', 'Kd'], board: ['Ah', '7c', '2d', 'Ks', '9h'] });
    await db.as(as(alice), 'select public.my_hand_save($1::jsonb)', [hand({ id, board: ['Ah', '7c', '2d'] })]);
    expect((await db.as<{ board: string[] }>(as(alice), 'select * from public.my_hands_list()'))[0]!.board).toEqual(['Ah', '7c', '2d']);
  });

  it('nobody else, including the host, can see or change them', async () => {
    expect(await db.as(as(bob), 'select * from public.my_hands_list()')).toEqual([]);
    expect(await db.as(host(), 'select * from public.my_hands_list()')).toEqual([]);
    expect(await errorOf(db.as(as(bob), 'select public.my_hand_save($1::jsonb)', [hand({ id })]))).toMatch(/hand_not_found/);
    expect(await errorOf(db.as(host(), 'select public.my_hand_delete($1)', [id]))).toMatch(/hand_not_found/);
    expect(await errorOf(db.as(as(alice), 'select * from public.player_hand_notes'))).toMatch(/permission denied/);
    expect(await errorOf(db.as({ kind: 'anon' }, 'select * from public.my_hands_list()'))).toMatch(/permission denied/);
  });

  it.each([
    ['one hole card', { hole_cards: ['As'] }],
    ['a duplicate card', { hole_cards: ['As', 'Kd'], board: ['As', '7c', '2d'] }],
    ['an invalid card', { hole_cards: ['1s', 'Kd'] }],
    ['a two-card board', { board: ['Ah', '7c'] }],
    ['six board cards', { board: ['Ah', '7c', '2d', 'Ks', '9h', '3c'] }],
    ['an unknown position', { position: 'DEALER' }],
    ['a blank title', { title: ' ' }],
  ])('rejects %s', async (_n, extra) => {
    expect(await errorOf(db.as(as(alice), 'select public.my_hand_save($1::jsonb)', [hand(extra)]))).not.toBeNull();
  });

  it('allows a note with no cards', async () => {
    await db.as(as(alice), 'select public.my_hand_save($1::jsonb)', [hand({ hole_cards: [], board: [] })]);
  });
});

describe('monthly loss limit', () => {
  it('counts this month across AK results and the poker log', async () => {
    await db.as(as(alice), 'select public.set_my_tracking(true)');
    await db.as(host(), 'select public.host_save_session($1::jsonb)', [JSON.stringify({
      played_on: today, stakes: '$1/$2', adjustments: [],
      results: [{ player_id: alice, initial_buy_in_cents: 30000, add_on_cents: [], cash_out_cents: 10000 }, { guest_label: 'G', initial_buy_in_cents: 10000, add_on_cents: [], cash_out_cents: 30000 }],
    })]);
    await db.as(as(alice), 'select public.my_log_save($1::jsonb)', [JSON.stringify({ played_on: today, venue: 'Casino Rama', format: 'cash', buy_in_cents: 10000, cash_out_cents: 5000 })]);
    expect(Number((await wellbeing(alice)).month_net_cents)).toBe(-25000);
  });

  it('reaching the limit pauses seat requests', async () => {
    expect(await db.as<{ s: string }>(as(alice), 'select public.set_my_loss_limit(20000) as s')).toEqual([{ s: 'applied' }]);
    expect(await wellbeing(alice)).toMatchObject({ limit_reached: true });
    const night = await newNight();
    expect(await errorOf(db.as(as(alice), 'select public.request_seat($1)', [night]))).toMatch(/loss_limit_reached/);
  });

  it('lowering applies at once; raising or removing waits 24 hours', async () => {
    expect((await db.as<{ s: string }>(as(alice), 'select public.set_my_loss_limit(50000) as s'))[0]!.s).toBe('pending');
    expect(await wellbeing(alice)).toMatchObject({ loss_limit_cents: 20000, pending_limit_change: true, limit_reached: true });
    expect((await db.as<{ s: string }>(as(alice), 'select public.set_my_loss_limit(null) as s'))[0]!.s).toBe('pending');
    // After 24 hours the change applies.
    await db.owner(`update public.player_wellbeing set pending_effective_at = now() - interval '1 minute' where player_id = $1`, [alice]);
    expect(await wellbeing(alice)).toMatchObject({ loss_limit_cents: null, pending_limit_change: false, limit_reached: false });
    const night = await newNight();
    await db.as(as(alice), 'select public.request_seat($1)', [night]);
  });

  it('rejects silly limits', async () => {
    expect(await errorOf(db.as(as(alice), 'select public.set_my_loss_limit(0)'))).toMatch(/invalid_limit/);
    expect(await errorOf(db.as(as(alice), 'select public.set_my_loss_limit(-5)'))).toMatch(/invalid_limit/);
  });
});

describe('take a break', () => {
  it('withdraws pending requests, pauses new ones and new-game emails, and cannot be ended early', async () => {
    await db.as(as(bob), `select public.set_my_notification_prefs('{"game_announcements": true}'::jsonb)`);
    const night = await newNight();
    await db.as(as(bob), 'select public.request_seat($1)', [night]);
    expect(await errorOf(db.as(as(bob), 'select public.take_a_break(3)'))).toMatch(/invalid_break/);
    await db.as(as(bob), 'select public.take_a_break(7)');
    const [s] = await db.owner<{ status: string }>('select status from public.seat_requests where player_id = $1 and game_night_id = $2', [bob, night]);
    expect(s!.status).toBe('cancelled');
    expect(await errorOf(db.as(as(bob), 'select public.request_seat($1)', [night]))).toMatch(/on_a_break/);
    expect((await wellbeing(bob)).break_until).not.toBeNull();
    // A shorter break doesn't shorten the current one.
    const before = (await wellbeing(bob)).break_until;
    await db.as(as(bob), 'select public.take_a_break(1)');
    expect((await wellbeing(bob)).break_until).toBe(before);
    // No new-game emails during a break.
    await db.owner('delete from private.notification_outbox');
    const local = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + 3 * 86_400_000));
    await db.as(host(), 'select public.host_save_game_night($1::jsonb)', [JSON.stringify({ starts_local: `${local}T19:30`, stakes: '$1/$2', seats: 6, address: 'x', announce: true })]);
    expect(await db.owner(`select 1 from private.notification_outbox where player_id = $1`, [bob])).toEqual([]);
  });

  it('the host cannot see any of these settings', async () => {
    expect(await errorOf(db.as(host(), 'select * from public.player_wellbeing'))).toMatch(/permission denied/);
    const [w] = await db.as<{ w: Record<string, unknown> }>(host(), 'select public.get_my_wellbeing() as w');
    expect(w!.w.break_until).toBeNull(); // only ever the caller's own row
  });
});

describe('long-session reminder', () => {
  it('emails after the chosen time at a live game, unless cashed out', async () => {
    const [r] = await db.owner<{ s: string }>('select private.rotate_outbox_secret() as s');
    await db.as(as(alice), 'select public.set_my_session_reminder(240)');
    expect(await errorOf(db.as(as(alice), 'select public.set_my_session_reminder(10)'))).toMatch(/invalid_reminder/);
    const night = await newNight();
    await db.as(host(), 'select public.host_live_start($1)', [night]);
    await db.as(host(), 'select public.host_live_add_player($1, $2)', [night, alice]);
    const [row] = await db.owner<{ send_after: Date; created_at: Date }>(`select send_after, created_at from private.notification_outbox where kind = 'session_reminder' and player_id = $1`, [alice]);
    expect(row!.send_after.getTime() - row!.created_at.getTime()).toBeGreaterThan(239 * 60_000);
    await db.owner(`update private.notification_outbox set send_after = now() - interval '1 minute' where kind = 'session_reminder'`);
    const claimed = await db.as<{ kind: string; payload: Record<string, unknown> }>({ kind: 'anon' }, 'select * from public.claim_notifications($1, 25)', [r!.s]);
    expect(claimed.filter((c) => c.kind === 'session_reminder')).toHaveLength(1);
    expect(claimed.find((c) => c.kind === 'session_reminder')!.payload).toMatchObject({ minutes: 240 });
  });

  it('is skipped once the player has cashed out', async () => {
    await db.as(as(bob), 'select public.set_my_session_reminder(120)');
    const night = await newNight();
    await db.as(host(), 'select public.host_live_start($1)', [night]);
    const [lp] = await db.as<{ id: string }>(host(), 'select public.host_live_add_player($1, $2) as id', [night, bob]);
    await db.as(host(), `select public.host_live_buy_in($1, 10000, 'cash')`, [lp!.id]);
    await db.as(host(), `select public.host_live_cash_out($1, 5000, 'cash')`, [lp!.id]);
    const [r] = await db.owner<{ s: string }>('select private.rotate_outbox_secret() as s');
    await db.owner(`update private.notification_outbox set send_after = now() - interval '1 minute' where kind = 'session_reminder' and status = 'pending'`);
    await db.as({ kind: 'anon' }, 'select * from public.claim_notifications($1, 25)', [r!.s]);
    const [o] = await db.owner<{ status: string }>(`select status from private.notification_outbox where kind = 'session_reminder' and player_id = $1`, [bob]);
    expect(o!.status).toBe('skipped');
  });
});
