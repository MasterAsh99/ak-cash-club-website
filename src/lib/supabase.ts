/**
 * Per-request Supabase client for server-rendered pages.
 *
 * - Sessions live in cookies that are HttpOnly (page scripts can't read them),
 *   Secure (HTTPS only) and SameSite=Lax.
 * - The browser never talks to Supabase directly.
 * - A new client is created for every request (required by @supabase/ssr).
 */
import { createServerClient, parseCookieHeader } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AstroCookies } from 'astro';
import { supabaseConfig } from './env';

export function createSupabase(ctx: { request: Request; cookies: AstroCookies; url: URL }): SupabaseClient | null {
  const cfg = supabaseConfig();
  if (!cfg) return null;
  const secure = ctx.url.protocol === 'https:';
  const enforced = { httpOnly: true, secure, sameSite: 'lax' as const, path: '/' };

  return createServerClient(cfg.url, cfg.key, {
    cookieOptions: enforced,
    cookies: {
      getAll() {
        return parseCookieHeader(ctx.request.headers.get('Cookie') ?? '').map((c) => ({
          name: c.name,
          value: c.value ?? '',
        }));
      },
      setAll(list) {
        for (const { name, value, options } of list) {
          ctx.cookies.set(name, value, { ...options, ...enforced });
        }
      },
    },
    auth: {
      flowType: 'pkce',
      detectSessionInUrl: false,
      persistSession: true,
      autoRefreshToken: false,
    },
  });
}
