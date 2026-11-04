/** Host payment tracking: how each player paid in, how they were paid out, and whether it's done. */
import { toCents } from './money';

export const METHODS = [
  { value: 'cash', label: 'Cash' },
  { value: 'etransfer', label: 'E-transfer' },
  { value: 'mixed', label: 'Mixed' },
] as const;
export const methodLabel = (m: string | null | undefined) => METHODS.find((x) => x.value === m)?.label ?? '—';

export interface PaymentRowIn {
  id: string;
  username: string | null;
  guest_label: string | null;
  total_buy_in_cents: unknown;
  cash_out_cents: unknown;
  buy_in_method: string | null;
  payout_method: string | null;
  payout_paid: boolean;
  payout_paid_at: string | null;
}

export interface PaymentUpdate {
  result_id: string;
  buy_in_method: string | null;
  payout_method: string | null;
  payout_paid: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const okMethod = (v: string) => (METHODS.some((m) => m.value === v) ? v : null);

/** Read the payments form: parallel lists + one checkbox per row named paid_<id>. */
export function readPayments(form: FormData): PaymentUpdate[] {
  const ids = form.getAll('pay_result_id').map(String);
  const buy = form.getAll('pay_buy_in').map(String);
  const out = form.getAll('pay_payout').map(String);
  const rows: PaymentUpdate[] = [];
  ids.slice(0, 60).forEach((id, i) => {
    if (!UUID_RE.test(id)) return;
    rows.push({
      result_id: id,
      buy_in_method: okMethod(buy[i] ?? ''),
      payout_method: okMethod(out[i] ?? ''),
      payout_paid: form.get(`paid_${id}`) === 'yes',
    });
  });
  return rows;
}

export function paymentSummary(rows: PaymentRowIn[]) {
  let owed = 0n;
  let toPay = 0;
  let paid = 0;
  let unrecordedBuyIns = 0;
  for (const r of rows) {
    const out = toCents(r.cash_out_cents);
    if (out > 0n) {
      if (r.payout_paid) paid++;
      else {
        toPay++;
        owed += out;
      }
    }
    if (!r.buy_in_method && toCents(r.total_buy_in_cents) > 0n) unrecordedBuyIns++;
  }
  return { outstandingCents: owed, toPay, paid, unrecordedBuyIns };
}
