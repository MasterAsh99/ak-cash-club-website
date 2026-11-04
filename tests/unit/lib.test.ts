import { describe, expect, it } from 'vitest';
import {
  centsToInput, divRound, formatCents, parseAddOns, parseDollars, parseSignedDollars, toCents,
} from '../../src/lib/money';
import { computeStats, type ResultRow } from '../../src/lib/stats';
import { buildChart } from '../../src/lib/chart';
import { passwordProblem, usernameProblem, usernameSkeleton } from '../../src/lib/validation';
import { parseSession, readSessionValues } from '../../src/lib/session-form';
import { safeNext } from '../../src/lib/access';

describe('money', () => {
  it.each([
    ['200', 20000n], ['200.5', 20050n], ['200.05', 20005n], ['$1,250.75', 125075n], ['0', 0n], [' 15 ', 1500n],
    ['1000000', 100000000n],
  ])('parses %s', (input, cents) => {
    expect(parseDollars(input)).toEqual({ ok: true, cents });
  });

  it.each(['-5', '1.234', 'abc', '1,25', '1e3', '$', '1000000.01', '0x10', '12,34,567'])('rejects %s', (input) => {
    expect(parseDollars(input).ok).toBe(false);
  });

  it('parses rebuy lists', () => {
    expect(parseAddOns('100 + 50')).toEqual({ ok: true, cents: [10000n, 5000n] });
    expect(parseAddOns('1,000; 25.50\n10')).toEqual({ ok: true, cents: [100000n, 2550n, 1000n] });
    expect(parseAddOns('')).toEqual({ ok: true, cents: [] });
    expect(parseAddOns('100 + 0').ok).toBe(false);
    expect(parseAddOns('100 + x').ok).toBe(false);
  });

  it('parses signed adjustments, never zero', () => {
    expect(parseSignedDollars('-25')).toEqual({ ok: true, cents: -2500n });
    expect(parseSignedDollars('−1.50')).toEqual({ ok: true, cents: -150n });
    expect(parseSignedDollars('0').ok).toBe(false);
  });

  it('formats CAD exactly', () => {
    expect(formatCents(125075n)).toBe('$1,250.75');
    expect(formatCents(-1755n, { signed: true })).toBe('−$17.55');
    expect(formatCents(1755n, { signed: true })).toBe('+$17.55');
    expect(formatCents(0n, { signed: true })).toBe('$0.00');
    expect(formatCents(900719925474099300n)).toBe('$9,007,199,254,740,993.00');
    expect(formatCents(50000n, { compact: true })).toBe('$500');
  });

  it('round-trips editable input', () => {
    expect(centsToInput(125075n)).toBe('1250.75');
    expect(centsToInput(20000n)).toBe('200');
    expect(centsToInput(-150n)).toBe('-1.50');
  });

  it('rounds averages half away from zero with integers only', () => {
    expect(divRound(10n, 4n)).toBe(3n); // 2.5 -> 3
    expect(divRound(-10n, 4n)).toBe(-3n);
    expect(divRound(10n, 3n)).toBe(3n);
    expect(divRound(-11n, 3n)).toBe(-4n);
  });

  it('rejects unsafe numbers from the database', () => {
    expect(() => toCents(2 ** 60)).toThrow();
    expect(() => toCents(1.5)).toThrow();
    expect(toCents('-42')).toBe(-42n);
  });
});

const row = (date: string, buy: number, cash: number, id = date): ResultRow => ({
  session_id: id, played_on: date, stakes: '$1/$2', title: null,
  total_buy_in_cents: buy, cash_out_cents: cash, net_cents: cash - buy,
});

describe('stats', () => {
  // newest first, as the database returns them
  const rows = [
    row('2026-10-30', 30000, 10000),
    row('2026-10-23', 20000, 55050),
    row('2026-10-16', 20000, 20000),
    row('2026-10-09', 35000, 0),
  ];
  const s = computeStats(rows);

  it('calculates the requested statistics exactly', () => {
    expect(s.sessions).toBe(4);
    expect(s.totalBuyIns).toBe(105000n);
    expect(s.totalCashOuts).toBe(85050n);
    expect(s.lifetimeNet).toBe(-19950n);
    expect(s.averageNet).toBe(-4988n); // -4987.5 -> -4988
    expect(s.biggestWin?.net).toBe(35050n);
    expect(s.biggestLoss?.net).toBe(-35000n);
    expect(s.winningSessions).toBe(1);
    expect(s.losingSessions).toBe(2);
  });

  it('builds a chronological running total', () => {
    expect(s.cumulative.map((c) => c.total)).toEqual([-35000n, -35000n, 50n, -19950n]);
    expect(s.recent[0]!.playedOn).toBe('2026-10-30');
  });

  it('has no fabricated values when empty', () => {
    const e = computeStats([]);
    expect(e.sessions).toBe(0);
    expect(e.averageNet).toBeNull();
    expect(e.biggestWin).toBeNull();
    expect(e.biggestLoss).toBeNull();
    expect(buildChart(e)).toBeNull();
  });

  it('refuses inconsistent rows', () => {
    expect(() => computeStats([{ ...row('2026-01-01', 100, 200), net_cents: 999 }])).toThrow();
  });

  it('builds chart geometry including break-even', () => {
    const chart = buildChart(s)!;
    expect(chart.points).toHaveLength(4);
    expect(chart.yTicks.some((t) => t.label === '$0')).toBe(true);
    expect(chart.points[3]!.label).toContain('−$199.50');
    expect(chart.linePath.startsWith('M')).toBe(true);
  });
});

describe('usernames and passwords', () => {
  it('mirrors the database skeleton', () => {
    expect(usernameSkeleton('AK (host)')).toBe('akhost');
    expect(usernameSkeleton('AK-H0st')).toBe('akhost');
    expect(usernameSkeleton('a1ice')).toBe('allce');
    expect(usernameSkeleton('alice')).toBe('allce');
  });

  it.each(['AK (host)', 'ak_host', 'AKH0ST', 'admin', 'xx_admin', 'ak'])('flags %s', (n) => {
    expect(usernameProblem(n)).not.toBeNull();
  });

  it('accepts ordinary names', () => {
    expect(usernameProblem('Bob_99')).toBeNull();
    expect(usernameProblem('carol.k')).toBeNull();
  });

  it('applies the password policy', () => {
    expect(passwordProblem('short')).toMatch(/10 characters/);
    expect(passwordProblem('aaaaaaaaaaaa')).toMatch(/predictable/);
    expect(passwordProblem('bobsmith-secret', { email: 'bobsmith@x.com' })).toMatch(/email/);
    expect(passwordProblem('correct horse battery')).toBeNull();
  });

  it('only allows safe post-login redirects', () => {
    expect(safeNext('/host/sessions/new')).toBe('/host/sessions/new');
    expect(safeNext('/games/123e4567-e89b-12d3-a456-426614174000')).toBe('/games/123e4567-e89b-12d3-a456-426614174000');
    expect(safeNext('/')).toBe('/');
    expect(safeNext('/?notice=verified')).toBe('/?notice=verified');
    expect(safeNext('/gamesx')).toBe('/');
    expect(safeNext('/games/../../x')).toBe('/');
    expect(safeNext('//evil.com')).toBe('/');
    expect(safeNext('https://evil.com')).toBe('/');
    expect(safeNext('/\\evil.com')).toBe('/');
    expect(safeNext('/login')).toBe('/');
  });
});

describe('host session form', () => {
  const alice = '11111111-1111-4111-8111-111111111111';
  const bob = '22222222-2222-4222-8222-222222222222';
  const players = new Map([
    [alice, { username: 'alice', tracked: true }],
    [bob, { username: 'bob', tracked: true }],
  ]);

  function form(rows: string[][], extra: Record<string, string> = {}) {
    const f = new FormData();
    f.set('played_on', '2026-10-30');
    f.set('stakes', '$1/$2');
    for (const [k, v] of Object.entries(extra)) f.set(k, v);
    for (const [player, guest, initial, addons, cashout] of rows) {
      f.append('row_id', '');
      f.append('row_player', player!);
      f.append('row_guest', guest!);
      f.append('row_initial', initial!);
      f.append('row_addons', addons!);
      f.append('row_cashout', cashout!);
    }
    return f;
  }

  it('calculates a preview and an integer-cents payload', () => {
    const values = readSessionValues(form([
      [alice, '', '200', '100 + 50', '525.50'],
      [bob, '', '200', '', '24.50'],
      ['guest', 'Guest 1', '200', '', '0'],
      ['', '', '', '', ''], // blank row ignored
    ], { adj_amount: '-1', adj_reason: 'Rounding' }));
    const out = parseSession(values, players, { isEdit: false });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.payload.results).toHaveLength(3);
    expect(out.payload.results[0]).toMatchObject({ player_id: alice, initial_buy_in_cents: 20000, add_on_cents: [10000, 5000], cash_out_cents: 52550 });
    expect(out.preview.rows.map((r) => r.net)).toEqual([17550n, -17550n, -20000n]);
    expect(out.preview.totalNet).toBe(-20000n);
    expect(out.preview.adjustmentsTotal).toBe(-100n);
    expect(out.preview.unexplained).toBe(-20100n);
  });

  it('reports row-level problems', () => {
    const values = readSessionValues(form([
      [alice, '', '200', '', '10'],
      [alice, '', 'x', '', '10'],
      ['guest', '', '5', '', '1'],
      ['not-a-player', '', '5', '', '1'],
    ]));
    const out = parseSession(values, players, { isEdit: false });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.errors.row_1_player).toMatch(/more than once/);
    expect(out.errors.row_1_initial).toBeDefined();
    expect(out.errors.row_2_guest).toBeDefined();
    expect(out.errors.row_3_player).toBeDefined();
  });

  it('requires a reason when editing', () => {
    const values = readSessionValues(form([[alice, '', '1', '', '1']], { session_id: '33333333-3333-4333-8333-333333333333' }));
    const out = parseSession(values, players, { isEdit: true });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.errors.reason).toBeDefined();
  });

  it('requires at least one player', () => {
    const out = parseSession(readSessionValues(form([])), players, { isEdit: false });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.errors.rows).toBeDefined();
  });
});
