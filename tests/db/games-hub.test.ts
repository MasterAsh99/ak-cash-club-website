/** Guests, host-added members, masked names, waitlist control, capacity and privacy. */
import { beforeAll, describe, expect, it } from 'vitest';
import { TestDb, errorOf, type Actor } from './harness';

let db: TestDb;
let hostId: string;
const ids: Record<string, string> = {};
const host = (aal: 'aal1' | 'aal2' = 'aal2'): Actor => ({ kind: 'user', id: hostId, aal });
const as = (name: string): Actor => ({ kind: 'user', id: ids[name]!, aal: 'aal1' });

function torontoLocal(days: number): string {
  const d = new Date(Date.now() + days * 86_400_000);
  return `${new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)}T19:30`;
}
async function newGame(extra: Record<string, unknown> = {}): Promise<string> {
  const [r] = await db.as<{ id: string }>(host(), 'select public.host_save_game_night($1::jsonb) as id', [
    JSON.stringify({ starts_local: torontoLocal(3), stakes: '$0.50/$1', seats: 3, address: '1 Private Rd', ...extra }),
  ]);
  return r!.id;
}
const addGuest = (game: string, name: string, status = 'confirmed') =>
  db.as<{ id: string }>(host(), 'select public.host_add_seat($1, null, $2, $3) as id', [game, name, status]);
const addMember = (game: string, who: string, status = 'confirmed', actor: Actor = host()) =>
  db.as<{ id: string }>(actor, 'select public.host_add_seat($1, $2, null, $3) as id', [game, ids[who], status]);
const night = async (actor: Actor, game: string) =>
  (await db.as<{ g: Record<string, any> }>(actor, 'select public.get_game_night($1) as g', [game]))[0]!.g;
const hostNight = async (game: string) =>
  (await db.as<{ g: Record<string, any> }>(host(), 'select public.host_get_game_night($1) as g', [game]))[0]!.g;
const seatOf = async (game: string, who: string) =>
  (await db.owner<{ id: string; status: string }>('select id, status from public.seat_requests where game_night_id = $1 and player_id = $2', [game, ids[who]]))[0];

beforeAll(async () => {
  db = await TestDb.create();
  hostId = await db.createUser('owner@example.com', 'owner1');
  await db.makeHost(hostId);
  for (const [name, user] of [['aric', 'AriC'], ['lebron', 'LeBron_James'], ['sarah', 'sarah'], ['mike', 'Michael']]) {
    ids[name] = await db.createUser(`${name}@example.com`, user!);
  }
}, 60_000);

describe('guests', () => {
  let game: string;
  beforeAll(async () => { game = await newGame({ seats: 4 }); });

  it('the host adds guests by real name; they are numbered per game', async () => {
    await addGuest(game, 'John Smith');
    await addGuest(game, 'Michael Brown');
    const g = await hostNight(game);
    const guests = g.requests.filter((r: any) => r.guest_number);
    expect(guests.map((r: any) => [r.guest_number, r.guest_name])).toEqual([[1, 'John Smith'], [2, 'Michael Brown']]);
  });

  it('duplicate guest names in the same game are refused', async () => {
    expect(await errorOf(addGuest(game, '  john smith '))).toMatch(/guest_already_added/);
    // The same person can be a guest at another game.
    await addGuest(await newGame(), 'John Smith');
  });

  it('members see "Guest N", never a real name, in any response', async () => {
    await addMember(game, 'aric');
    const g = await night(as('sarah'), game);
    expect(g.attendees.filter((a: any) => a.is_guest).map((a: any) => a.label)).toEqual(['Guest 1', 'Guest 2']);
    const everything = JSON.stringify([g, await db.as(as('sarah'), 'select * from public.list_game_nights()')]);
    expect(everything).not.toMatch(/John|Smith|Michael Brown|Brown/);
  });

  it('guest names are unreachable directly, even for the host through the API tables', async () => {
    for (const actor of [as('sarah'), host(), { kind: 'anon' } as Actor]) {
      expect(await errorOf(db.as(actor, 'select * from private.seat_guests'))).toMatch(/permission denied/);
      expect(await errorOf(db.as(actor, 'select * from public.seat_requests'))).toMatch(/permission denied/);
    }
    expect(await errorOf(db.as(as('sarah'), 'select public.host_get_game_night($1)', [game]))).toMatch(/not_authorized/);
    expect(await errorOf(db.as(host('aal1'), 'select public.host_get_game_night($1)', [game]))).toMatch(/mfa/);
  });

  it('numbers stay the same when a guest is renamed or another is removed', async () => {
    const g = await hostNight(game);
    const john = g.requests.find((r: any) => r.guest_number === 1);
    const mike = g.requests.find((r: any) => r.guest_number === 2);
    await db.as(host(), 'select public.host_rename_guest($1, $2)', [mike.id, 'Mike Brown']);
    await db.as(host(), 'select public.host_remove_seat($1)', [john.id]);
    await addGuest(game, 'David Johnson');
    const after = (await hostNight(game)).requests.filter((r: any) => r.guest_number);
    expect(after.map((r: any) => [r.guest_number, r.guest_name]).sort()).toEqual([[2, 'Mike Brown'], [3, 'David Johnson']]);
  });

  it('confirmed guests come into live game mode under their real name (host only)', async () => {
    await db.as(host(), 'select public.host_live_start($1)', [game]);
    const live = (await db.as<{ g: any }>(host(), 'select public.host_live_get($1) as g', [game]))[0]!.g;
    expect(live.players.map((p: any) => p.username ?? p.guest_label).sort()).toEqual(['AriC', 'David Johnson', 'Mike Brown']);
  });

  it('guest names are deleted 12 months after the game', async () => {
    await db.owner(`update public.game_nights set starts_at = now() - interval '13 months' where id = $1`, [game]);
    await db.owner('select private.purge_old_guest_names()');
    const g = await hostNight(game);
    expect(g.requests.filter((r: any) => r.guest_number).every((r: any) => r.guest_name === null)).toBe(true);
  });
});

describe('host-added members', () => {
  let game: string;
  beforeAll(async () => { game = await newGame({ seats: 2 }); });

  it('the host adds a registered player, who sees it on their games list', async () => {
    await addMember(game, 'aric');
    const rows = await db.as<{ game_night_id: string; my_status: string }>(as('aric'), 'select * from public.list_game_nights()');
    expect(rows.find((r) => r.game_night_id === game)!.my_status).toBe('confirmed');
  });

  it('no duplicates, and the host can change status or remove them', async () => {
    expect(await errorOf(addMember(game, 'aric'))).toMatch(/already_in_game/);
    expect(await errorOf(db.as(as('aric'), 'select public.request_seat($1)', [game]))).toMatch(/already_requested/);
    const seat = await seatOf(game, 'aric');
    await db.as(host(), `select public.host_decide_seat($1, 'waitlisted')`, [seat!.id]);
    expect((await seatOf(game, 'aric'))!.status).toBe('waitlisted');
    await db.as(host(), 'select public.host_remove_seat($1)', [seat!.id]);
    expect(await seatOf(game, 'aric')).toBeUndefined();
  });

  it('players cannot add, remove or move anyone, including themselves', async () => {
    expect(await errorOf(addMember(game, 'sarah', 'confirmed', as('sarah')))).toMatch(/not_authorized/);
    expect(await errorOf(addMember(game, 'aric', 'confirmed', as('sarah')))).toMatch(/not_authorized/);
    expect(await errorOf(db.as(as('sarah'), `select public.host_add_seat($1, null, 'Fake Guest', 'confirmed')`, [game]))).toMatch(/not_authorized/);
    await db.as(as('sarah'), 'select public.request_seat($1)', [game]);
    const seat = await seatOf(game, 'sarah');
    for (const sql of ['select public.host_remove_seat($1)', `select public.host_move_waitlist($1, 'up')`, `select public.host_decide_seat($1, 'confirmed')`]) {
      expect(await errorOf(db.as(as('sarah'), sql, [seat!.id]))).toMatch(/not_authorized/);
    }
    expect(await errorOf(db.as(as('sarah'), `update public.seat_requests set status = 'confirmed'`))).toMatch(/permission denied/);
    expect(await errorOf(db.as(as('sarah'), `update public.game_nights set seats = 99`))).toMatch(/permission denied/);
  });
});

describe('masked names', () => {
  it('other members see the first letter and five asterisks; you see your own name', async () => {
    const game = await newGame({ seats: 5 });
    for (const who of ['aric', 'lebron', 'sarah', 'mike']) await addMember(game, who);
    const seenBySarah = (await night(as('sarah'), game)).attendees;
    expect(seenBySarah.map((a: any) => a.label)).toEqual(['A*****', 'L*****', 'sarah', 'M*****']);
    expect(seenBySarah.find((a: any) => a.label === 'sarah').is_me).toBe(true);
    const raw = JSON.stringify(await night(as('sarah'), game));
    expect(raw).not.toMatch(/AriC|LeBron|Michael/);
    expect(raw).not.toMatch(/player_id|"id":"[0-9a-f-]{36}","label/); // no member ids for other players
    // The host sees full names.
    const full = (await hostNight(game)).requests.map((r: any) => r.username);
    expect(full).toEqual(expect.arrayContaining(['AriC', 'LeBron_James', 'sarah', 'Michael']));
  });

  it('only confirmed players are listed', async () => {
    const game = await newGame({ seats: 2 });
    await addMember(game, 'aric');
    await db.as(as('lebron'), 'select public.request_seat($1)', [game]);
    expect((await night(as('sarah'), game)).attendees.map((a: any) => a.label)).toEqual(['A*****']);
  });
});

describe('waitlist and capacity', () => {
  it('a full game puts new requests on the waitlist with a visible position', async () => {
    const game = await newGame({ seats: 2 });
    await addGuest(game, 'Table Filler');
    await addGuest(game, 'Second Filler');
    expect((await db.as<{ s: string }>(as('aric'), 'select public.request_seat($1) as s', [game]))[0]!.s).toBe('waitlisted');
    expect((await db.as<{ s: string }>(as('sarah'), 'select public.request_seat($1) as s', [game]))[0]!.s).toBe('waitlisted');
    expect(await night(as('sarah'), game)).toMatchObject({ my_status: 'waitlisted', my_waitlist_position: 2, waitlist_count: 2, confirmed_count: 2 });
    expect(await errorOf(addMember(game, 'mike', 'confirmed'))).toMatch(/game_full/);
  });

  it('the host can reorder the waitlist and move someone into a seat', async () => {
    const game = await newGame({ seats: 2 });
    await addGuest(game, 'Seat Taker');
    await addGuest(game, 'Other Guest');
    for (const who of ['aric', 'lebron', 'sarah']) await db.as(as(who), 'select public.request_seat($1)', [game]);
    const sarah = await seatOf(game, 'sarah');
    await db.as(host(), `select public.host_move_waitlist($1, 'up')`, [sarah!.id]);
    await db.as(host(), `select public.host_move_waitlist($1, 'up')`, [sarah!.id]);
    await db.as(host(), `select public.host_move_waitlist($1, 'up')`, [sarah!.id]); // already first: no-op
    expect(await night(as('sarah'), game)).toMatchObject({ my_waitlist_position: 1 });
    expect(await night(as('aric'), game)).toMatchObject({ my_waitlist_position: 2 });
    // With auto-fill off, a freed seat is NOT filled automatically.
    const taker = (await hostNight(game)).requests.find((r: any) => r.guest_name === 'Seat Taker');
    await db.as(host(), 'select public.host_remove_seat($1)', [taker.id]);
    expect((await seatOf(game, 'sarah'))!.status).toBe('waitlisted');
    await db.as(host(), `select public.host_decide_seat($1, 'confirmed')`, [sarah!.id]);
    expect((await seatOf(game, 'sarah'))!.status).toBe('confirmed');
  });

  it('with auto-fill on, a freed seat goes to the first on the waitlist', async () => {
    const game = await newGame({ seats: 2, auto_fill_waitlist: true });
    await addMember(game, 'aric');
    await addGuest(game, 'Filler');
    await db.as(as('sarah'), 'select public.request_seat($1)', [game]);
    await db.as(as('aric'), 'select public.cancel_my_seat($1)', [game]);
    expect((await seatOf(game, 'sarah'))!.status).toBe('confirmed');
  });

  it('simultaneous requests for the last seat cannot overbook', async () => {
    const game = await newGame({ seats: 2 });
    await addGuest(game, 'One');
    // Each request locks the game row; run them back to back in separate transactions.
    const results = await Promise.all(['aric', 'lebron', 'sarah'].map((w) => db.as<{ s: string }>(as(w), 'select public.request_seat($1) as s', [game])));
    expect(results.map((r) => r[0]!.s).sort()).toEqual(['requested', 'requested', 'requested']);
    // The host confirms: only one more fits.
    const seats = await db.owner<{ id: string }>(`select id from public.seat_requests where game_night_id = $1 and status = 'requested' order by queued_at`, [game]);
    await db.as(host(), `select public.host_decide_seat($1, 'confirmed')`, [seats[0]!.id]);
    expect(await errorOf(db.as(host(), `select public.host_decide_seat($1, 'confirmed')`, [seats[1]!.id]))).toMatch(/game_full/);
    const [c] = await db.owner<{ n: number }>(`select count(*)::int as n from public.seat_requests where game_night_id = $1 and status = 'confirmed'`, [game]);
    expect(c!.n).toBe(2);
  });

  it('a completed game is locked and shows as completed', async () => {
    const game = await newGame();
    await addMember(game, 'aric');
    await db.as(host(), 'select public.host_complete_game_night($1)', [game]);
    expect(await night(as('aric'), game)).toMatchObject({ status: 'completed', my_status: 'confirmed' });
    expect(await errorOf(addGuest(game, 'Late'))).toMatch(/game_night_closed_for_changes/);
    expect(await errorOf(db.as(as('sarah'), 'select public.request_seat($1)', [game]))).toMatch(/requests_closed/);
  });
});

describe('announcement', () => {
  it('the host posts it; members read it; nobody else can change it', async () => {
    await db.as(host(), `select public.host_set_announcement('Next game moved to Sunday.')`);
    expect((await db.as<{ a: string }>(as('sarah'), 'select public.get_announcement() as a'))[0]!.a).toBe('Next game moved to Sunday.');
    expect(await errorOf(db.as(as('sarah'), `select public.host_set_announcement('hacked')`))).toMatch(/not_authorized/);
    expect(await errorOf(db.as({ kind: 'anon' }, 'select public.get_announcement()'))).toMatch(/permission denied/);
    expect(await errorOf(db.as(host(), `select public.host_set_announcement($1)`, ['x'.repeat(281)]))).toMatch(/announcement_too_long/);
  });
});
