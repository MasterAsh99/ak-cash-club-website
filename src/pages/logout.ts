import type { APIRoute } from 'astro';

export const prerender = false;

/** POST only, so a link or image on another site can't log people out. */
export const POST: APIRoute = async ({ locals, cookies, redirect }) => {
  if (locals.supabase) {
    await locals.supabase.auth.signOut({ scope: 'local' }).catch(() => undefined);
  }
  cookies.delete('akc_member', { path: '/' });
  return redirect('/', 303);
};

export const GET: APIRoute = ({ redirect }) => redirect('/dashboard', 303);
