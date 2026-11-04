/**
 * My Poker Log: a member's private record of games played OUTSIDE AK Cash Club.
 * Amounts are integer cents; durations are whole minutes.
 */
import { centsToJson, divRound, parseDollars, toCents } from './money';
import { computeStats, type PlayerStats, type ResultRow } from './stats';
import { usernameSkeleton } from './validation';

export const FORMATS = [
  { value: 'cash', label: 'Cash game' },
  { value: 'tournament', label: 'Tournament' },
  { value: 'other', label: 'Other' },
] as const;
export const formatLabel = (f: string) => FORMATS.find((x) => x.value === f)?.label ?? f;

export const AK_WARNING =
  'Only record games played outside AK Cash Club. Don’t enter AK Cash Club games here: the host records those, and they appear on My Dashboard automatically.';

/** Mirrors private.mentions_ak_cash_club() in the database. */
export function mentionsAkCashClub(text: string): boolean {
  const s = usernameSkeleton(text);
  return s.includes('akcash') || s.includes('akclub');
}

/** "4", "3.5", "3,5" (hours) or "3:30" (h:mm) -> minutes. Empty -> null. */
export function parseDuration(input: string): { ok: true; minutes: number | null } | { ok: false; error: string } {
  const raw = (input ?? '').trim();
  if (!raw) return { ok: true, minutes: null };
  let minutes: number | null = null;
  const hm = /^(\d{1,2}):([0-5]\d)$/.exec(raw);
  const dec = /^(\d{1,2})(?:[.,](\d{1,2}))?$/.exec(raw);
  if (hm) minutes = Number(hm[1]) * 60 + Number(hm[2]);
  else if (dec) {
    const frac = dec[2] ?? '';
    // integer maths: e.g. "3.5" -> 3*60 + (5 * 60) / 10
    minutes = Number(dec[1]) * 60 + (frac ? Math.round((Number(frac) * 60) / 10 ** frac.length) : 0);
  }
  if (minutes === null) return { ok: false, error: 'Use hours like 4 or 3.5, or h:mm like 3:30.' };
  if (minutes < 1 || minutes > 4320) return { ok: false, error: 'Enter a length between 1 minute and 72 hours.' };
  return { ok: true, minutes };
}

export function minutesToInput(m: number | null): string {
  if (!m) return '';
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}

export function formatHours(m: number): string {
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm ? `${h}h ${mm}m` : `${h}h`;
}

export interface LogValues {
  id: string;
  played_on: string;
  venue: string;
  game: string;
  format: string;
  stakes: string;
  buy_in: string;
  cash_out: string;
  duration: string;
  notes: string;
}

export interface LogPayload {
  id?: string;
  played_on: string;
  venue: string;
  game: string;
  format: string;
  stakes: string | null;
  buy_in_cents: number;
  cash_out_cents: number;
  duration_minutes: number | null;
  notes: string | null;
}

const str = (form: FormData, name: string, max: number) => {
  const v = form.get(name);
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
};

export function readLogValues(form: FormData): LogValues {
  return {
    id: str(form, 'entry_id', 40),
    played_on: str(form, 'played_on', 10),
    venue: str(form, 'venue', 80),
    game: str(form, 'game', 60),
    format: str(form, 'format', 20),
    stakes: str(form, 'stakes', 40),
    buy_in: str(form, 'buy_in', 20),
    cash_out: str(form, 'cash_out', 20),
    duration: str(form, 'duration', 10),
    notes: str(form, 'notes', 500),
  };
}

export function parseLogEntry(v: LogValues, { isEdit }: { isEdit: boolean }):
  { ok: true; payload: LogPayload } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v.played_on) || Number.isNaN(Date.parse(v.played_on))) errors.played_on = 'Choose the date you played.';
  if (!v.venue) errors.venue = 'Where did you play? (e.g. Casino Rama, online, a friend’s game)';
  else if (mentionsAkCashClub(v.venue)) errors.venue = 'AK Cash Club games are recorded by the host and appear on My Dashboard. Please don’t add them here.';
  if (mentionsAkCashClub(v.game)) errors.game = 'AK Cash Club games are recorded by the host. Please don’t add them here.';
  if (!FORMATS.some((f) => f.value === v.format)) errors.format = 'Choose a format.';
  const buyIn = parseDollars(v.buy_in);
  if (!buyIn.ok) errors.buy_in = buyIn.error;
  const cashOut = parseDollars(v.cash_out);
  if (!cashOut.ok) errors.cash_out = cashOut.error;
  const duration = parseDuration(v.duration);
  if (!duration.ok) errors.duration = duration.error;
  if (isEdit && !/^[0-9a-f-]{36}$/i.test(v.id)) errors.form = 'This entry couldn’t be identified. Please reload.';
  if (Object.keys(errors).length || !buyIn.ok || !cashOut.ok || !duration.ok) return { ok: false, errors };
  return {
    ok: true,
    payload: {
      ...(isEdit ? { id: v.id } : {}),
      played_on: v.played_on,
      venue: v.venue,
      game: v.game || 'No-Limit Texas Hold’em',
      format: v.format,
      stakes: v.stakes || null,
      buy_in_cents: centsToJson(buyIn.cents),
      cash_out_cents: centsToJson(cashOut.cents),
      duration_minutes: duration.minutes,
      notes: v.notes || null,
    },
  };
}

export interface LogRow {
  entry_id: string;
  played_on: string;
  venue: string;
  game: string;
  format: string;
  stakes: string | null;
  buy_in_cents: unknown;
  cash_out_cents: unknown;
  net_cents: unknown;
  duration_minutes: number | null;
  notes: string | null;
}

export interface LogStats extends PlayerStats {
  minutesPlayed: number;
  /** Net per hour across entries that have a length recorded. */
  hourly: bigint | null;
  byFormat: Array<{ format: string; label: string; sessions: number; net: bigint }>;
}

export function logStats(rows: LogRow[]): LogStats {
  const asResults: ResultRow[] = rows.map((r) => ({
    session_id: r.entry_id,
    played_on: String(r.played_on),
    stakes: r.venue,
    title: r.stakes,
    total_buy_in_cents: r.buy_in_cents,
    cash_out_cents: r.cash_out_cents,
    net_cents: r.net_cents,
  }));
  const base = computeStats(asResults, 50);
  let minutes = 0;
  let timedNet = 0n;
  const fmt = new Map<string, { sessions: number; net: bigint }>();
  for (const r of rows) {
    const net = toCents(r.net_cents);
    if (r.duration_minutes) {
      minutes += r.duration_minutes;
      timedNet += net;
    }
    const f = fmt.get(r.format) ?? { sessions: 0, net: 0n };
    f.sessions++;
    f.net += net;
    fmt.set(r.format, f);
  }
  return {
    ...base,
    minutesPlayed: minutes,
    hourly: minutes ? divRound(timedNet * 60n, BigInt(minutes)) : null,
    byFormat: FORMATS.filter((f) => fmt.has(f.value)).map((f) => ({ format: f.value, label: f.label, ...fmt.get(f.value)! })),
  };
}
