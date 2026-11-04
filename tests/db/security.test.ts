/**
 * Database security tests. These run the real migration and act as different
 * users through the same roles/claims that the Supabase API uses, including
 * "direct API requests" a malicious player could craft by hand.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { TestDb, errorOf, type Actor } from './harness';

let db: TestDb;
let hostId: string;
let aliceId: string; // tracking ON
let bobId: string; // tracking ON
let carolId: string; // tracking OFF

const asHost = (aal: 'aal1' | 'aal2' = 'aal2'): Actor => ({ kind: 'user', id: hostId, aal });
const asUser = (id: string): Actor => ({ kind: 'user', id, aal: 'aal1' });

function sessionPayload(results: unknown[], extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    played_on: '2026-10-30',
    game_type: 'No-Limit Texas Hold’em',
    stakes: '$1/$2',
    title: 'Friday game',
    host_notes: 'Private host note',
    results,
    adjustments: [],
    ...extra,
  });
}

beforeAll(async () => {
  db = await TestDb.create();
  hostId = await db.createUser('owner@example.com', 'aaronk');
  await db.makeHost(hostId);
  aliceId = await db.createUser('alice@example.com', 'alice');
  bobId = await db.createUser('bob@example.com', 'Bob_99');
  carolId = await db.createUser('carol@example.com', 'carol');
  await db.as(asUser(aliceId), 'select public.set_my_tracking(true)');
  await db.as(asUser(bobId), 'select public.set_my_tracking(true)');
}, 60_000);

// ---------------------------------------------------------------------------
describe('usernames', () => {
  it('creates a profile from sign-up metadata', async () => {
    const rows = await db.owner<{ username: string }>('select username from public.profiles where id = $1', [aliceId]);
    expect(rows[0]?.username).toBe('alice');
  });

  it.each([
    'AK (host)', 'ak (host)', 'akhost', 'AKHOST', 'ak_host', 'AK-H0st', 'a.k.host', 'akh0st1',
    'TheAKHost', 'admin', 'Adm1n', 'administrator', 'AKCashClub', 'moderator', 'host', 'ak',
  ])('rejects reserved / impersonating name %s at sign-up', async (name) => {
    const err = await errorOf(db.createUser(`${Math.random()}@x.com`, name));
    expect(err).toMatch(/username_(reserved|invalid)/);
  });

  it.each(['ab', 'a'.repeat(21), 'has space', 'bad!char', '_leading', 'trailing.', 'dou..ble', 'émile', 'ａｌｉｃｅ'])(
    'rejects badly formatted name %s',
    async (name) => {
      const err = await errorOf(db.createUser(`${Math.random()}@x.com`, name));
      expect(err).toMatch(/username_invalid/);
    },
  );

  it('treats usernames case-insensitively', async () => {
    const err = await errorOf(db.createUser('alice2@example.com', 'ALICE'));
    expect(err).toMatch(/duplicate key|unique/i);
  });

  it('blocks look-alike duplicates (alice vs a1ice)', async () => {
    const err = await errorOf(db.createUser('alice3@example.com', 'a1ice'));
    expect(err).toMatch(/duplicate key|unique/i);
  });

  it('check_username reports status to anonymous visitors', async () => {
    const q = (n: string) => db.as<{ s: string }>({ kind: 'anon' }, 'select public.check_username($1) as s', [n]);
    expect((await q('newplayer'))[0]!.s).toBe('ok');
    expect((await q('Alice'))[0]!.s).toBe('taken');
    expect((await q('AK (host)'))[0]!.s).toBe('invalid');
    expect((await q('ak_host'))[0]!.s).toBe('reserved');
    expect((await q('x'))[0]!.s).toBe('invalid');
  });

  it('honours the host-managed blocked-terms list', async () => {
    await db.owner(`insert into public.blocked_username_terms (skeleton) values ('badword')`);
    const err = await errorOf(db.createUser('b@example.com', 'xx_BadWord_xx'));
    expect(err).toMatch(/username_blocked/);
  });

  it('a later blocked term does not lock an existing player out of their settings', async () => {
    const id = await db.createUser('dave@example.com', 'dave_rocks');
    await db.owner(`insert into public.blocked_username_terms (skeleton) values ('rocks')`);
    await db.as({ kind: 'user', id, aal: 'aal1' }, 'select public.set_my_tracking(true)');
    await db.as({ kind: 'user', id, aal: 'aal1' }, 'select public.set_my_tracking(false)');
    const err = await errorOf(db.as({ kind: 'user', id, aal: 'aal1' }, `select public.update_my_username('more_rocks')`));
    expect(err).toMatch(/username_blocked/);
    await db.as({ kind: 'user', id, aal: 'aal1' }, 'select public.delete_my_account()');
  });

  it('lets a player change their username, with the same rules', async () => {
    const [r] = await db.as<{ n: string }>(asUser(carolId), `select public.update_my_username('Carol.K') as n`);
    expect(r!.n).toBe('Carol.K');
    const err = await errorOf(db.as(asUser(carolId), `select public.update_my_username('bob_99')`));
    expect(err).toMatch(/duplicate key|unique/i);
  });
});

// ---------------------------------------------------------------------------
describe('host identity cannot be obtained through usernames', () => {
  it('renaming to "AK (host)" or a look-alike is refused', async () => {
    for (const name of ['AK (host)', 'AK_host', 'ak-h0st', 'AKH0ST']) {
      const err = await errorOf(db.as(asUser(aliceId), `select public.update_my_username($1)`, [name]));
      expect(err, name).toMatch(/username_(reserved|invalid)/);
    }
  });

  it('a player is never host, even with an aal2 (MFA) session', async () => {
    const [me] = await db.as<{ is_host: boolean }>({ kind: 'user', id: aliceId, aal: 'aal2' }, 'select * from public.my_access()');
    expect(me!.is_host).toBe(false);
    const err = await errorOf(
      db.as({ kind: 'user', id: aliceId, aal: 'aal2' }, `select public.host_list_players()`),
    );
    expect(err).toMatch(/not_authorized/);
  });

  it('the host profile is named "AK (host)" and cannot be renamed', async () => {
    const [p] = await db.owner<{ username: string }>('select username from public.profiles where id = $1', [hostId]);
    expect(p!.username).toBe('AK (host)');
    const err = await errorOf(db.as(asHost(), `select public.update_my_username('somebody')`));
    expect(err).toMatch(/host_name_is_fixed/);
  });

  it('players cannot read or write the host table', async () => {
    expect(await errorOf(db.as(asUser(aliceId), 'select * from private.host_account'))).toMatch(/permission denied/);
    expect(
      await errorOf(db.as(asUser(aliceId), 'insert into private.host_account (user_id) values ($1)', [aliceId])),
    ).toMatch(/permission denied/);
  });

  it('the host identity is immutable, even for the database owner', async () => {
    expect(await errorOf(db.owner('update private.host_account set user_id = $1', [aliceId]))).toMatch(
      /host_account_is_immutable/,
    );
    expect(await errorOf(db.owner(`insert into private.host_account (user_id) values ($1)`, [aliceId]))).toMatch(
      /duplicate key|unique/i,
    );
    expect(await errorOf(db.owner('delete from private.host_account'))).toMatch(/host_account_is_immutable/);
  });

  it('without MFA the host sees only their own profile through direct queries', async () => {
    const aal1 = await db.as<{ id: string }>(asHost('aal1'), 'select id from public.profiles');
    expect(aal1.map((r) => r.id)).toEqual([hostId]);
    const aal2 = await db.as<{ id: string }>(asHost('aal2'), 'select id from public.profiles');
    expect(aal2.length).toBe(4);
  });

  it('host functions require MFA (aal2)', async () => {
    const err = await errorOf(db.as(asHost('aal1'), `select public.host_list_players()`));
    expect(err).toMatch(/mfa_required/);
    const rows = await db.as(asHost('aal2'), `select * from public.host_list_players()`);
    expect(rows.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
describe('players cannot write financial data', () => {
  const directWrites = () => [
    `insert into public.game_sessions (played_on, stakes, created_by) values ('2026-01-01', '$1/$2', '${aliceId}')`,
    `insert into public.session_results (session_id, player_id, initial_buy_in_cents, cash_out_cents)
       select id, '${aliceId}', 100, 100000 from public.game_sessions limit 1`,
    `update public.session_results set cash_out_cents = 999999 where player_id = '${aliceId}'`,
    `delete from public.session_results where player_id = '${aliceId}'`,
    `update public.profiles set tracking_enabled = false where id = '${bobId}'`,
    `insert into public.audit_log (action, table_name) values ('insert', 'x')`,
    `delete from public.audit_log`,
    `insert into public.session_adjustments (session_id, amount_cents, reason) select id, 5, 'nope' from public.game_sessions limit 1`,
  ];

  it('direct table writes are denied', async () => {
    for (const sql of directWrites()) {
      const err = await errorOf(db.as(asUser(aliceId), sql));
      expect(err, sql).toMatch(/permission denied/);
    }
  });

  it('host functions are denied to players', async () => {
    const calls = [
      `select public.host_save_session('${sessionPayload([])}'::jsonb)`,
      `select public.host_list_sessions()`,
      `select public.host_get_audit()`,
      `select public.host_get_player_results('${bobId}')`,
      `select public.host_delete_session(gen_random_uuid(), 'x')`,
    ];
    for (const sql of calls) {
      expect(await errorOf(db.as(asUser(aliceId), sql)), sql).toMatch(/not_authorized/);
    }
  });

  it('anonymous visitors cannot call account or host functions', async () => {
    for (const sql of [
      'select * from public.my_access()',
      'select * from public.get_my_results()',
      'select public.host_list_players()',
      'select public.delete_my_account()',
    ]) {
      expect(await errorOf(db.as({ kind: 'anon' }, sql)), sql).toMatch(/permission denied/);
    }
  });
});

// ---------------------------------------------------------------------------
describe('host session management', () => {
  let sessionId: string;

  it('saves a session atomically and calculates net results in cents', async () => {
    const payload = sessionPayload(
      [
        { player_id: aliceId, initial_buy_in_cents: 20000, add_on_cents: [10000, 5000], cash_out_cents: 52550 },
        { player_id: bobId, initial_buy_in_cents: 20000, add_on_cents: [], cash_out_cents: 2450 },
        { guest_label: 'Guest 1', initial_buy_in_cents: 20000, add_on_cents: [], cash_out_cents: 0 },
      ],
      { adjustments: [{ amount_cents: -100, reason: 'Chip count rounding' }] },
    );
    const [r] = await db.as<{ id: string }>(asHost(), `select public.host_save_session($1::jsonb) as id`, [payload]);
    sessionId = r!.id;

    const rows = await db.owner<{ player_id: string | null; total_buy_in_cents: string; net_cents: string }>(
      'select player_id, total_buy_in_cents, net_cents from public.session_results where session_id = $1 order by net_cents desc',
      [sessionId],
    );
    expect(rows.map((x) => [Number(x.total_buy_in_cents), Number(x.net_cents)])).toEqual([
      [35000, 17550],
      [20000, -17550],
      [20000, -20000],
    ]);
  });

  it('reports reconciliation honestly (no forced zero)', async () => {
    const [s] = await db.as<{ total_net_cents: string; adjustments_cents: string; unexplained_cents: string }>(
      asHost(),
      'select * from public.host_list_sessions() where session_id = $1',
      [sessionId],
    );
    expect(Number(s!.total_net_cents)).toBe(-20000);
    expect(Number(s!.adjustments_cents)).toBe(-100);
    expect(Number(s!.unexplained_cents)).toBe(-20100);
  });

  it('writes an audit entry for every change, with the host as actor', async () => {
    const rows = await db.as<{ actor_id: string; table_name: string; action: string; reason: string }>(
      asHost(),
      'select * from public.host_get_audit($1)',
      [sessionId],
    );
    expect(rows.length).toBe(5); // session + 3 results + 1 adjustment
    expect(rows.every((r) => r.actor_id === hostId && r.action === 'insert')).toBe(true);
    expect(rows.every((r) => r.reason === 'Session created')).toBe(true);
  });

  it('requires a reason to edit, and audits old and new values', async () => {
    const full = (await db.as<{ s: { results: Array<Record<string, unknown>>; adjustments: unknown[] } }>(
      asHost(), 'select public.host_get_session($1) as s', [sessionId],
    ))[0]!.s;
    const results = full.results.map((r) => ({
      id: r.id, player_id: r.player_id, guest_label: r.guest_label,
      initial_buy_in_cents: r.initial_buy_in_cents, add_on_cents: r.add_on_cents,
      cash_out_cents: r.player_id === bobId ? 2550 : r.cash_out_cents,
    }));
    const payload = JSON.stringify({ id: sessionId, played_on: '2026-10-30', stakes: '$1/$2', results, adjustments: full.adjustments });

    expect(await errorOf(db.as(asHost(), 'select public.host_save_session($1::jsonb)', [payload]))).toMatch(
      /edit_reason_required/,
    );
    await db.as(asHost(), `select public.host_save_session($1::jsonb, 'Corrected Bob cash-out')`, [payload]);

    const [log] = await db.as<{ reason: string; old_data: { cash_out_cents: number }; new_data: { cash_out_cents: number } }>(
      asHost(),
      `select * from public.host_get_audit($1) where table_name = 'session_results' and action = 'update'`,
      [sessionId],
    );
    expect(log!.reason).toBe('Corrected Bob cash-out');
    expect(log!.old_data.cash_out_cents).toBe(2450);
    expect(log!.new_data.cash_out_cents).toBe(2550);
  });

  it('rolls back the whole save if any row is invalid', async () => {
    const before = await db.owner<{ n: string }>('select count(*) as n from public.game_sessions');
    const bad = sessionPayload([
      { player_id: aliceId, initial_buy_in_cents: 10000, add_on_cents: [], cash_out_cents: 0 },
      { player_id: bobId, initial_buy_in_cents: -5, add_on_cents: [], cash_out_cents: 0 },
    ]);
    expect(await errorOf(db.as(asHost(), 'select public.host_save_session($1::jsonb)', [bad]))).toMatch(/check constraint/);
    const after = await db.owner<{ n: string }>('select count(*) as n from public.game_sessions');
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it.each([
    ['duplicate player', 'dup', /duplicate key|unique/i],
    ['non-positive add-on', null, /check constraint/],
    ['fractional cents', 'frac', /invalid input syntax/],
  ])('rejects %s', async (_name, players, pattern) => {
    let results: unknown[];
    if (players === 'dup') {
      results = [aliceId, aliceId].map((p) => ({ player_id: p, initial_buy_in_cents: 100, add_on_cents: [], cash_out_cents: 100 }));
    } else if (players === 'frac') {
      results = [{ player_id: aliceId, initial_buy_in_cents: '100.5', add_on_cents: [], cash_out_cents: 100 }];
    } else {
      results = [{ player_id: aliceId, initial_buy_in_cents: 100, add_on_cents: [0], cash_out_cents: 100 }];
    }
    const err = await errorOf(db.as(asHost(), 'select public.host_save_session($1::jsonb)', [sessionPayload(results)]));
    expect(err).toMatch(pattern as RegExp);
  });

  it('will not associate results with a player who has not opted in', async () => {
    const payload = sessionPayload([{ player_id: carolId, initial_buy_in_cents: 100, add_on_cents: [], cash_out_cents: 0 }]);
    expect(await errorOf(db.as(asHost(), 'select public.host_save_session($1::jsonb)', [payload]))).toMatch(
      /player_not_tracking/,
    );
  });

  it('cannot record the host as a player', async () => {
    const payload = sessionPayload([{ player_id: hostId, initial_buy_in_cents: 100, add_on_cents: [], cash_out_cents: 0 }]);
    expect(await errorOf(db.as(asHost(), 'select public.host_save_session($1::jsonb)', [payload]))).toMatch(
      /host_cannot_be_player/,
    );
  });

  it('the audit log cannot be edited or deleted, even by the host', async () => {
    expect(await errorOf(db.as(asHost(), 'delete from public.audit_log'))).toMatch(/permission denied/);
    expect(await errorOf(db.as(asHost(), `update public.audit_log set reason = 'x'`))).toMatch(/permission denied/);
  });
});

// ---------------------------------------------------------------------------
describe('privacy between players', () => {
  it('a player sees only their own results', async () => {
    const mine = await db.as<{ net_cents: string }>(asUser(aliceId), 'select * from public.get_my_results()');
    expect(mine.length).toBe(1);
    expect(Number(mine[0]!.net_cents)).toBe(17550);

    const direct = await db.as<{ player_id: string }>(asUser(aliceId), 'select player_id from public.session_results');
    expect(direct.every((r) => r.player_id === aliceId)).toBe(true);
    expect(direct.length).toBe(1);
  });

  it('a player cannot see other profiles, adjustments, the audit log or host notes', async () => {
    const profiles = await db.as<{ id: string }>(asUser(aliceId), 'select id from public.profiles');
    expect(profiles.map((p) => p.id)).toEqual([aliceId]);
    expect(await db.as(asUser(aliceId), 'select * from public.session_adjustments')).toEqual([]);
    expect(await db.as(asUser(aliceId), 'select * from public.audit_log')).toEqual([]);
    expect(await errorOf(db.as(asUser(aliceId), 'select host_notes from public.game_sessions'))).toMatch(
      /permission denied/,
    );
    const visible = await db.as(asUser(aliceId), 'select id, played_on, stakes from public.game_sessions');
    expect(visible.length).toBe(1);
  });

  it('a player who never opted in sees nothing', async () => {
    expect(await db.as(asUser(carolId), 'select * from public.get_my_results()')).toEqual([]);
    expect(await db.as(asUser(carolId), 'select id, net_cents from public.session_results')).toEqual([]);
    expect(await db.as(asUser(carolId), 'select id, played_on, stakes from public.game_sessions')).toEqual([]);
  });

  it('turning tracking off hides results immediately; turning it on shows them again', async () => {
    await db.as(asUser(bobId), 'select public.set_my_tracking(false)');
    expect(await db.as(asUser(bobId), 'select * from public.get_my_results()')).toEqual([]);
    expect(await db.as(asUser(bobId), 'select id, net_cents from public.session_results')).toEqual([]);
    await db.as(asUser(bobId), 'select public.set_my_tracking(true)');
    expect((await db.as(asUser(bobId), 'select * from public.get_my_results()')).length).toBe(1);
  });

  it('consent changes are audited', async () => {
    const rows = await db.as<{ record_id: string }>(
      asHost(),
      `select * from public.host_get_audit() where table_name = 'profiles' and record_id = $1`,
      [bobId],
    );
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
describe('data removal', () => {
  it('unlinking history detaches results but keeps the table reconcilable', async () => {
    const [r] = await db.as<{ n: number }>(asUser(bobId), 'select public.unlink_my_history() as n');
    expect(r!.n).toBe(1);
    expect(await db.as(asUser(bobId), 'select * from public.get_my_results()')).toEqual([]);
    const rows = await db.owner<{ guest_label: string }>(
      `select guest_label from public.session_results where guest_label = 'Unlinked member'`,
    );
    expect(rows.length).toBe(1);
  });

  it('deleting an account removes the user and detaches their results', async () => {
    await db.as(asUser(aliceId), 'select public.delete_my_account()');
    expect(await db.owner('select 1 from auth.users where id = $1', [aliceId])).toEqual([]);
    expect(await db.owner('select 1 from public.profiles where id = $1', [aliceId])).toEqual([]);
    const rows = await db.owner(`select 1 from public.session_results where guest_label = 'Removed account'`);
    expect(rows.length).toBe(1);
  });

  it('the host cannot delete the host account from the app', async () => {
    expect(await errorOf(db.as(asHost(), 'select public.delete_my_account()'))).toMatch(/host_cannot_self_delete/);
  });

  it('a player cannot delete someone else', async () => {
    await db.as(asUser(carolId), 'select public.delete_my_account()');
    expect((await db.owner('select 1 from auth.users where id = $1', [bobId])).length).toBe(1);
  });
});
