/**
 * Runtime configuration from the Cloudflare Worker environment.
 * Only import this from on-demand (server-rendered) code.
 *
 * SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY: set in the Cloudflare dashboard
 * (Workers & Pages -> ak-cash-club-website -> Settings -> Variables and Secrets)
 * and in .dev.vars for local development. The publishable key is the low-
 * privilege key Supabase designs for public use; every request it makes is
 * still subject to Row Level Security. No service-role key is used anywhere.
 */
import { env as cfEnv } from 'cloudflare:workers';

export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface AppEnv {
  SUPABASE_URL?: string;
  SUPABASE_PUBLISHABLE_KEY?: string;
  PUBLIC_SITE_URL?: string;
  AUTH_IP_LIMITER?: RateLimiter;
  AUTH_EMAIL_LIMITER?: RateLimiter;
}

export function appEnv(): AppEnv {
  return cfEnv as unknown as AppEnv;
}

export function supabaseConfig(): { url: string; key: string } | null {
  const e = appEnv();
  const url = e.SUPABASE_URL?.trim();
  const key = e.SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!url || !key) return null;
  return { url, key };
}

/** The canonical site origin, used to build links inside emails. */
export function siteUrl(fallback: URL): string {
  const configured = appEnv().PUBLIC_SITE_URL?.trim();
  return (configured || fallback.origin).replace(/\/+$/, '');
}
