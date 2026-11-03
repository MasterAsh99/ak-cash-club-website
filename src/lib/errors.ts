/**
 * Turn Supabase / database errors into friendly messages without leaking
 * internals. Unknown errors become a generic message; details go to the
 * server log only (never to the page).
 */

const DB_MESSAGES: Record<string, string> = {
  username_invalid: 'That username isn’t allowed. Use 3–20 letters, numbers, and . _ -',
  username_reserved: 'That username is reserved. Please choose another.',
  username_blocked: 'Please choose a different username.',
  host_name_is_fixed: 'The host’s name can’t be changed.',
  host_cannot_self_delete: 'The host account can’t be deleted from the website.',
  not_authenticated: 'Please log in again.',
  not_authorized: 'You don’t have access to that.',
  mfa_required: 'Please verify with your authenticator app first.',
  edit_reason_required: 'Please give a short reason for this change.',
  player_not_tracking: 'One of the selected players hasn’t turned on tracking, so results can’t be linked to their account.',
  player_not_found: 'One of the selected players no longer exists.',
  host_cannot_be_player: 'The host account can’t be entered as a player.',
  session_not_found: 'That session no longer exists.',
  result_not_found: 'A row in this session changed while you were editing. Please reload and try again.',
  adjustment_not_found: 'An adjustment changed while you were editing. Please reload and try again.',
  too_many_players: 'A session can have at most 40 players.',
  invalid_payload: 'Something was wrong with the form. Please check it and try again.',
};

export function friendlyDbError(err: { message?: string; code?: string } | null | undefined): string {
  if (!err) return 'Something went wrong. Please try again.';
  const msg = err.message ?? '';
  for (const key of Object.keys(DB_MESSAGES)) {
    if (msg.includes(key)) return DB_MESSAGES[key]!;
  }
  if (err.code === '23505' || /duplicate key|unique/i.test(msg)) {
    if (/username/i.test(msg)) return 'That username is already taken (or too similar to one that is).';
    if (/one_row_per_player/.test(msg)) return 'A player appears twice in this session.';
    if (/one_row_per_guest/.test(msg)) return 'Two guests in this session have the same label.';
    return 'That would create a duplicate entry.';
  }
  if (err.code === '23514' || /check constraint/i.test(msg)) {
    return 'One of the values is outside the allowed range. Please check the amounts and text lengths.';
  }
  console.error('Unhandled database error', err);
  return 'Something went wrong. Please try again.';
}

/** Auth API errors (supabase.auth.*). Deliberately vague where enumeration matters. */
export function friendlyAuthError(err: { message?: string; code?: string; status?: number } | null | undefined): string {
  if (!err) return 'Something went wrong. Please try again.';
  const code = err.code ?? '';
  const msg = (err.message ?? '').toLowerCase();
  if (code === 'email_not_confirmed' || msg.includes('email not confirmed')) {
    return 'Please verify your email address first. Check your inbox for the link we sent.';
  }
  if (code === 'invalid_credentials' || msg.includes('invalid login credentials')) {
    return 'Incorrect email or password.';
  }
  if (code === 'weak_password' || msg.includes('weak password') || msg.includes('password should')) {
    return 'That password is too weak or has appeared in a data breach. Please choose another.';
  }
  if (code === 'same_password') return 'Your new password must be different from your current one.';
  if (code === 'over_email_send_rate_limit' || code === 'over_request_rate_limit' || err.status === 429) {
    return 'Too many attempts. Please wait a little while and try again.';
  }
  if (code === 'email_address_invalid') return 'Please enter a valid email address.';
  if (code === 'email_exists') return 'That email address can’t be used. Try a different one.';
  if (code === 'mfa_verification_failed' || msg.includes('invalid totp')) return 'That code didn’t work. Please try again.';
  if (code === 'otp_expired' || msg.includes('expired')) return 'This link has expired or has already been used.';
  if (code === 'unexpected_failure' && msg.includes('database error saving new user')) {
    return 'That username is no longer available. Please choose another.';
  }
  if (msg.includes('database error saving new user')) {
    return 'That username is no longer available. Please choose another.';
  }
  console.error('Unhandled auth error', { code: err.code, status: err.status, message: err.message });
  return 'Something went wrong. Please try again.';
}
