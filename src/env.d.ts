/// <reference types="astro/client" />

declare namespace App {
  interface Locals {
    /** Per-request Supabase client, or null when Supabase isn't configured. */
    supabase: import('@supabase/supabase-js').SupabaseClient | null;
    /** The verified signed-in user, if any. */
    user: { id: string; email: string; aal: 'aal1' | 'aal2' } | null;
  }
}
