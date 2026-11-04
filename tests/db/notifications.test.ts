/** Security tests: email preferences, the notification outbox and unsubscribe links. */
import { beforeAll, describe, expect, it } from 'vitest';
import { TestDb, errorOf, type Actor } from './harness';

let db: TestDb;
let hostId: string;
let aliceId: string;
let bobId: string;
let carolId: string;
let secret: string;
const anon: Actor = { kind: 'anon' };
const host = (): Actor => ({ kind: 'user', id: hostId, aal: 'aal2' });
const as = (id: string): Actor => ({ kind: 'user', id, aal: 'aal1' });
const today = new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

type Claimed = { notification_id: string; kind: string; email: string; username: string; unsubscribe_token: string; payload: Record<string, unknown> };

async function saveSession(playedOn: string, players: string[]): Promise<string> {
  const [s] = await db.as<{ id: string }>(host(), `select public.host_save_session($1::jsonb) as id`, [
    JSON.stringify({
      played_on: playedOn, stakes: '$1/$2', adjustments: [],
      results: players.map((p) => ({ player_id: p, initial_buy_in_cents: 20000, add_on_cents: [], cash_out_cents: 25000 })),
    }),
  ]);
  return s!.id;
}
/** Make every pending email due now (instead of waiting 15 minutes). */
const makeDue = () => db.owner(`update private.notification_outbox set send_after = now() - interval '1 minute' where status = 'pending'`);
const claim = (s = secret) => db.as<Claimed>(anon, 'select * from public.claim_notifications($1, 25)', [s]);
const outbox = () => db.owner<{ player_id: string; kind: string; status: string; attempts: number; ref_id: string }>(
  'select player_id, kind, status, attempts, ref_id from private.notification_outbox order by created_at');

beforeAll(async () => {
  db = await TestDb.create();
  hostId = await db.createUser('owner@example.com', 'owner1');
  await db.makeHost(hostId);
  aliceId = await db.createUser('alice@example.com', 'alice');
  bobId = await db.createUser('bob@example.com', 'bob_99');
  carolId = await db.createUser('carol@example.com', 'carol');
  for (const id of [aliceId, bobId, carolId]) await db.as(as(id), 'select public.set_my_tracking(true)');
  const [r] = await db.owner<{ s: string }>('select private.rotate_outbox_secret() as s');
  secret = r!.s;
}, 60_000);

describe('notification preferences', () => {
  it('every member starts with opt-in emails off and seat emails on', async () => {
    const [p] = await db.as(as(aliceId), 'select * from public.get_my_notification_prefs()');
    expect(p).toEqual({ results_ready: false, game_announcements: false, seat_updates: true, game_reminders: true });
  });

  it('members change only their own preferences and opting in records consent', async () => {
    await db.as(as(aliceId), `select public.set_my_notification_prefs('{"results_ready": true}'::jsonb)`);
    const [p] = await db.as(as(aliceId), 'select * from public.get_my_notification_prefs()');
    expect(p).toMatchObject({ results_ready: true, game_announcements: false, seat_updates: true });
    const [c] = await db.owner<{ results_ready_consented_at: Date | null }>(
      'select results_ready_consented_at from public.notification_preferences where player_id = $1', [aliceId]);
    expect(c!.results_ready_consented_at).not.toBeNull();
    const [b] = await db.as(as(bobId), 'select * from public.get_my_notification_prefs()');
    expect(b).toMatchObject({ results_ready: false });
  });

  it('rejects unknown or non-boolean keys', async () => {
    expect(await errorOf(db.as(as(aliceId), `select public.set_my_notification_prefs('{"results_ready": "yes"}'::jsonb)`))).toMatch(/invalid_payload/);
    expect(await errorOf(db.as(as(aliceId), `select public.set_my_notification_prefs('{"player_id": true}'::jsonb)`))).toMatch(/invalid_payload/);
  });

  it('the preferences table, outbox and settings are not reachable through the API', async () => {
    for (const actor of [anon, as(aliceId), host()]) {
      expect(await errorOf(db.as(actor, 'select * from public.notification_preferences'))).toMatch(/permission denied/);
      expect(await errorOf(db.as(actor, `update public.notification_preferences set results_ready = true`))).toMatch(/permission denied/);
      expect(await errorOf(db.as(actor, 'select * from private.notification_outbox'))).toMatch(/permission denied/);
      expect(await errorOf(db.as(actor, 'select * from private.app_settings'))).toMatch(/permission denied/);
      expect(await errorOf(db.as(actor, 'select private.rotate_outbox_secret()'))).toMatch(/permission denied/);
    }
    expect(await errorOf(db.as(anon, 'select * from public.get_my_notification_prefs()'))).toMatch(/permission denied/);
  });
});

describe('results-ready emails', () => {
  let sessionId: string;

  it('queues one email for each opted-in, tracked player when results are saved', async () => {
    await db.as(as(carolId), `select public.set_my_notification_prefs('{"results_ready": true}'::jsonb)`);
    sessionId = await saveSession(today, [aliceId, bobId, carolId]);
    const rows = await outbox();
    // Bob never opted in.
    expect(rows.map((r) => r.player_id).sort()).toEqual([aliceId, carolId].sort());
    expect(rows.every((r) => r.kind === 'results_ready' && r.ref_id === sessionId && r.status === 'pending')).toBe(true);
  });

  it('waits before sending, so quick corrections settle', async () => {
    expect(await claim()).toEqual([]);
  });

  it('saving the session again does not queue duplicates', async () => {
    const [s] = await db.as<{ s: Record<string, unknown> }>(host(), 'select public.host_get_session($1) as s', [sessionId]);
    const results = (s!.s.results as Array<Record<string, unknown>>).map((r) => ({ ...r, cash_out_cents: 30000 }));
    await db.as(host(), `select public.host_save_session($1::jsonb, 'Fix cash-out')`, [
      JSON.stringify({ id: sessionId, played_on: today, stakes: '$1/$2', results, adjustments: [] }),
    ]);
    expect(await outbox()).toHaveLength(2);
  });

  it('does not email about back-filled games more than a week old', async () => {
    await saveSession(daysAgo(30), [aliceId]);
    expect(await outbox()).toHaveLength(2);
  });

  it('the scheduled job needs the secret', async () => {
    await makeDue();
    for (const bad of ['', 'x'.repeat(64), secret.slice(0, -1) + (secret.endsWith('a') ? 'b' : 'a')]) {
      expect(await errorOf(claim(bad))).toMatch(/forbidden/);
      expect(await errorOf(db.as(anon, 'select public.complete_notification($1, gen_random_uuid())', [bad]))).toMatch(/forbidden/);
    }
    // Players can't call it either, even with a guess.
    expect(await errorOf(db.as(as(aliceId), 'select * from public.claim_notifications($1, 5)', [secret]))).toMatch(/permission denied/);
  });

  it('a claim returns address, username and session date only — no amounts', async () => {
    const rows = await claim();
    expect(rows).toHaveLength(2);
    const alice = rows.find((r) => r.email === 'alice@example.com')!;
    expect(alice.username).toBe('alice');
    expect(alice.unsubscribe_token).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(alice.payload).sort()).toEqual(['played_on', 'stakes', 'title']);
    expect(JSON.stringify(rows)).not.toMatch(/20000|25000|30000|bob/);
    // Claimed emails are locked: a second run doesn't send them again.
    expect(await claim()).toEqual([]);
  });

  it('failures retry with back-off; successes are marked sent', async () => {
    const rows = await db.owner<{ id: string; player_id: string }>('select id, player_id from private.notification_outbox');
    const a = rows.find((r) => r.player_id === aliceId)!;
    const c = rows.find((r) => r.player_id === carolId)!;
    await db.as(anon, 'select public.complete_notification($1, $2)', [secret, a.id]);
    await db.as(anon, `select public.complete_notification($1, $2, 'HTTP 500')`, [secret, c.id]);
    const after = await outbox();
    expect(after.find((r) => r.player_id === aliceId)!.status).toBe('sent');
    const carol = after.find((r) => r.player_id === carolId)!;
    expect(carol.status).toBe('pending');
    expect(await claim()).toEqual([]); // back-off: not due yet
    await makeDue();
    const retry = await claim();
    expect(retry.map((r) => r.email)).toEqual(['carol@example.com']);
  });

  it('skips an email if the player opts out before it is sent', async () => {
    await db.owner(`update private.notification_outbox set locked_until = null where status = 'pending'`);
    await db.as(as(carolId), `select public.set_my_notification_prefs('{"results_ready": false}'::jsonb)`);
    await makeDue();
    expect(await claim()).toEqual([]);
    expect((await outbox()).find((r) => r.player_id === carolId)!.status).toBe('skipped');
  });

  it('skips an email if tracking is turned off before it is sent', async () => {
    await db.as(as(carolId), `select public.set_my_notification_prefs('{"results_ready": true}'::jsonb)`);
    const s2 = await saveSession(today, [carolId]);
    await db.as(as(carolId), 'select public.set_my_tracking(false)');
    await makeDue();
    expect(await claim()).toEqual([]);
    const row = (await outbox()).find((r) => r.ref_id === s2)!;
    expect(row.status).toBe('skipped');
  });
});

describe('unsubscribe links', () => {
  it('turn off one kind of email without logging in', async () => {
    const [t] = await db.owner<{ unsubscribe_token: string }>(
      'select unsubscribe_token from public.notification_preferences where player_id = $1', [aliceId]);
    const [r] = await db.as<{ ok: boolean }>(anon, `select public.unsubscribe_with_token($1, 'results_ready') as ok`, [t!.unsubscribe_token]);
    expect(r!.ok).toBe(true);
    const [p] = await db.as(as(aliceId), 'select * from public.get_my_notification_prefs()');
    expect(p).toMatchObject({ results_ready: false, seat_updates: true });
  });

  it('"all" turns everything off', async () => {
    const [t] = await db.owner<{ unsubscribe_token: string }>(
      'select unsubscribe_token from public.notification_preferences where player_id = $1', [bobId]);
    await db.as(anon, `select public.unsubscribe_with_token($1, 'all')`, [t!.unsubscribe_token]);
    const [p] = await db.as(as(bobId), 'select * from public.get_my_notification_prefs()');
    expect(p).toEqual({ results_ready: false, game_announcements: false, seat_updates: false, game_reminders: false });
  });

  it('a wrong or malformed token changes nothing', async () => {
    const [r] = await db.as<{ ok: boolean }>(anon, `select public.unsubscribe_with_token($1, 'all') as ok`, ['0'.repeat(64)]);
    expect(r!.ok).toBe(false);
    const [m] = await db.as<{ ok: boolean }>(anon, `select public.unsubscribe_with_token($1, 'all') as ok`, ["' or 1=1 --"]);
    expect(m!.ok).toBe(false);
    expect(await errorOf(db.as(anon, `select public.unsubscribe_with_token($1, 'everything')`, ['0'.repeat(64)]))).toMatch(/invalid_payload/);
    const [p] = await db.as(as(carolId), 'select * from public.get_my_notification_prefs()');
    expect(p).toMatchObject({ results_ready: true, seat_updates: true });
  });

  it('deleting an account removes its preferences and queued emails', async () => {
    await db.as(as(carolId), 'select public.delete_my_account()');
    expect(await db.owner('select 1 from public.notification_preferences where player_id = $1', [carolId])).toEqual([]);
    expect(await db.owner('select 1 from private.notification_outbox where player_id = $1', [carolId])).toEqual([]);
  });
});

describe('function privileges', () => {
  it('anonymous visitors can run only the functions meant for them', async () => {
    const rows = await db.owner<{ name: string }>(`
      select p.proname as name
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute')
       order by 1`);
    expect(rows.map((r) => r.name)).toEqual(
      ['check_username', 'claim_notifications', 'complete_notification', 'unsubscribe_with_token']);
  });

  it('only the host checks used by row-level security are runnable from private', async () => {
    const rows = await db.owner<{ name: string }>(`
      select p.proname as name
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'private'
         and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))
       order by 1`);
    expect(rows.map((r) => r.name)).toEqual(['assert_host', 'is_host', 'is_host_mfa']);
  });
});
