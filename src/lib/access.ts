/**
 * Page guards for server-rendered member pages.
 *
 * These decide what to *show*. They are not the security boundary: the
 * database enforces every permission again (RLS + host checks + MFA), so a
 * forged request that skips these guards still gets nothing.
 */
import type { AstroGlobal } from 'astro';

export interface Access {
  userId: string;
  email: string;
  username: string;
  isHost: boolean;
  mfaVerified: boolean;
  trackingEnabled: boolean;
  trackingConsentedAt: string | null;
}

/** Only allow same-site relative paths into the member area as "next" targets. */
export function safeNext(raw: string | null | undefined, fallback = '/'): string {
  if (!raw) return fallback;
  if (!/^\/((dashboard|account|host|poker-log|games)(\/[A-Za-z0-9/_-]*)?)?(\?[A-Za-z0-9=&_-]*)?$/.test(raw)) return fallback;
  return raw;
}

const NEXT_COOKIE = 'akc_next';

/** Remember where a new member was heading, so email verification can return them there. */
export function rememberNext(Astro: AstroGlobal, raw: string | null | undefined): void {
  const next = safeNext(raw, '');
  if (!next) return;
  Astro.cookies.set(NEXT_COOKIE, next, {
    path: '/', httpOnly: true, sameSite: 'lax', secure: Astro.url.protocol === 'https:', maxAge: 60 * 60 * 24 * 2,
  });
}

/** Where to go after verifying an email: the remembered page, or the fallback. */
export function takeNext(Astro: AstroGlobal, fallback: string): string {
  const next = safeNext(Astro.cookies.get(NEXT_COOKIE)?.value, '');
  if (Astro.cookies.has(NEXT_COOKIE)) Astro.cookies.delete(NEXT_COOKIE, { path: '/' });
  return next || fallback;
}

export async function loadAccess(Astro: AstroGlobal): Promise<Access | null> {
  const { supabase, user } = Astro.locals;
  if (!supabase || !user) return null;
  const { data, error } = await supabase.rpc('my_access');
  if (error) {
    console.error('my_access failed', error.message);
    return null;
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return null;
  return {
    userId: row.user_id,
    email: user.email,
    username: row.username,
    isHost: Boolean(row.is_host),
    mfaVerified: Boolean(row.mfa_verified),
    trackingEnabled: Boolean(row.tracking_enabled),
    trackingConsentedAt: row.tracking_consented_at ?? null,
  };
}

/** Use at the top of a member page: returns access, or a redirect to log in. */
export async function requireMember(Astro: AstroGlobal): Promise<Access | Response> {
  if (!Astro.locals.supabase) return Astro.redirect('/login?unavailable=1');
  const access = await loadAccess(Astro);
  if (!access) {
    const next = encodeURIComponent(Astro.url.pathname + Astro.url.search);
    return Astro.redirect(`/login?next=${next}`);
  }
  return access;
}

/**
 * Use at the top of a host page. Non-hosts get a plain 404 so the host area
 * isn't advertised. Hosts without a second factor are sent to verify.
 */
export async function requireHost(Astro: AstroGlobal, { allowAal1 = false } = {}): Promise<Access | Response> {
  const access = await requireMember(Astro);
  if (access instanceof Response) return access;
  if (!access.isHost) return new Response(null, { status: 404, statusText: 'Not found' });
  if (!allowAal1 && !access.mfaVerified) return Astro.redirect('/host/mfa');
  return access;
}

/** Read a POSTed form safely (returns null for other methods/content types). */
export async function readForm(Astro: AstroGlobal): Promise<FormData | null> {
  if (Astro.request.method !== 'POST') return null;
  const type = Astro.request.headers.get('content-type') ?? '';
  if (!type.includes('application/x-www-form-urlencoded') && !type.includes('multipart/form-data')) return null;
  try {
    return await Astro.request.formData();
  } catch {
    return null;
  }
}
