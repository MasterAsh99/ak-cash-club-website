import { describe, expect, it } from 'vitest';
import { parseExpense, summarize, type ExpenseRow, type ExpenseValues } from '../../src/lib/expenses';

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const base: ExpenseValues = { id: '', spent_on: '2026-10-30', category: 'food', description: 'Pizza', amount: '64.50', session_id: '', reason: '' };

describe('expense form', () => {
  it('parses a valid expense into integer cents', () => {
    const r = parseExpense({ ...base, session_id: S1 }, { isEdit: false, sessionIds: new Set([S1]) });
    expect(r).toEqual({ ok: true, payload: { session_id: S1, spent_on: '2026-10-30', category: 'food', description: 'Pizza', amount_cents: 6450 } });
  });

  it.each([
    ['amount', { amount: '0' }],
    ['amount', { amount: '-5' }],
    ['amount', { amount: '1.234' }],
    ['category', { category: 'rake' }],
    ['description', { description: 'x' }],
    ['spent_on', { spent_on: 'yesterday' }],
    ['session_id', { session_id: S2 }],
  ])('flags %s', (key, extra) => {
    const r = parseExpense({ ...base, ...extra }, { isEdit: false, sessionIds: new Set([S1]) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[key]).toBeDefined();
  });

  it('requires a reason when editing', () => {
    const r = parseExpense({ ...base, id: S1 }, { isEdit: true, sessionIds: new Set() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.reason).toBeDefined();
  });
});

describe('expense summary', () => {
  const row = (amount: number, category: string, session: string | null, date = '2026-10-30'): ExpenseRow => ({
    expense_id: Math.random().toString(), spent_on: date, category, description: 'x', amount_cents: amount,
    session_id: session, session_played_on: session ? date : null, session_title: null, session_stakes: '$1/$2',
  });

  it('totals by category and by game exactly', () => {
    const s = summarize([row(6450, 'food', S1), row(1299, 'drinks', S1), row(2001, 'food', S2, '2026-10-16'), row(10899, 'cards', null)]);
    expect(s.total).toBe(20649n);
    expect(s.count).toBe(4);
    expect(s.unlinkedTotal).toBe(10899n);
    expect(s.byCategory.map((c) => [c.category, c.total])).toEqual([['food', 8451n], ['drinks', 1299n], ['cards', 10899n]]);
    expect(s.byGame.map((g) => [g.sessionId, g.total])).toEqual([[S1, 7749n], [S2, 2001n]]);
    expect(s.averagePerGame).toBe(4875n); // (7749 + 2001) / 2 = 4875
  });

  it('is empty without fabricated values', () => {
    const s = summarize([]);
    expect(s.total).toBe(0n);
    expect(s.averagePerGame).toBeNull();
    expect(s.byCategory).toEqual([]);
  });
});
