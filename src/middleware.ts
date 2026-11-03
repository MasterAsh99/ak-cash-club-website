/**
 * Runs for every on-demand (server-rendered) page. Pre-built marketing pages
 * skip it entirely.
 *
 * - Creates a per-request Supabase client and verifies the signed-in user.
 * - Sets security headers and forbids caching of any member page.
 * - Maintains a harmless, readable "akc_member" hint cookie so the static
 *   home page can show "My Dashboard" instead of "Log in". It grants nothing;
 *   every member page re-verifies the real session.
 */
import { defineMiddleware } from 'astro:middleware';
import { createSupabase } from './lib/supabase';

const CSP = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

export const onRequest = defineMiddleware(async (context, next) => {
  if (context.isPrerendered) return next();

  const { locals, cookies, url } = context;
  locals.user = null;
  locals.supabase = createSupabase(context);

  if (locals.supabase) {
    try {
      // getClaims() verifies the session JWT (signature + expiry), refreshing
      // it if needed, so the identity below can be trusted.
      const { data, error } = await locals.supabase.auth.getClaims();
      const claims = data?.claims;
      if (!error && claims?.sub) {
        locals.user = {
          id: claims.sub,
          email: typeof claims.email === 'string' ? claims.email : '',
          aal: claims.aal === 'aal2' ? 'aal2' : 'aal1',
        };
      }
    } catch (e) {
      console.error('Session check failed', e instanceof Error ? e.message : e);
    }
  }

  const secure = url.protocol === 'https:';
  if (locals.user) {
    cookies.set('akc_member', '1', { path: '/', sameSite: 'lax', secure, maxAge: 60 * 60 * 24 * 30 });
  } else if (cookies.has('akc_member')) {
    cookies.delete('akc_member', { path: '/' });
  }

  const response = await next();

  // Some responses (e.g. redirects) have immutable headers; copy if needed.
  let res = response;
  try {
    res.headers.set('X-Probe', '1');
    res.headers.delete('X-Probe');
  } catch {
    res = new Response(response.body, response);
  }
  res.headers.set('Cache-Control', 'private, no-store');
  res.headers.set('Content-Security-Policy', CSP);
  res.headers.set('X-Content-Type-Options', 'nosniff');
  res.headers.set('X-Frame-Options', 'DENY');
  res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.headers.set('X-Robots-Tag', 'noindex, nofollow');
  return res;
});
