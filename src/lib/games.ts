/**
 * Game nights: formatting and form parsing (pure functions, unit-tested).
 * All times are shown in Toronto time (London, Ontario).
 */
import { field } from './validation';

export const CLUB_TZ = 'America/Toronto';

export type SeatStatus = 'requested' | 'confirmed' | 'waitlisted' | 'declined' | 'cancelled' | 'completed';
export type NightStatus = 'open' | 'closed' | 'cancelled' | 'completed';

export interface GameNightRow {
  game_night_id: string;
  starts_at: string;
  game_type: string;
  stakes: string;
  seats: number;
  notes: string | null;
  status: NightStatus;
  confirmed_count: number;
  waitlist_count: number;
  my_status: SeatStatus | null;
  my_waitlist_position: number | null;
}

/** "Friday, November 6 at 7:30 p.m." from an ISO timestamp. */
export function formatGameTime(iso: string, style: 'long' | 'short' = 'long'): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: CLUB_TZ,
    weekday: style === 'long' ? 'long' : 'short',
    month: style === 'long' ? 'long' : 'short',
    day: 'numeric',
  }).format(d);
  const time = new Intl.DateTimeFormat('en-CA', { timeZone: CLUB_TZ, hour: 'numeric', minute: '2-digit' }).format(d);
  return `${date} at ${time}`;
}

/** Same, from the 'YYYY-MM-DDTHH:MM' Toronto-local form used in emails. */
export function formatLocalGameTime(local: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!m) return local;
  const [, y, mo, d, h, mi] = m.map(Number) as [number, number, number, number, number, number];
  // Format as if UTC so the wall-clock values are shown unchanged.
  const utc = new Date(Date.UTC(y, mo - 1, d, h, mi));
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' }).format(utc);
  const time = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', hour: 'numeric', minute: '2-digit' }).format(utc);
  return `${date} at ${time}`;
}

/** Toronto calendar date (YYYY-MM-DD) of a timestamp. */
export function torontoDate(iso: string | Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: CLUB_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

export const SEAT_LABELS: Record<SeatStatus, string> = {
  requested: 'Requested · not confirmed yet',
  confirmed: 'Seat confirmed',
  waitlisted: 'On the waitlist',
  declined: 'Not this time',
  cancelled: 'Cancelled',
  completed: 'Completed',
};

/** What the member sees for their own seat (a played game shows as Completed). */
export function myStatus(nightStatus: NightStatus, seat: SeatStatus | null): SeatStatus | null {
  if (nightStatus === 'completed' && seat === 'confirmed') return 'completed';
  return seat;
}

export function isFull(n: { seats: number; confirmed_count: number }): boolean {
  return n.confirmed_count >= n.seats;
}

/** Can the member ask for a seat (or the waitlist) right now? */
export function canRequest(n: { status: NightStatus; starts_at: string; my_status: SeatStatus | null }): boolean {
  return n.status === 'open' && new Date(n.starts_at) > new Date() && (!n.my_status || n.my_status === 'cancelled');
}

export function seatsLeft(n: { seats: number; confirmed_count: number }): number {
  return Math.max(0, n.seats - n.confirmed_count);
}

export interface GameNightForm {
  starts_local: string;
  game_type: string;
  stakes: string;
  seats: number;
  notes: string;
  address: string;
  arrival_note: string;
  status: 'open' | 'closed';
  announce: boolean;
  auto_fill_waitlist: boolean;
}

export function parseGameNightForm(form: FormData): { values: GameNightForm; errors: Record<string, string> } {
  const date = field(form, 'date', 10);
  const time = field(form, 'time', 5);
  const seatsRaw = field(form, 'seats', 3);
  const values: GameNightForm = {
    starts_local: `${date}T${time}`,
    game_type: field(form, 'game_type', 60),
    stakes: field(form, 'stakes', 40),
    seats: /^\d{1,2}$/.test(seatsRaw) ? Number(seatsRaw) : NaN,
    notes: field(form, 'notes', 500),
    address: field(form, 'address', 200),
    arrival_note: field(form, 'arrival_note', 300),
    status: form.get('status') === 'closed' ? 'closed' : 'open',
    announce: form.get('announce') === 'yes',
    auto_fill_waitlist: form.get('auto_fill_waitlist') === 'yes',
  };
  const errors: Record<string, string> = {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) errors.date = 'Please choose a date.';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) errors.time = 'Please choose a start time.';
  if (!values.stakes) errors.stakes = 'Please enter the stakes, e.g. $1/$2.';
  if (!Number.isInteger(values.seats) || values.seats < 2 || values.seats > 12) errors.seats = 'Seats must be between 2 and 12.';
  if (!values.address) errors.address = 'Please enter the address. Only confirmed players see it, on game day.';
  return { values, errors };
}
