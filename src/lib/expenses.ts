/**
 * Host expense tracker: categories, form parsing and summaries.
 * Amounts are integer cents (BigInt) throughout.
 */
import { centsToJson, parseDollars, toCents } from './money';

export const CATEGORIES = [
  { value: 'food', label: 'Food' },
  { value: 'drinks', label: 'Non-alcoholic drinks' },
  { value: 'cards', label: 'Cards' },
  { value: 'equipment', label: 'Equipment' },
  { value: 'supplies', label: 'Supplies' },
  { value: 'other', label: 'Other' },
] as const;
export type Category = (typeof CATEGORIES)[number]['value'];
export const categoryLabel = (c: string) => CATEGORIES.find((x) => x.value === c)?.label ?? c;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ExpenseValues {
  id: string;
  spent_on: string;
  category: string;
  description: string;
  amount: string;
  session_id: string;
  reason: string;
}

export interface ExpensePayload {
  id?: string;
  session_id: string | null;
  spent_on: string;
  category: Category;
  description: string;
  amount_cents: number;
}

const str = (form: FormData, name: string, max: number) => {
  const v = form.get(name);
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
};

export function readExpenseValues(form: FormData): ExpenseValues {
  return {
    id: str(form, 'expense_id', 40),
    spent_on: str(form, 'spent_on', 10),
    category: str(form, 'category', 20),
    description: str(form, 'description', 200),
    amount: str(form, 'amount', 20),
    session_id: str(form, 'session_id', 40),
    reason: str(form, 'reason', 200),
  };
}

export function parseExpense(
  v: ExpenseValues,
  { isEdit, sessionIds }: { isEdit: boolean; sessionIds: Set<string> },
): { ok: true; payload: ExpensePayload } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v.spent_on) || Number.isNaN(Date.parse(v.spent_on))) {
    errors.spent_on = 'Choose the date of the purchase.';
  }
  if (!CATEGORIES.some((c) => c.value === v.category)) errors.category = 'Choose a category.';
  if (v.description.length < 2) errors.description = 'Describe what it was for (e.g. “Pizza for Friday”).';
  const amount = parseDollars(v.amount);
  if (!amount.ok) errors.amount = amount.error;
  else if (amount.cents <= 0n) errors.amount = 'Enter an amount above $0.';
  if (v.session_id && (!UUID_RE.test(v.session_id) || !sessionIds.has(v.session_id))) {
    errors.session_id = 'Choose a game from the list, or “Not linked to a game”.';
  }
  if (isEdit && !UUID_RE.test(v.id)) errors.form = 'This expense couldn’t be identified. Please reload.';
  if (isEdit && v.reason.length < 3) errors.reason = 'Give a short reason for this change (it goes in the audit log).';
  if (Object.keys(errors).length || !amount.ok) return { ok: false, errors };
  return {
    ok: true,
    payload: {
      ...(isEdit ? { id: v.id } : {}),
      session_id: v.session_id || null,
      spent_on: v.spent_on,
      category: v.category as Category,
      description: v.description,
      amount_cents: centsToJson(amount.cents),
    },
  };
}

export interface ExpenseRow {
  expense_id: string;
  spent_on: string;
  category: string;
  description: string;
  amount_cents: unknown;
  session_id: string | null;
  session_played_on: string | null;
  session_title: string | null;
  session_stakes: string | null;
}

export interface ExpenseSummary {
  total: bigint;
  count: number;
  byCategory: Array<{ category: string; label: string; total: bigint; count: number }>;
  byGame: Array<{ sessionId: string; playedOn: string; title: string | null; stakes: string | null; total: bigint; count: number }>;
  unlinkedTotal: bigint;
  averagePerGame: bigint | null;
}

export function summarize(rows: ExpenseRow[]): ExpenseSummary {
  let total = 0n;
  let unlinkedTotal = 0n;
  const cat = new Map<string, { total: bigint; count: number }>();
  const game = new Map<string, ExpenseSummary['byGame'][number]>();
  for (const r of rows) {
    const a = toCents(r.amount_cents);
    total += a;
    const c = cat.get(r.category) ?? { total: 0n, count: 0 };
    c.total += a;
    c.count++;
    cat.set(r.category, c);
    if (r.session_id) {
      const g = game.get(r.session_id) ?? {
        sessionId: r.session_id,
        playedOn: String(r.session_played_on ?? '').slice(0, 10),
        title: r.session_title,
        stakes: r.session_stakes,
        total: 0n,
        count: 0,
      };
      g.total += a;
      g.count++;
      game.set(r.session_id, g);
    } else {
      unlinkedTotal += a;
    }
  }
  const byGame = [...game.values()].sort((x, y) => (x.playedOn < y.playedOn ? 1 : -1));
  const linked = byGame.reduce((s, g) => s + g.total, 0n);
  return {
    total,
    count: rows.length,
    byCategory: CATEGORIES.filter((c) => cat.has(c.value)).map((c) => ({
      category: c.value,
      label: c.label,
      total: cat.get(c.value)!.total,
      count: cat.get(c.value)!.count,
    })),
    byGame,
    unlinkedTotal,
    // Integer division, rounded to the nearest cent.
    averagePerGame: byGame.length ? (linked * 2n + BigInt(byGame.length)) / (2n * BigInt(byGame.length)) : null,
  };
}
