import { describe, expect, it } from 'vitest';
import { ALL_CARDS, cardLabel, cardName, readHandForm, validateHand, type HandValues } from '../../src/lib/cards';
import { applyFilters, combine, combinedStats, filterOptions, filtersQuery, readFilters } from '../../src/lib/combined';

const hand = (o: Partial<HandValues> = {}): HandValues => ({
  id: '', played_on: '2026-11-01', title: 'Hero call', stakes: '$1/$2', position: 'BTN',
  hole: ['As', 'Kd'], board: ['Ah', '7c', '2d', '', ''], notes: '', ...o,
});

describe('cards', () => {
  it('has 52 unique cards with readable labels', () => {
    expect(new Set(ALL_CARDS).size).toBe(52);
    expect(cardLabel('Td')).toBe('10♦');
    expect(cardName('As')).toBe('Ace of spades');
  });
  it('validates hands', () => {
    expect(validateHand(hand())).toMatchObject({ ok: true, payload: { hole_cards: ['As', 'Kd'], board: ['Ah', '7c', '2d'] } });
    expect(validateHand(hand({ hole: ['As', ''] }))).toMatchObject({ ok: false });
    expect(validateHand(hand({ board: ['Ah', '7c', '', '', ''] }))).toMatchObject({ ok: false });
    expect(validateHand(hand({ board: ['Ah', '7c', '2d', '', '9h'] }))).toMatchObject({ ok: false });
    expect(validateHand(hand({ board: ['As', '7c', '2d', '', ''] }))).toMatchObject({ ok: false, errors: { cards: expect.stringMatching(/twice/) } });
    expect(validateHand(hand({ hole: ['', ''], board: ['', '', '', '', ''] }))).toMatchObject({ ok: true });
    expect(validateHand(hand({ title: '' }))).toMatchObject({ ok: false, errors: { title: expect.any(String) } });
  });
  it('reads the form', () => {
    const f = new FormData();
    f.set('played_on', '2026-11-01'); f.set('title', ' x '); f.set('hole_0', 'As'); f.set('board_2', '2d');
    expect(readHandForm(f)).toMatchObject({ title: 'x', hole: ['As', ''], board: ['', '', '2d', '', ''] });
  });
});

describe('combined results', () => {
  const ak = [{ session_id: 's1', played_on: '2026-10-30', game_type: 'NLH', stakes: '$1/$2', title: null, total_buy_in_cents: 35000, cash_out_cents: 52550, net_cents: 17550 }];
  const log = [
    { entry_id: 'l1', played_on: '2026-10-18', venue: 'Casino Rama', game: 'NLH', format: 'cash', stakes: '$2/$5', buy_in_cents: 50000, cash_out_cents: 81000, net_cents: 31000, duration_minutes: 240, notes: null },
    { entry_id: 'l2', played_on: '2026-11-01', venue: 'PokerStars', game: 'NLH', format: 'tournament', stakes: null, buy_in_cents: 5500, cash_out_cents: 0, net_cents: -5500, duration_minutes: null, notes: null },
  ];
  const rows = combine(ak, log);

  it('merges newest first, labelling the source', () => {
    expect(rows.map((r) => [r.id, r.source])).toEqual([['l2', 'outside'], ['s1', 'ak'], ['l1', 'outside']]);
    expect(filterOptions(rows)).toEqual({ stakes: ['$1/$2', '$2/$5'], venues: ['AK Cash Club', 'Casino Rama', 'PokerStars'] });
  });

  it('adds up exactly, with an hourly rate from timed games only', () => {
    const s = combinedStats(rows);
    expect(s.lifetimeNet).toBe(43050n);
    expect(s.hourly).toBe(7750n); // 31000 over 4 hours
    expect(s.bySource.ak).toEqual({ sessions: 1, net: 17550n });
  });

  it('filters by date, source, stakes, venue and format', () => {
    const f = (q: string) => applyFilters(rows, readFilters(new URLSearchParams(q))).map((r) => r.id);
    expect(f('from=2026-10-20')).toEqual(['l2', 's1']);
    expect(f('to=2026-10-30&source=outside')).toEqual(['l1']);
    expect(f('stakes=$2/$5')).toEqual(['l1']);
    expect(f('venue=AK Cash Club')).toEqual(['s1']);
    expect(f('format=tournament')).toEqual(['l2']);
    expect(f('from=garbage&source=nope')).toEqual(['l2', 's1', 'l1']);
    expect(filtersQuery(readFilters(new URLSearchParams('source=ak&from=2026-01-01')))).toBe('?from=2026-01-01&source=ak');
  });
});

import { limitStatus } from '../../src/lib/wellbeing';
import { renderNotification } from '../../src/lib/notify-email';

describe('responsible play', () => {
  const w = (limit: number | null, net: number, reached = false) => ({
    loss_limit_cents: limit, pending_limit_change: false, pending_limit_cents: null, pending_effective_at: null,
    month_net_cents: net, limit_reached: reached, session_reminder_minutes: null, break_until: null,
  });
  it('reports how much of the limit is used', () => {
    expect(limitStatus(w(null, -5000))).toBeNull();
    expect(limitStatus(w(30000, 5000))).toMatchObject({ lost: 0n, pct: 0, level: 'ok' });
    expect(limitStatus(w(30000, -24000))).toMatchObject({ lost: 24000n, pct: 80, level: 'near' });
    expect(limitStatus(w(30000, -45000, true))).toMatchObject({ pct: 100, level: 'reached' });
  });
  it('session reminder email links to the right unsubscribe and mentions help', () => {
    const e = renderNotification({ notification_id: 'x', kind: 'session_reminder', email: 'a@b.c', username: 'alice', unsubscribe_token: 'a'.repeat(64), payload: { minutes: 240 } }, 'https://akcashclub.com')!;
    expect(e.subject).toBe('You’ve been playing for 4 hours');
    expect(e.unsubscribeUrl).toContain('k=session_reminders');
    expect(e.text).toContain('1-866-531-2600');
  });
});
