/**
 * Live game-night mode: totals for the host's screen. Pure, BigInt cents only.
 */
import { toCents } from './money';

export type PayMethod = 'cash' | 'etransfer';

export interface LiveBuyIn { id: string; amount_cents: unknown; method: PayMethod; created_at: string }
export interface LivePlayer {
  id: string;
  player_id: string | null;
  username: string | null;
  tracking_enabled: boolean;
  guest_label: string | null;
  checked_in_at: string | null;
  cash_out_cents: unknown;
  payout_method: PayMethod | null;
  buyins: LiveBuyIn[];
}
export interface LiveGame {
  game_night_id: string;
  started_at: string;
  finalized_at: string | null;
  finalized_session_id: string | null;
  starts_at: string;
  stakes: string;
  game_type: string;
  players: LivePlayer[];
}

export function displayName(p: LivePlayer): string {
  return p.username ?? p.guest_label ?? 'Guest';
}

export function playerTotals(p: LivePlayer) {
  const buyIn = p.buyins.reduce((s, b) => s + toCents(b.amount_cents), 0n);
  const cashOut = p.cash_out_cents === null || p.cash_out_cents === undefined ? null : toCents(p.cash_out_cents);
  return { buyIn, cashOut, net: cashOut === null ? null : cashOut - buyIn };
}

export interface LiveTotals {
  buyIns: bigint;
  cashOuts: bigint;
  /** Buy-ins not yet paid back out: chips still in play (or the difference at the end). */
  inPlay: bigint;
  cashIn: bigint;
  cashOut: bigint;
  etransferIn: bigint;
  etransferOut: bigint;
  checkedIn: number;
  stillPlaying: number;
}

export function liveTotals(players: LivePlayer[]): LiveTotals {
  const t: LiveTotals = { buyIns: 0n, cashOuts: 0n, inPlay: 0n, cashIn: 0n, cashOut: 0n, etransferIn: 0n, etransferOut: 0n, checkedIn: 0, stillPlaying: 0 };
  for (const p of players) {
    if (p.checked_in_at) t.checkedIn++;
    for (const b of p.buyins) {
      const c = toCents(b.amount_cents);
      t.buyIns += c;
      if (b.method === 'cash') t.cashIn += c;
      else t.etransferIn += c;
    }
    if (p.cash_out_cents !== null && p.cash_out_cents !== undefined) {
      const c = toCents(p.cash_out_cents);
      t.cashOuts += c;
      if (p.payout_method === 'cash') t.cashOut += c;
      else t.etransferOut += c;
    } else if (p.buyins.length) {
      t.stillPlaying++;
    }
  }
  t.inPlay = t.buyIns - t.cashOuts;
  return t;
}
