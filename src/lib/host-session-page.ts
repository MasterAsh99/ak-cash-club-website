/**
 * Shared server logic for /host/sessions/new and /host/sessions/[id].
 * Flow: edit -> "Review" (server validates + calculates) -> "Confirm and save".
 * Saving requires the exact payload that was reviewed (fingerprint match), so
 * nothing unreviewed can be saved by accident.
 */
import type { AstroGlobal } from 'astro';
import { readForm } from './access';
import { friendlyDbError } from './errors';
import {
  parseSession, payloadFingerprint, readSessionValues, type Preview, type SessionValues,
} from './session-form';

export interface PlayerOption {
  id: string;
  username: string;
  tracked: boolean;
}

export interface SessionPageState {
  values: SessionValues;
  errors: Record<string, string>;
  preview: Preview | null;
  fingerprint: string;
  saveError: string;
}

export async function loadPlayerOptions(Astro: AstroGlobal): Promise<PlayerOption[]> {
  const { data, error } = await Astro.locals.supabase!.rpc('host_list_players', { p_query: null, p_limit: 200 });
  if (error) throw new Error(friendlyDbError(error));
  return (data ?? []).map((p: { player_id: string; username: string; tracking_enabled: boolean }) => ({
    id: p.player_id,
    username: p.username,
    tracked: p.tracking_enabled,
  }));
}

/** Returns page state, or a Response (redirect) once saved. */
export async function handleSessionForm(
  Astro: AstroGlobal,
  initial: SessionValues,
  players: PlayerOption[],
  isEdit: boolean,
): Promise<SessionPageState | Response> {
  const state: SessionPageState = { values: initial, errors: {}, preview: null, fingerprint: '', saveError: '' };
  const form = await readForm(Astro);
  if (!form) return state;

  const intent = form.get('intent') === 'save' ? 'save' : 'review';
  const values = readSessionValues(form);
  if (isEdit) values.id = initial.id; // never trust the posted id for edits
  state.values = values;

  const map = new Map(players.map((p) => [p.id, { username: p.username, tracked: p.tracked }]));
  const parsed = parseSession(values, map, { isEdit });
  if (!parsed.ok) {
    state.errors = parsed.errors;
    return state;
  }
  state.preview = parsed.preview;
  state.fingerprint = await payloadFingerprint(parsed.payload);

  if (intent === 'save') {
    if (form.get('fingerprint') !== state.fingerprint) {
      state.saveError = 'Something changed since you reviewed. Please check the totals below and confirm again.';
      return state;
    }
    const { data, error } = await Astro.locals.supabase!.rpc('host_save_session', {
      p_session: parsed.payload,
      p_reason: isEdit ? values.reason : null,
    });
    if (error) {
      state.saveError = friendlyDbError(error);
      return state;
    }
    return Astro.redirect(`/host/sessions/${data}?notice=${isEdit ? 'updated' : 'created'}`, 303);
  }
  return state;
}
