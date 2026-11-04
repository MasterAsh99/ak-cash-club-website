/**
 * "All results": AK Cash Club results (tracked by the host) and My Poker Log
 * (entered by the member) in one view, with filters. Pure, BigInt cents.
 */
import { divRound, toCents } from './money';
import type { LogRow } from './poker-log';
import { computeStats, type PlayerStats, type ResultRow } from './stats';

export const AK_VENUE = 'AK Cash Club';

export interface AkRow {
  session_id: string;
  played_on: string;
  game_type: string;
  stakes: string;
  title: string | null;
  total_buy_in_cents: unknown;
  cash_out_cents: unknown;
  net_cents: unknown;
}

export interface CombinedRow {
  id: string;
  source: 'ak' | 'outside';
  playedOn: string;
  venue: string;
  format: string; // cash | tournament | other
  stakes: string;
  buyIn: bigint;
  cashOut: bigint;
  net: bigint;
  minutes: number | null;
  href: string | null;
}

export function combine(ak: AkRow[], log: LogRow[]): CombinedRow[] {
  const rows: CombinedRow[] = [
    ...ak.map((r) => ({
      id: r.session_id,
      source: 'ak' as const,
      playedOn: String(r.played_on).slice(0, 10),
      venue: AK_VENUE,
      format: 'cash',
      stakes: r.stakes,
      buyIn: toCents(r.total_buy_in_cents),
      cashOut: toCents(r.cash_out_cents),
      net: toCents(r.net_cents),
      minutes: null,
      href: null,
    })),
    ...log.map((r) => ({
      id: r.entry_id,
      source: 'outside' as const,
      playedOn: String(r.played_on).slice(0, 10),
      venue: r.venue,
      format: r.format,
      stakes: r.stakes ?? '',
      buyIn: toCents(r.buy_in_cents),
      cashOut: toCents(r.cash_out_cents),
      net: toCents(r.net_cents),
      minutes: r.duration_minutes,
      href: `/poker-log/${r.entry_id}`,
    })),
  ];
  // Newest first (stable).
  return rows.map((r, i) => ({ r, i })).sort((a, b) => (a.r.playedOn === b.r.playedOn ? a.i - b.i : a.r.playedOn > b.r.playedOn ? -1 : 1)).map((x) => x.r);
}

export interface Filters {
  from: string;
  to: string;
  source: 'all' | 'ak' | 'outside';
  stakes: string;
  venue: string;
  format: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function readFilters(params: URLSearchParams): Filters {
  const get = (k: string, max = 80) => (params.get(k) ?? '').trim().slice(0, max);
  const source = get('source');
  const format = get('format');
  return {
    from: DATE.test(get('from')) ? get('from') : '',
    to: DATE.test(get('to')) ? get('to') : '',
    source: source === 'ak' || source === 'outside' ? source : 'all',
    stakes: get('stakes', 40),
    venue: get('venue'),
    format: ['cash', 'tournament', 'other'].includes(format) ? format : '',
  };
}

export function applyFilters(rows: CombinedRow[], f: Filters): CombinedRow[] {
  return rows.filter((r) =>
    (!f.from || r.playedOn >= f.from) &&
    (!f.to || r.playedOn <= f.to) &&
    (f.source === 'all' || r.source === f.source) &&
    (!f.stakes || r.stakes === f.stakes) &&
    (!f.venue || r.venue === f.venue) &&
    (!f.format || r.format === f.format));
}

export function filterOptions(rows: CombinedRow[]) {
  const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))].sort((a, b) => a.localeCompare(b));
  return { stakes: uniq(rows.map((r) => r.stakes)), venues: uniq(rows.map((r) => r.venue)) };
}

export interface CombinedStats extends PlayerStats {
  hourly: bigint | null;
  minutesPlayed: number;
  bySource: { ak: { sessions: number; net: bigint }; outside: { sessions: number; net: bigint } };
}

export function combinedStats(rows: CombinedRow[]): CombinedStats {
  const asResults: ResultRow[] = rows.map((r) => ({
    session_id: r.id, played_on: r.playedOn, stakes: r.stakes, title: r.venue,
    total_buy_in_cents: r.buyIn, cash_out_cents: r.cashOut, net_cents: r.net,
  }));
  const base = computeStats(asResults, 1000);
  let minutes = 0;
  let timedNet = 0n;
  const bySource = { ak: { sessions: 0, net: 0n }, outside: { sessions: 0, net: 0n } };
  for (const r of rows) {
    bySource[r.source].sessions++;
    bySource[r.source].net += r.net;
    if (r.minutes) {
      minutes += r.minutes;
      timedNet += r.net;
    }
  }
  return { ...base, minutesPlayed: minutes, hourly: minutes ? divRound(timedNet * 60n, BigInt(minutes)) : null, bySource };
}

/** Query string for links that keep the current filters. */
export function filtersQuery(f: Filters): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v && !(k === 'source' && v === 'all')) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
}
