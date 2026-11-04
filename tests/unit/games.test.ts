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
