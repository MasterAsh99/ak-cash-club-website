import { describe, expect, it } from 'vitest';
import { logStats, mentionsAkCashClub, minutesToInput, parseDuration, parseLogEntry, type LogRow, type LogValues } from '../../src/lib/poker-log';
import { paymentSummary, readPayments } from '../../src/lib/payments';

const base: LogValues = { id: '', played_on: '2026-10-25', venue: 'Casino Rama', game: '', format: 'cash', stakes: '$2/$5', buy_in: '500', cash_out: '810', duration: '4', notes: '' };

describe('poker log', () => {
  it('parses durations without floating point', () => {
    expect(parseDuration('4')).toEqual({ ok: true, minutes: 240 });
    expect(parseDuration('3.5')).toEqual({ ok: true, minutes: 210 });
    expect(parseDuration('3,25')).toEqual({ ok: true, minutes: 195 });
    expect(parseDuration('3:30')).toEqual({ ok: true, minutes: 210 });
    expect(parseDuration('')).toEqual({ ok: true, minutes: null });
    expect(parseDuration('0').ok).toBe(false);
    expect(parseDuration('3h').ok).toBe(false);
    expect(parseDuration('99').ok).toBe(false);
    expect(minutesToInput(210)).toBe('3:30');
  });

  it.each(['AK Cash Club', 'akcashclub', 'AK-Cash home game', 'the A.K. Club'])('recognises AK Cash Club (%s)', (v) => {
    expect(mentionsAkCashClub(v)).toBe(true);
  });
  it.each(['Casino Rama', 'PokerStars', 'Mike’s home game', 'Kakadu Club'])('does not flag %s', (v) => {
    expect(mentionsAkCashClub(v)).toBe(false);
  });

  it('builds a payload in cents and blocks AK Cash Club entries', () => {
    const ok = parseLogEntry(base, { isEdit: false });
    expect(ok).toMatchObject({ ok: true, payload: { buy_in_cents: 50000, cash_out_cents: 81000, duration_minutes: 240, game: 'No-Limit Texas Hold’em' } });
    const ak = parseLogEntry({ ...base, venue: 'AK Cash Club Friday' }, { isEdit: false });
    expect(ak.ok).toBe(false);
    if (!ak.ok) expect(ak.errors.venue).toMatch(/recorded by the host/);
  });

  it('calculates stats including hourly rate', () => {
    const row = (id: string, date: string, buy: number, cash: number, mins: number | null, format = 'cash'): LogRow => ({
      entry_id: id, played_on: date, venue: 'x', game: 'NLH', format, stakes: null,
      buy_in_cents: buy, cash_out_cents: cash, net_cents: cash - buy, duration_minutes: mins, notes: null,
    });
    const s = logStats([row('b', '2026-10-26', 20000, 0, null, 'tournament'), row('a', '2026-10-25', 50000, 81000, 240)]);
    expect(s.sessions).toBe(2);
    expect(s.lifetimeNet).toBe(11000n);
    expect(s.minutesPlayed).toBe(240);
    expect(s.hourly).toBe(7750n); // +$310 over 4h (untimed session excluded)
    expect(s.byFormat.map((f) => [f.format, f.net])).toEqual([['cash', 31000n], ['tournament', -20000n]]);
  });
});

describe('payments', () => {
  const A = '11111111-1111-4111-8111-111111111111';
  const B = '22222222-2222-4222-8222-222222222222';

  it('reads the form rows and checkboxes', () => {
    const f = new FormData();
    f.append('pay_result_id', A); f.append('pay_buy_in', 'cash'); f.append('pay_payout', 'etransfer'); f.set(`paid_${A}`, 'yes');
    f.append('pay_result_id', B); f.append('pay_buy_in', 'bitcoin'); f.append('pay_payout', '');
    f.append('pay_result_id', 'not-a-uuid'); f.append('pay_buy_in', 'cash'); f.append('pay_payout', 'cash');
    expect(readPayments(f)).toEqual([
      { result_id: A, buy_in_method: 'cash', payout_method: 'etransfer', payout_paid: true },
      { result_id: B, buy_in_method: null, payout_method: null, payout_paid: false },
    ]);
  });

  it('summarises outstanding payouts exactly', () => {
    const r = (out: number, paid: boolean, buyMethod: string | null = 'cash') => ({
      id: A, username: null, guest_label: 'g', total_buy_in_cents: 20000, cash_out_cents: out,
      buy_in_method: buyMethod, payout_method: null, payout_paid: paid, payout_paid_at: null,
    });
    expect(paymentSummary([r(45000, true), r(15050, false, null), r(0, false)])).toEqual({
      outstandingCents: 15050n, toPay: 1, paid: 1, unrecordedBuyIns: 1,
    });
  });
});
