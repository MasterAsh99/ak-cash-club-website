/** Live game-night mode: host-only, exact cents, and finalizing into an audited session. */
import { beforeAll, describe, expect, it } from 'vitest';
import { TestDb, errorOf, type Actor } from './harness';

let db: TestDb;
let hostId: string;
let alice: string; // tracking on
let bob: string; // tracking off
let nightId: string;
const host = (aal: 'aal1' | 'aal2' = 'aal2'): Actor => ({ kind: 'user', id: hostId, aal });
const as = (id: string): Actor => ({ kind: 'user', id, aal: 'aal1' });

type LivePlayer = { id: string; player_id: string | null; username: string | null; guest_label: string | null; checked_in_at: string | null; cash_out_cents: number | null; buyins: Array<{ id: string; amount_cents: number; method: string }> };
const live = async () => (await db.as<{ g: { players: LivePlayer[]; finalized_session_id: string | null } }>(host(), 'select public.host_live_get($1) as g', [nightId]))[0]!.g;
const player = async (name: string) => (await live()).players.find((p) => p.username === name || p.guest_label === name)!;
const buyIn = (lp: string, cents: number, method: string) => db.as(host(), 'select public.host_live_buy_in($1, $2, $3)', [lp, cents, method]);
const cashOut = (lp: string, cents: number | null, method: string | null) => db.as(host(), 'select public.host_live_cash_out($1, $2, $3)', [lp, cents, method]);

beforeAll(async () => {
  db = await TestDb.create();
  hostId = await db.createUser('owner@example.com', 'owner1');
  await db.makeHost(hostId);
  alice = await db.createUser('alice@example.com', 'alice');
  bob = await db.createUser('bob@example.com', 'bob_99');
  await db.as(as(alice), 'select public.set_my_tracking(true)');
  const local = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + 86_400_000));
  const [n] = await db.as<{ id: string }>(host(), 'select public.host_save_game_night($1::jsonb) as id', [
    JSON.stringify({ starts_local: `${local}T19:30`, stakes: '$1/$2', seats: 6, address: 'x' }),
  ]);
  nightId = n!.id;
  for (const p of [alice, bob]) {
    await db.as(as(p), 'select public.request_seat($1)', [nightId]);
    const [r] = await db.owner<{ id: string }>('select id from public.seat_requests where player_id = $1', [p]);
    await db.as(host(), `select public.host_decide_seat($1, 'confirmed')`, [r!.id]);
  }
}, 60_000);

describe('live game mode', () => {
  it('is host + MFA only, and the tables are not reachable', async () => {
    for (const actor of [as(alice), host('aal1')]) {
      expect(await errorOf(db.as(actor, 'select public.host_live_start($1)', [nightId]))).toMatch(/not_authorized|mfa/);
      expect(await errorOf(db.as(actor, 'select public.host_live_get($1)', [nightId]))).toMatch(/not_authorized|mfa/);
    }
    for (const t of ['live_games', 'live_players', 'live_buyins']) {
      expect(await errorOf(db.as(as(alice), `select * from public.${t}`))).toMatch(/permission denied/);
      expect(await errorOf(db.as(host(), `delete from public.${t}`))).toMatch(/permission denied/);
    }
  });

  it('starting adds the confirmed seats, not yet checked in', async () => {
    expect(await live()).toBeNull();
    await db.as(host(), 'select public.host_live_start($1)', [nightId]);
    await db.as(host(), 'select public.host_live_start($1)', [nightId]); // idempotent
    const g = await live();
    expect(g.players.map((p) => p.username).sort()).toEqual(['alice', 'bob_99']);
    expect(g.players.every((p) => p.checked_in_at === null)).toBe(true);
  });

  it('records buy-ins with payment method, rebuys, and walk-in guests', async () => {
    const a = await player('alice');
    await buyIn(a.id, 20000, 'cash');
    await buyIn(a.id, 10000, 'etransfer');
    await buyIn(a.id, 5050, 'cash');
    const b = await player('bob_99');
    await buyIn(b.id, 20000, 'etransfer');
    await db.as(host(), `select public.host_live_add_player($1, null, 'Sam (friend of Bob)')`, [nightId]);
    expect(await errorOf(db.as(host(), `select public.host_live_add_player($1, null, 'sam (friend of bob)')`, [nightId]))).toMatch(/already_in_game/);
    expect(await errorOf(db.as(host(), 'select public.host_live_add_player($1, $2)', [nightId, hostId]))).toMatch(/host_cannot_be_player/);
    const sam = await player('Sam (friend of Bob)');
    await buyIn(sam.id, 20000, 'cash');
    expect((await player('alice')).buyins.map((x) => x.amount_cents)).toEqual([20000, 10000, 5050]);
    expect((await player('alice')).checked_in_at).not.toBeNull();
  });

  it('rejects bad amounts and methods', async () => {
    const a = await player('alice');
    for (const [c, m] of [[0, 'cash'], [-100, 'cash'], [100000001, 'cash'], [100, 'bitcoin']] as const) {
      expect(await errorOf(buyIn(a.id, c, m)), `${c} ${m}`).not.toBeNull();
    }
  });

  it('a mistaken buy-in can be undone; buy-ins stop once cashed out', async () => {
    const a = await player('alice');
    const [x] = await db.as<{ id: string }>(host(), 'select public.host_live_buy_in($1, 999, $2) as id', [a.id, 'cash']);
    await db.as(host(), 'select public.host_live_undo_buy_in($1)', [x!.id]);
    expect((await player('alice')).buyins).toHaveLength(3);
    expect(await errorOf(db.as(host(), 'select public.host_live_remove_player($1)', [a.id]))).toMatch(/player_has_buyins/);
  });

  it('finalizing requires every player with a buy-in to be cashed out', async () => {
    const a = await player('alice');
    await cashOut(a.id, 60050, 'etransfer');
    expect(await errorOf(buyIn(a.id, 100, 'cash'))).toMatch(/player_cashed_out/);
    expect(await errorOf(db.as(host(), 'select public.host_live_finalize($1)', [nightId]))).toMatch(/players_not_cashed_out/);
    await cashOut((await player('bob_99')).id, 0, 'cash');
    await cashOut((await player('Sam (friend of Bob)')).id, 15000, 'cash');
  });

  it('finalizing creates an audited session with exact amounts and payment methods', async () => {
    const [r] = await db.as<{ id: string }>(host(), 'select public.host_live_finalize($1) as id', [nightId]);
    const sessionId = r!.id;
    const [s] = await db.as<{ s: { session: { stakes: string }; results: Array<Record<string, unknown>> } }>(host(), 'select public.host_get_session($1) as s', [sessionId]);
    const rows = s!.s.results;
    const byName = (n: string) => rows.find((x) => x.username === n || x.guest_label === n)!;
    // Alice (tracking on) is linked to her account; Bob (tracking off) is a host-only guest row.
    expect(byName('alice')).toMatchObject({ player_id: alice, buy_in_method: 'mixed', payout_method: 'etransfer', payout_paid: false });
    expect(Number(byName('alice').net_cents)).toBe(60050 - 35050);
    expect(byName('bob_99')).toMatchObject({ player_id: null, guest_label: 'bob_99', buy_in_method: 'etransfer', payout_method: 'cash' });
    expect(byName('Sam (friend of Bob)')).toMatchObject({ player_id: null, buy_in_method: 'cash' });
    const audit = await db.as<{ reason: string }>(host(), 'select * from public.host_get_audit($1)', [sessionId]);
    expect(audit.some((a) => a.reason === 'Recorded from live game mode')).toBe(true);
    // Alice sees it on her dashboard; Bob sees nothing.
    expect(await db.as(as(alice), 'select * from public.get_my_results()')).toHaveLength(1);
    expect(await db.as(as(bob), 'select * from public.get_my_results()')).toHaveLength(0);
    expect((await live()).finalized_session_id).toBe(sessionId);
  });

  it('is locked after finalizing', async () => {
    const a = await player('alice');
    expect(await errorOf(buyIn(a.id, 100, 'cash'))).toMatch(/live_game_finalized/);
    expect(await errorOf(db.as(host(), 'select public.host_live_finalize($1)', [nightId]))).toMatch(/live_game_finalized/);
  });
});
