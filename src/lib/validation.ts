/**
 * Input validation shared by the forms. The database enforces the same
 * username rules (and is the final authority); these give friendly messages
 * before a request is sent.
 */
import { RegExpMatcher, englishDataset, englishRecommendedTransformers } from 'obscenity';

const profanity = new RegExpMatcher({ ...englishDataset.build(), ...englishRecommendedTransformers });

export const USERNAME_HELP = '3–20 characters: letters, numbers, and . _ - (not at the start or end).';

const USERNAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

/** Mirrors private.username_skeleton() in the database. */
export function usernameSkeleton(name: string): string {
  const map: Record<string, string> = { '0': 'o', '1': 'l', '3': 'e', '4': 'a', '5': 's', '7': 't', i: 'l' };
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/[013457i]/g, (c) => map[c] ?? c);
}

const RESERVED_EXACT = [
  'ak', 'akhost', 'host', 'thehost', 'admin', 'administrator', 'root', 'owner', 'moderator', 'mod',
  'staff', 'support', 'help', 'dealer', 'system', 'official', 'akcash', 'akcashclub', 'cashclub',
  'null', 'undefined', 'anonymous', 'removed', 'deleted', 'guest', 'account', 'dashboard', 'security', 'billing',
].map(usernameSkeleton);
const RESERVED_FRAGMENTS = ['akhost', 'admin', 'akcashclub', 'moderator'].map(usernameSkeleton);

export type UsernameProblem = 'invalid' | 'reserved' | 'blocked';

export function usernameProblem(raw: string): UsernameProblem | null {
  const name = raw.trim();
  if (name.length < 3 || name.length > 20 || !USERNAME_RE.test(name) || /[._-]{2,}/.test(name)) return 'invalid';
  const s = usernameSkeleton(name);
  if (RESERVED_EXACT.includes(s) || RESERVED_FRAGMENTS.some((f) => s.includes(f))) return 'reserved';
  if (profanity.hasMatch(name) || profanity.hasMatch(name.replace(/[._-]/g, ' '))) return 'blocked';
  return null;
}

export function usernameMessage(problem: UsernameProblem | 'taken'): string {
  switch (problem) {
    case 'invalid':
      return `That username isn’t allowed. Use ${USERNAME_HELP}`;
    case 'reserved':
      return 'That username is reserved. Please choose another.';
    case 'blocked':
      return 'Please choose a different username.';
    case 'taken':
      return 'That username is already taken (or too similar to one that is).';
  }
}

export function isEmail(raw: string): boolean {
  const v = raw.trim();
  return v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
}

export const PASSWORD_HELP = 'At least 10 characters. A short phrase works well.';

/** Returns a problem message, or null when the password is acceptable. */
export function passwordProblem(pw: string, ctx: { email?: string; username?: string } = {}): string | null {
  if (pw.length < 10) return 'Your password needs at least 10 characters.';
  if (new TextEncoder().encode(pw).length > 72) return 'Your password is too long (72 bytes maximum).';
  if (/^(.)\1+$/.test(pw)) return 'Please choose a less predictable password.';
  const lower = pw.toLowerCase();
  const local = ctx.email?.split('@')[0]?.toLowerCase();
  if (local && local.length >= 4 && lower.includes(local)) return 'Your password shouldn’t contain your email address.';
  const user = ctx.username?.toLowerCase();
  if (user && user.length >= 4 && lower.includes(user)) return 'Your password shouldn’t contain your username.';
  if (['password12', 'password123', '1234567890', 'qwertyuiop', 'akcashclub'].some((w) => lower.includes(w))) {
    return 'That password is too common. Please choose another.';
  }
  return null;
}

/** Read a trimmed string field from a form, capped at `max` characters. */
export function field(form: FormData, name: string, max = 500): string {
  const v = form.get(name);
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

/** Read a field without trimming (passwords). */
export function rawField(form: FormData, name: string, max = 200): string {
  const v = form.get(name);
  return typeof v === 'string' ? v.slice(0, max) : '';
}
