/** Security and behaviour tests: game nights, seat requests, waitlist, address reveal, emails. */
import { beforeAll, describe, expect, it } from 'vitest';
import { TestDb, errorOf, type Actor } from './harness';

let db: TestDb;
let hostId: string;
let ids: Record<'alice' | 'bob' | 'carol' | 'dave', string>;
const host = (aal: 'aal1' | 'aal2' = 'aal2'): Actor => ({ kind: 'user', id: hostId, aal });
const as = (id: string): Actor => ({ kind: 'user', id, aal: 'aal1' });
const anon: Actor = { kind: 'anon' };

/** 'YYYY-MM-DDTHH:MM' in Toronto time, n days from now. */
function torontoLocal(days: number, time = '19:30'): string {
  const d = new Date(Date.now() + days * 86_400_000);
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  return `${date}T${time}`;
}
const night = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ starts_local: torontoLocal(3), stakes: '$1/$2', seats: 2, notes: 'Doors 7pm', address: '123 Secret St', arrival_note: 'Side door', announce: true, auto_fill_waitlist: true, ...extra });

async function save(extra: Record<string, unknown> = {}): Promise<string> {
  const [r] = await db.as<{ id: string }>(host(), 'select public.host_save_game_night($1::jsonb) as id', [night(extra)]);
  return r!.id;
}
const request = (who: string, id: string, note: string | null = null) =>
  db.as(as(who), 'select public.request_seat($1, $2)', [id, note]);
async function requestId(id: string, who: string): Promise<string> {
  const [r] = await db.owner<{ id: string }>('select id from public.seat_requests where game_night_id = $1 and player_id = $2', [id, who]);
  return r!.id;
}
const decide = (rid: string, status: string) => db.as(host(), 'select public.host_decide_seat($1, $2)', [rid, status]);
const statusOf = async (id: string, who: string) => {
  const [r] = await db.owner<{ status: string }>('select status from public.seat_requests where game_night_id = $1 and player_id = $2', [id, who]);
  return r?.status;
};
const emails = (id: string) => db.owner<{ player_id: string; kind: string; payload: { event: string } }>(
  'select player_id, kind, payload from private.notification_outbox where ref_id = $1 order by created_at', [id]);
const getNight = async (who: Actor, id: string) =>
  (await db.as<{ g: Record<string, unknown> }>(who, 'select public.get_game_night($1) as g', [id]))[0]!.g;

beforeAll(async () => {
  db = await TestDb.create();
  hostId = await db.createUser('owner@example.com', 'owner1');
  await db.makeHost(hostId);
  ids = {
    alice: await db.createUser('alice@example.com', 'alice'),
    bob: await db.createUser('bob@example.com', 'bob_99'),
    carol: await db.createUser('carol@example.com', 'carol'),
    dave: await db.createUser('dave@example.com', 'dave'),
  };
  // Alice and Bob want to hear about new games.
  for (const p of [ids.alice, ids.bob]) {
    await db.as(as(p), `select public.set_my_notification_prefs('{"game_announcements": true}'::jsonb)`);
  }
}, 60_000);

describe('creating game nights', () => {
  it('only the host with MFA can create, edit, list or cancel them', async () => {
    for (const actor of [as(ids.alice), host('aal1')]) {
      expect(await errorOf(db.as(actor, 'select public.host_save_game_night($1::jsonb)', [night()]))).toMatch(/permission|not_authorized|mfa/i);
      expect(await errorOf(db.as(actor, 'select * from public.host_list_game_nights()'))).toMatch(/permission|not_authorized|mfa/i);
      expect(await errorOf(db.as(actor, 'select public.host_last_venue()'))).toMatch(/permission|not_authorized|mfa/i);
    }
    expect(await errorOf(db.as(anon, 'select * from public.list_game_nights()'))).toMatch(/permission denied/);
  });

  it('rejects bad input', async () => {
    for (const bad of [{ starts_local: '2020-01-01T19:00' }, { starts_local: 'tomorrow' }, { seats: 1 }, { seats: 13 }, { address: ' ' }, { stakes: '' }, { status: 'cancelled' }]) {
      expect(await errorOf(save(bad)), JSON.stringify(bad)).not.toBeNull();
    }
  });

  it('stores the time in Toronto time and announces to members who opted in', async () => {
    const id = await save();
    const [g] = await db.as<{ g: { starts_local: string; address: string } }>(host(), 'select public.host_get_game_night($1) as g', [id]);
    expect(g!.g.starts_local).toBe(torontoLocal(3));
    expect(g!.g.address).toBe('123 Secret St');
    const sent = await emails(id);
    expect(sent.map((e) => e.player_id).sort()).toEqual([ids.alice, ids.bob].sort());
    expect(sent.every((e) => e.kind === 'game_announcement')).toBe(true);
  });

  it('tables are not reachable directly', async () => {
    for (const actor of [anon, as(ids.alice), host()]) {
      for (const t of ['public.game_nights', 'public.seat_requests', 'private.game_night_venue']) {
        expect(await errorOf(db.as(actor, `select * from ${t}`))).toMatch(/permission denied/);
      }
      expect(await errorOf(db.as(actor, `insert into public.seat_requests (game_night_id, player_id) values (gen_random_uuid(), gen_random_uuid())`))).toMatch(/permission denied/);
    }
  });
});

describe('seat requests and the waitlist', () => {
  let id: string;
  beforeAll(async () => {
    id = await save({ announce: false });
  });

  it('members request seats; they see counts but never who else is coming', async () => {
    await request(ids.alice, id, 'Might be 15 min late');
    await request(ids.bob, id);
    await request(ids.carol, id);
    expect(await errorOf(request(ids.alice, id))).toMatch(/already_requested/);
    const rows = await db.as<Record<string, unknown>>(as(ids.dave), 'select * from public.list_game_nights()');
    const row = rows.find((r) => r.game_night_id === id)!;
    expect(row).toMatchObject({ confirmed_count: 0, my_status: null, seats: 2 });
    expect(JSON.stringify(rows)).not.toMatch(/alice|bob_99|carol|Secret/);
    expect(await errorOf(db.as(host(), 'select public.request_seat($1)', [id]))).toMatch(/host_cannot_request_seat/);
  });

  it('players cannot approve themselves or anyone else', async () => {
    const rid = await requestId(id, ids.alice);
    expect(await errorOf(db.as(as(ids.alice), 'select public.host_decide_seat($1, $2)', [rid, 'confirmed']))).toMatch(/permission|not_authorized|mfa/i);
    expect(await errorOf(db.as(as(ids.alice), 'select public.host_get_game_night($1)', [id]))).toMatch(/permission|not_authorized|mfa/i);
    expect(await statusOf(id, ids.alice)).toBe('requested');
  });

  it('the host confirms up to the seat limit, then must waitlist', async () => {
    await decide(await requestId(id, ids.alice), 'confirmed');
    await decide(await requestId(id, ids.bob), 'confirmed');
    expect(await errorOf(decide(await requestId(id, ids.carol), 'confirmed'))).toMatch(/game_full/);
    await decide(await requestId(id, ids.carol), 'waitlisted');
    // The table is full, so Dave's request goes straight onto the waitlist.
    await request(ids.dave, id);
    expect(await statusOf(id, ids.dave)).toBe('waitlisted');
    const g = await getNight(as(ids.dave), id);
    expect(g).toMatchObject({ my_status: 'waitlisted', my_waitlist_position: 2, confirmed_count: 2, waitlist_count: 2 });
    const events = (await emails(id)).map((e) => e.payload.event);
    expect(events).toEqual(['confirmed', 'confirmed', 'waitlisted']);
  });

  it('when a confirmed player cancels, the first on the waitlist is confirmed and emailed', async () => {
    await db.as(as(ids.bob), 'select public.cancel_my_seat($1)', [id]);
    expect(await statusOf(id, ids.bob)).toBe('cancelled');
    expect(await statusOf(id, ids.carol)).toBe('confirmed');
    expect(await statusOf(id, ids.dave)).toBe('waitlisted');
    const last = (await emails(id)).at(-1)!;
    expect(last).toMatchObject({ player_id: ids.carol, payload: { event: 'promoted' } });
  });

  it('adding seats promotes from the waitlist too', async () => {
    await save({ id, seats: 3, announce: false });
    expect(await statusOf(id, ids.dave)).toBe('confirmed');
    expect(await errorOf(save({ id, seats: 2 }))).toMatch(/seats_below_confirmed/);
  });

  it('a declined player cannot simply request again; a cancelled one can', async () => {
    await decide(await requestId(id, ids.dave), 'declined');
    expect(await errorOf(request(ids.dave, id))).toMatch(/request_declined/);
    await request(ids.bob, id);
    expect(await statusOf(id, ids.bob)).toBe('requested'); // back in the queue for the host to decide
  });
});

describe('address reveal', () => {
  it('is hidden from everyone but the host until game day', async () => {
    const id = await save({ announce: false });
    await request(ids.alice, id);
    await decide(await requestId(id, ids.alice), 'confirmed');
    expect(await getNight(as(ids.alice), id)).not.toHaveProperty('address');
    expect(await getNight(host(), id)).toHaveProperty('address', '123 Secret St');
  });

  it('on game day only confirmed players see it, and never through the list', async () => {
    const id = await save({ announce: false, seats: 3 });
    for (const p of [ids.alice, ids.bob, ids.carol]) await request(p, id);
    await decide(await requestId(id, ids.alice), 'confirmed');
    await decide(await requestId(id, ids.bob), 'waitlisted');
    // Move the game to late tonight (Toronto time).
    await db.owner(`update public.game_nights set starts_at = ((now() at time zone 'America/Toronto')::date + time '23:59') at time zone 'America/Toronto' where id = $1`, [id]);
    expect(await getNight(as(ids.alice), id)).toMatchObject({ address: '123 Secret St', arrival_note: 'Side door' });
    expect(await getNight(as(ids.bob), id)).not.toHaveProperty('address');
    expect(await getNight(as(ids.carol), id)).not.toHaveProperty('address');
    expect(await getNight(as(ids.dave), id)).not.toHaveProperty('address');
    // Cancelling the game hides it again.
    await db.as(host(), 'select public.host_cancel_game_night($1)', [id]);
    expect(await getNight(as(ids.alice), id)).not.toHaveProperty('address');
  });
});

describe('game emails', () => {
  it('cancelling a game emails everyone with an active request', async () => {
    const id = await save({ announce: false });
    await request(ids.alice, id);
    await request(ids.bob, id);
    await decide(await requestId(id, ids.alice), 'confirmed');
    await db.owner('delete from private.notification_outbox');
    await db.as(host(), 'select public.host_cancel_game_night($1)', [id]);
    const sent = await emails(id);
    expect(sent.map((e) => [e.player_id, e.payload.event]).sort()).toEqual([[ids.alice, 'cancelled'], [ids.bob, 'cancelled']].sort());
    expect(await errorOf(request(ids.carol, id))).toMatch(/requests_closed/);
  });

  it('changing the time emails active requests', async () => {
    const id = await save({ announce: false });
    await request(ids.carol, id);
    await db.owner('delete from private.notification_outbox');
    await save({ id, starts_local: torontoLocal(4), announce: false });
    expect((await emails(id)).map((e) => e.payload.event)).toEqual(['changed']);
  });

  it('day-before reminders go to confirmed players only, via the scheduled job', async () => {
    const [r] = await db.owner<{ s: string }>('select private.rotate_outbox_secret() as s');
    const soon = await save({ announce: false, seats: 4 });
    const later = await save({ announce: false, seats: 4, starts_local: torontoLocal(2.5) });
    for (const id of [soon, later]) {
      await request(ids.alice, id);
      await request(ids.bob, id);
      await decide(await requestId(id, ids.alice), 'confirmed');
    }
    // "soon" starts in 4 hours, so its reminder is due now.
    await db.owner(`update public.game_nights set starts_at = now() + interval '4 hours' where id = $1`, [soon]);
    await db.owner('delete from private.notification_outbox');
    const claimed = await db.as<{ kind: string; email: string; payload: Record<string, unknown> }>(
      anon, 'select * from public.claim_notifications($1, 25)', [r!.s]);
    expect(claimed.map((c) => [c.kind, c.email])).toEqual([['game_reminder', 'alice@example.com']]);
    expect(claimed[0]!.payload).toMatchObject({ event: 'reminder', game_night_id: soon, stakes: '$1/$2' });
    expect(JSON.stringify(claimed)).not.toMatch(/Secret St|Side door/);
    // Running again doesn't queue a second reminder.
    await db.as(anon, 'select * from public.claim_notifications($1, 25)', [r!.s]);
    expect((await emails(soon)).filter((e) => e.kind === 'game_reminder')).toHaveLength(1);
    expect(await emails(later)).toEqual([]);
  });

  it('seat emails respect preferences', async () => {
    await db.as(as(ids.dave), `select public.set_my_notification_prefs('{"seat_updates": false}'::jsonb)`);
    const id = await save({ announce: false });
    await request(ids.dave, id);
    await decide(await requestId(id, ids.dave), 'confirmed');
    expect(await emails(id)).toEqual([]);
  });
});
