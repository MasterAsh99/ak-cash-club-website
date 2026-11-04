/** Responsible-play settings (set by each member, private to them). */
import { toCents } from './money';

export interface Wellbeing {
  loss_limit_cents: unknown;
  pending_limit_change: boolean;
  pending_limit_cents: unknown;
  pending_effective_at: string | null;
  month_net_cents: unknown;
  limit_reached: boolean;
  session_reminder_minutes: number | null;
  break_until: string | null;
}

export const REMINDER_OPTIONS = [120, 180, 240, 300, 360] as const;
export const BREAK_OPTIONS = [1, 7, 30, 90] as const;

export const HELP = {
  name: 'ConnexOntario',
  phone: '1-866-531-2600',
  text: 'Text CONNEX to 247247',
  url: 'https://www.connexontario.ca',
  note: 'Free, confidential and available 24/7 across Ontario.',
};

/** How much of the monthly loss limit has been used. */
export function limitStatus(w: Wellbeing | null): null | { limit: bigint; lost: bigint; pct: number; level: 'ok' | 'near' | 'reached' } {
  if (!w || w.loss_limit_cents === null || w.loss_limit_cents === undefined) return null;
  const limit = toCents(w.loss_limit_cents);
  const net = toCents(w.month_net_cents);
  const lost = net < 0n ? -net : 0n;
  const pct = limit > 0n ? Number((lost * 100n) / limit) : 0;
  return { limit, lost, pct: Math.min(pct, 100), level: w.limit_reached || lost >= limit ? 'reached' : pct >= 75 ? 'near' : 'ok' };
}

export function onBreak(w: Wellbeing | null): boolean {
  return Boolean(w?.break_until && new Date(w.break_until) > new Date());
}
