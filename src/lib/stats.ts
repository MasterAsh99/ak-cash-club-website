/**
 * Player statistics, computed exactly in integer cents (BigInt).
 *
 *   Net result (per session) = total cash-out − total buy-ins
 *   Total buy-ins             = initial buy-in + every rebuy/top-up
 */
import { divRound, toCents } from './money';

export interface ResultRow {
  session_id: string;
  played_on: string; // YYYY-MM-DD
  stakes: string;
  title: string | null;
  game_type?: string;
  total_buy_in_cents: unknown;
  cash_out_cents: unknown;
  net_cents: unknown;
}

export interface SessionResult {
  sessionId: string;
  playedOn: string;
  stakes: string;
  title: string | null;
  gameType: string | null;
  buyIn: bigint;
  cashOut: bigint;
  net: bigint;
}

export interface PlayerStats {
  sessions: number;
  lifetimeNet: bigint;
  totalBuyIns: bigint;
  totalCashOuts: bigint;
  averageNet: bigint | null;
  biggestWin: SessionResult | null; // null when no winning session
  biggestLoss: SessionResult | null; // null when no losing session
  winningSessions: number;
  losingSessions: number;
  /** Oldest -> newest, with running total after each session. */
  cumulative: Array<{ result: SessionResult; total: bigint }>;
  /** Newest first. */
  recent: SessionResult[];
}

export function normalizeRows(rows: ResultRow[]): SessionResult[] {
  return rows.map((r) => {
    const buyIn = toCents(r.total_buy_in_cents);
    const cashOut = toCents(r.cash_out_cents);
    const net = toCents(r.net_cents);
    // Defence in depth: the database computes net; make sure it agrees.
    if (net !== cashOut - buyIn) throw new Error('Inconsistent session result');
    return {
      sessionId: r.session_id,
      playedOn: String(r.played_on).slice(0, 10),
      stakes: r.stakes,
      title: r.title,
      gameType: r.game_type ?? null,
      buyIn,
      cashOut,
      net,
    };
  });
}

/** Stable chronological order: by date, then original order for same-day sessions. */
function chronological(results: SessionResult[]): SessionResult[] {
  return results
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (a.r.playedOn === b.r.playedOn ? b.i - a.i : a.r.playedOn < b.r.playedOn ? -1 : 1))
    .map((x) => x.r);
}

export function computeStats(rows: ResultRow[], recentCount = 8): PlayerStats {
  // Rows arrive newest-first from the database.
  const results = normalizeRows(rows);
  const ordered = chronological(results);

  let lifetimeNet = 0n;
  let totalBuyIns = 0n;
  let totalCashOuts = 0n;
  let biggestWin: SessionResult | null = null;
  let biggestLoss: SessionResult | null = null;
  let winningSessions = 0;
  let losingSessions = 0;
  const cumulative: PlayerStats['cumulative'] = [];

  for (const r of ordered) {
    lifetimeNet += r.net;
    totalBuyIns += r.buyIn;
    totalCashOuts += r.cashOut;
    if (r.net > 0n) {
      winningSessions++;
      if (!biggestWin || r.net > biggestWin.net) biggestWin = r;
    } else if (r.net < 0n) {
      losingSessions++;
      if (!biggestLoss || r.net < biggestLoss.net) biggestLoss = r;
    }
    cumulative.push({ result: r, total: lifetimeNet });
  }

  return {
    sessions: results.length,
    lifetimeNet,
    totalBuyIns,
    totalCashOuts,
    averageNet: results.length ? divRound(lifetimeNet, BigInt(results.length)) : null,
    biggestWin,
    biggestLoss,
    winningSessions,
    losingSessions,
    cumulative,
    recent: [...ordered].reverse().slice(0, recentCount),
  };
}

/** Format an ISO date (YYYY-MM-DD) without timezone surprises. */
export function formatDate(iso: string, style: 'long' | 'short' = 'long'): string {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number) as [number, number, number];
  if (!y || !m || !d) return String(iso);
  const date = new Date(Date.UTC(y, m - 1, d));
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    ...(style === 'long' ? { year: 'numeric' } : {}),
  }).format(date);
}
