/**
 * Host session form: parse + validate the submitted rows into an exact
 * (integer-cents) payload for public.host_save_session, and build the
 * "review before saving" preview. Pure functions — unit tested.
 *
 * The database re-validates everything; this layer exists to give the host
 * clear, row-by-row messages before anything is saved.
 */
import { centsToInput, centsToJson, parseAddOns, parseDollars, parseSignedDollars, toCents } from './money';

export const MAX_PLAYERS = 40;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RowValues {
  id: string;
  player: string; // uuid | 'guest' | ''
  guest: string;
  initial: string;
  addons: string;
  cashout: string;
}
export interface AdjValues {
  id: string;
  amount: string;
  reason: string;
}
export interface SessionValues {
  id: string;
  played_on: string;
  game_type: string;
  stakes: string;
  title: string;
  host_notes: string;
  reason: string;
  rows: RowValues[];
  adjustments: AdjValues[];
}

export interface PreviewRow {
  name: string;
  tracked: boolean;
  buyIn: bigint;
  addOnCount: number;
  cashOut: bigint;
  net: bigint;
}
export interface Preview {
  rows: PreviewRow[];
  totalBuyIn: bigint;
  totalCashOut: bigint;
  totalNet: bigint;
  adjustmentsTotal: bigint;
  /** sum(net) + sum(adjustments): 0 when the table reconciles. */
  unexplained: bigint;
}

export interface SavePayload {
  id?: string;
  played_on: string;
  game_type: string;
  stakes: string;
  title: string | null;
  host_notes: string | null;
  results: Array<{
    id?: string;
    player_id: string | null;
    guest_label: string | null;
    initial_buy_in_cents: number;
    add_on_cents: number[];
    cash_out_cents: number;
  }>;
  adjustments: Array<{ id?: string; amount_cents: number; reason: string }>;
}

export type ParseOutcome =
  | { ok: true; values: SessionValues; payload: SavePayload; preview: Preview }
  | { ok: false; values: SessionValues; errors: Record<string, string> };

const str = (form: FormData, name: string, max: number) => {
  const v = form.get(name);
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
};
const list = (form: FormData, name: string, max: number) =>
  form.getAll(name).map((v) => (typeof v === 'string' ? v.trim().slice(0, max) : ''));

export function readSessionValues(form: FormData): SessionValues {
  const ids = list(form, 'row_id', 40);
  const players = list(form, 'row_player', 40);
  const guests = list(form, 'row_guest', 40);
  const initials = list(form, 'row_initial', 20);
  const addons = list(form, 'row_addons', 400);
  const cashouts = list(form, 'row_cashout', 20);
  const n = Math.min(Math.max(players.length, initials.length, cashouts.length), MAX_PLAYERS + 20);
  const rows: RowValues[] = [];
  for (let i = 0; i < n; i++) {
    rows.push({
      id: ids[i] ?? '',
      player: players[i] ?? '',
      guest: guests[i] ?? '',
      initial: initials[i] ?? '',
      addons: addons[i] ?? '',
      cashout: cashouts[i] ?? '',
    });
  }
  const adjIds = list(form, 'adj_id', 40);
  const adjAmounts = list(form, 'adj_amount', 20);
  const adjReasons = list(form, 'adj_reason', 200);
  const adjustments: AdjValues[] = [];
  for (let i = 0; i < Math.min(Math.max(adjAmounts.length, adjReasons.length), 30); i++) {
    adjustments.push({ id: adjIds[i] ?? '', amount: adjAmounts[i] ?? '', reason: adjReasons[i] ?? '' });
  }
  return {
    id: str(form, 'session_id', 40),
    played_on: str(form, 'played_on', 10),
    game_type: str(form, 'game_type', 60),
    stakes: str(form, 'stakes', 40),
    title: str(form, 'title', 80),
    host_notes: str(form, 'host_notes', 2000),
    reason: str(form, 'reason', 200),
    rows,
    adjustments,
  };
}

const isBlankRow = (r: RowValues) => !r.id && !r.player && !r.guest && !r.initial && !r.addons && !r.cashout;
const isBlankAdj = (a: AdjValues) => !a.id && !a.amount && !a.reason;

/**
 * Validate values into a payload. `players` maps player id -> username for
 * every player the host may select (used for duplicate checks and preview).
 */
export function parseSession(
  values: SessionValues,
  players: Map<string, { username: string; tracked: boolean }>,
  { isEdit }: { isEdit: boolean },
): ParseOutcome {
  const errors: Record<string, string> = {};

  if (!/^\d{4}-\d{2}-\d{2}$/.test(values.played_on) || Number.isNaN(Date.parse(values.played_on))) {
    errors.played_on = 'Choose the date the session was played.';
  }
  if (!values.stakes) errors.stakes = 'Enter the stakes, e.g. $1/$2.';
  if (isEdit && values.reason.length < 3) errors.reason = 'Give a short reason for this change (it goes in the audit log).';
  if (isEdit && !UUID_RE.test(values.id)) errors.form = 'This session couldn’t be identified. Please reload.';

  const results: SavePayload['results'] = [];
  const previewRows: PreviewRow[] = [];
  const seenPlayers = new Set<string>();
  const seenGuests = new Set<string>();

  values.rows.forEach((r, i) => {
    if (isBlankRow(r)) return;
    const k = (f: string) => `row_${i}_${f}`;
    let playerId: string | null = null;
    let guestLabel: string | null = null;
    let name = '';
    let tracked = false;

    if (r.player === 'guest' || (!r.player && r.guest)) {
      if (r.guest.length < 1) errors[k('guest')] = 'Give this guest a label, e.g. “Guest 1”.';
      guestLabel = r.guest;
      name = r.guest || 'Guest';
      const key = r.guest.toLowerCase();
      if (r.guest && seenGuests.has(key)) errors[k('guest')] = 'Two guests have the same label.';
      seenGuests.add(key);
    } else if (UUID_RE.test(r.player) && players.has(r.player)) {
      playerId = r.player;
      name = players.get(r.player)!.username;
      tracked = players.get(r.player)!.tracked;
      if (seenPlayers.has(r.player)) errors[k('player')] = `${name} appears more than once.`;
      seenPlayers.add(r.player);
    } else {
      errors[k('player')] = 'Choose a player, or “Guest”.';
    }

    const initial = parseDollars(r.initial);
    if (!initial.ok) errors[k('initial')] = initial.error;
    const addOns = parseAddOns(r.addons);
    if (!addOns.ok) errors[k('addons')] = addOns.error;
    const cashOut = parseDollars(r.cashout);
    if (!cashOut.ok) errors[k('cashout')] = cashOut.error;
    if (r.id && !UUID_RE.test(r.id)) errors[k('player')] = 'This row is invalid. Please reload.';

    if (initial.ok && addOns.ok && cashOut.ok) {
      const addTotal = addOns.cents.reduce((a, b) => a + b, 0n);
      const buyIn = initial.cents + addTotal;
      previewRows.push({ name, tracked, buyIn, addOnCount: addOns.cents.length, cashOut: cashOut.cents, net: cashOut.cents - buyIn });
      results.push({
        ...(r.id ? { id: r.id } : {}),
        player_id: playerId,
        guest_label: guestLabel,
        initial_buy_in_cents: centsToJson(initial.cents),
        add_on_cents: addOns.cents.map(centsToJson),
        cash_out_cents: centsToJson(cashOut.cents),
      });
    }
  });

  if (results.length === 0 && Object.keys(errors).every((e) => !e.startsWith('row_'))) {
    errors.rows = 'Add at least one player.';
  }
  if (results.length > MAX_PLAYERS) errors.rows = `A session can have at most ${MAX_PLAYERS} players.`;

  const adjustments: SavePayload['adjustments'] = [];
  let adjustmentsTotal = 0n;
  values.adjustments.forEach((a, i) => {
    if (isBlankAdj(a)) return;
    const amount = parseSignedDollars(a.amount);
    if (!amount.ok) errors[`adj_${i}_amount`] = amount.error;
    if (a.reason.length < 3) errors[`adj_${i}_reason`] = 'Explain the adjustment (at least 3 characters).';
    if (amount.ok && a.reason.length >= 3) {
      adjustmentsTotal += amount.cents;
      adjustments.push({ ...(a.id && UUID_RE.test(a.id) ? { id: a.id } : {}), amount_cents: centsToJson(amount.cents), reason: a.reason });
    }
  });

  if (Object.keys(errors).length) return { ok: false, values, errors };

  const totalBuyIn = previewRows.reduce((s, r) => s + r.buyIn, 0n);
  const totalCashOut = previewRows.reduce((s, r) => s + r.cashOut, 0n);
  const totalNet = totalCashOut - totalBuyIn;

  return {
    ok: true,
    values,
    payload: {
      ...(isEdit ? { id: values.id } : {}),
      played_on: values.played_on,
      game_type: values.game_type || 'No-Limit Texas Hold’em',
      stakes: values.stakes,
      title: values.title || null,
      host_notes: values.host_notes || null,
      results,
      adjustments,
    },
    preview: {
      rows: previewRows,
      totalBuyIn,
      totalCashOut,
      totalNet,
      adjustmentsTotal,
      unexplained: totalNet + adjustmentsTotal,
    },
  };
}

/** Deterministic fingerprint of a payload, used to require a fresh review if anything changed. */
export async function payloadFingerprint(payload: SavePayload): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Build form values from a stored session (host_get_session output). */
export function valuesFromStored(stored: {
  session: Record<string, unknown>;
  results: Array<Record<string, unknown>>;
  adjustments: Array<Record<string, unknown>>;
}): SessionValues {
  const s = stored.session;
  return {
    id: String(s.id ?? ''),
    played_on: String(s.played_on ?? ''),
    game_type: String(s.game_type ?? ''),
    stakes: String(s.stakes ?? ''),
    title: (s.title as string | null) ?? '',
    host_notes: (s.host_notes as string | null) ?? '',
    reason: '',
    rows: stored.results.map((r) => ({
      id: String(r.id),
      player: r.player_id ? String(r.player_id) : 'guest',
      guest: (r.guest_label as string | null) ?? '',
      initial: centsToInput(toCents(r.initial_buy_in_cents)),
      addons: ((r.add_on_cents as unknown[]) ?? []).map((c) => centsToInput(toCents(c))).join(' + '),
      cashout: centsToInput(toCents(r.cash_out_cents)),
    })),
    adjustments: stored.adjustments.map((a) => ({
      id: String(a.id),
      amount: centsToInput(toCents(a.amount_cents)),
      reason: String(a.reason ?? ''),
    })),
  };
}

export function blankValues(today: string): SessionValues {
  return {
    id: '',
    played_on: today,
    game_type: 'No-Limit Texas Hold’em',
    stakes: '',
    title: '',
    host_notes: '',
    reason: '',
    rows: [],
    adjustments: [],
  };
}
