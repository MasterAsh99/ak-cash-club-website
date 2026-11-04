import { describe, expect, it } from 'vitest';
import { formatGameTime, formatLocalGameTime, parseGameNightForm, seatsLeft, torontoDate } from '../../src/lib/games';

const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

describe('game night helpers', () => {
  it('formats times in Toronto time', () => {
    // 00:30 UTC on Nov 7 is 7:30 p.m. on Nov 6 in Toronto (EST).
    expect(formatGameTime('2026-11-07T00:30:00Z')).toBe('Friday, November 6 at 7:30 p.m.');
    expect(formatGameTime('2026-11-07T00:30:00Z', 'short')).toBe('Fri, Nov 6 at 7:30 p.m.');
    expect(formatLocalGameTime('2026-11-06T19:30')).toBe('Friday, November 6 at 7:30 p.m.');
    expect(torontoDate('2026-11-07T00:30:00Z')).toBe('2026-11-06');
  });

  it('counts seats left, never below zero', () => {
    expect(seatsLeft({ seats: 8, confirmed_count: 5 })).toBe(3);
    expect(seatsLeft({ seats: 8, confirmed_count: 9 })).toBe(0);
  });

  it('parses a valid form', () => {
    const { values, errors } = parseGameNightForm(fd({ date: '2026-11-06', time: '19:30', stakes: ' $1/$2 ', seats: '8', address: '1 Main St', announce: 'yes' }));
    expect(errors).toEqual({});
    expect(values).toMatchObject({ starts_local: '2026-11-06T19:30', stakes: '$1/$2', seats: 8, status: 'open', announce: true });
  });

  it('reports each problem', () => {
    const { errors } = parseGameNightForm(fd({ date: 'nope', time: '25:00', stakes: '', seats: '1', address: '' }));
    expect(Object.keys(errors).sort()).toEqual(['address', 'date', 'seats', 'stakes', 'time']);
    expect(parseGameNightForm(fd({ date: '2026-11-06', time: '19:30', stakes: 'x', seats: '8.5', address: 'a' })).errors.seats).toBeDefined();
  });
});

import { liveTotals, playerTotals, type LivePlayer } from '../../src/lib/live';

describe('live totals', () => {
  const p = (buyins: Array<[number, 'cash' | 'etransfer']>, out: number | null = null, method: 'cash' | 'etransfer' | null = null): LivePlayer => ({
    id: Math.random().toString(), player_id: null, username: 'x', tracking_enabled: false, guest_label: null,
    checked_in_at: '2026-11-06T00:00:00Z', cash_out_cents: out, payout_method: method,
    buyins: buyins.map(([c, m], i) => ({ id: String(i), amount_cents: c, method: m, created_at: '' })),
  });

  it('adds up exactly in cents, by method', () => {
    const t = liveTotals([p([[20000, 'cash'], [10010, 'etransfer']], 45020, 'etransfer'), p([[20000, 'cash']]), p([], null)]);
    expect(t).toMatchObject({ buyIns: 50010n, cashOuts: 45020n, inPlay: 4990n, cashIn: 40000n, etransferIn: 10010n, etransferOut: 45020n, cashOut: 0n, checkedIn: 3, stillPlaying: 1 });
  });

  it('per-player net is null until cashed out', () => {
    expect(playerTotals(p([[20000, 'cash']]))).toEqual({ buyIn: 20000n, cashOut: null, net: null });
    expect(playerTotals(p([[20000, 'cash']], 5, 'cash')).net).toBe(-19995n);
  });
});
