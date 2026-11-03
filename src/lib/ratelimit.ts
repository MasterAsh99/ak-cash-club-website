/**
 * Coarse rate limiting for auth forms using Cloudflare's Rate Limiting binding.
 * Limits are per Cloudflare location and approximate by design; Supabase Auth
 * applies its own limits behind these. If the binding is missing (local dev
 * without Wrangler), requests are allowed.
 */
import { appEnv } from './env';

export function clientIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP') ?? 'unknown';
}

async function hash(value: string): Promise<string> {
  const data = new TextEncoder().encode(value.trim().toLowerCase());
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

/**
 * Returns true when the request may proceed.
 * `action` separates buckets (e.g. "login", "signup", "reset").
 */
export async function allowAuthAttempt(request: Request, action: string, email?: string): Promise<boolean> {
  const env = appEnv();
  try {
    if (env.AUTH_IP_LIMITER) {
      const { success } = await env.AUTH_IP_LIMITER.limit({ key: `${action}:ip:${clientIp(request)}` });
      if (!success) return false;
    }
    if (email && env.AUTH_EMAIL_LIMITER) {
      // Emails are hashed so they never appear in rate-limit keys or logs.
      const { success } = await env.AUTH_EMAIL_LIMITER.limit({ key: `${action}:email:${await hash(email)}` });
      if (!success) return false;
    }
  } catch {
    // Never lock people out because the limiter itself failed.
    return true;
  }
  return true;
}

export const RATE_LIMITED_MESSAGE = 'Too many attempts. Please wait a minute and try again.';
