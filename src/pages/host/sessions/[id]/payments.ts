/**
 * Saves the payments panel of a session (POST only), then returns to the
 * session page. Authorization is enforced by the database function
 * (host + MFA); this endpoint just passes the form through.
 */
import type { APIRoute } from 'astro';
import { readPayments } from '../../../../lib/payments';

export const prerender = false;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const POST: APIRoute = async ({ params, request, locals, redirect }) => {
  const id = params.id ?? '';
  if (!UUID_RE.test(id) || !locals.supabase || !locals.user) return new Response(null, { status: 404 });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return redirect(`/host/sessions/${id}?payments=error#payments`, 303);
  }
  const rows = readPayments(form);
  const { error } = await locals.supabase.rpc('host_update_payments', { p_session_id: id, p_rows: rows });
  if (error) {
    if (/not_authorized/.test(error.message)) return new Response(null, { status: 404 });
    if (/mfa_required/.test(error.message)) return redirect('/host/mfa', 303);
    console.error('host_update_payments failed', error.message);
    return redirect(`/host/sessions/${id}?payments=error#payments`, 303);
  }
  return redirect(`/host/sessions/${id}?payments=saved#payments`, 303);
};

export const GET: APIRoute = ({ params, redirect }) => redirect(`/host/sessions/${params.id}#payments`, 303);
