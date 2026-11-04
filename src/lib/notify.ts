/**
 * Sends queued notification emails. Runs from the Worker's scheduled job
 * (every 10 minutes), never from a page a visitor loads.
 *
 * Flow: claim due emails from the database outbox (requires NOTIFY_SECRET),
 * send each through Resend, then report success or failure back so failures
 * are retried with back-off.
 *
 * Needs these Worker settings (see docs/SETUP.md):
 *   NOTIFY_SECRET   (secret)  — created with  select private.rotate_outbox_secret();
 *   RESEND_API_KEY  (secret)  — a Resend API key with "Sending access" only
 *   EMAIL_FROM      (variable)— e.g. AK Cash Club <no-reply@your-verified-domain>
 * If any is missing, nothing is sent and the emails wait in the outbox.
 */
import { createClient } from '@supabase/supabase-js';
import { renderNotification, type ClaimedNotification } from './notify-email';

export interface NotifyEnv {
  SUPABASE_URL?: string;
  SUPABASE_PUBLISHABLE_KEY?: string;
  PUBLIC_SITE_URL?: string;
  NOTIFY_SECRET?: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  /** Override for tests only. Defaults to Resend's API. */
  RESEND_API_URL?: string;
}

export interface NotifyResult {
  status: 'not_configured' | 'ok' | 'error';
  sent: number;
  failed: number;
  missing?: string[];
}

const RESEND_DEFAULT = 'https://api.resend.com/emails';

export function missingNotifySettings(env: NotifyEnv): string[] {
  const required = ['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'PUBLIC_SITE_URL', 'NOTIFY_SECRET', 'RESEND_API_KEY', 'EMAIL_FROM'] as const;
  return required.filter((k) => !env[k]?.trim());
}

export async function processOutbox(env: NotifyEnv, fetchImpl: typeof fetch = fetch): Promise<NotifyResult> {
  const missing = missingNotifySettings(env);
  if (missing.length) return { status: 'not_configured', sent: 0, failed: 0, missing };

  const secret = env.NOTIFY_SECRET!.trim();
  const site = env.PUBLIC_SITE_URL!.trim();
  const supabase = createClient(env.SUPABASE_URL!.trim(), env.SUPABASE_PUBLISHABLE_KEY!.trim(), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: fetchImpl },
  });

  const { data, error } = await supabase.rpc('claim_notifications', { p_secret: secret, p_limit: 25 });
  if (error) {
    console.error('notify: claim failed', error.message);
    return { status: 'error', sent: 0, failed: 0 };
  }

  let sent = 0;
  let failed = 0;
  for (const n of (data ?? []) as ClaimedNotification[]) {
    let problem: string | null = null;
    try {
      const email = renderNotification(n, site);
      if (!email) {
        problem = `no template for ${n.kind}`;
      } else {
        const res = await fetchImpl(env.RESEND_API_URL?.trim() || RESEND_DEFAULT, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${env.RESEND_API_KEY!.trim()}`,
            'Content-Type': 'application/json',
            // Resend ignores a repeat with the same key, so a retry after a
            // lost response can't send the email twice.
            'Idempotency-Key': `akc-${n.notification_id}`,
          },
          body: JSON.stringify({
            from: env.EMAIL_FROM!.trim(),
            to: [n.email],
            subject: email.subject,
            html: email.html,
            text: email.text,
            headers: { 'List-Unsubscribe': `<${email.unsubscribeUrl}>` },
          }),
        });
        if (!res.ok) {
          const body = (await res.text().catch(() => '')).slice(0, 200);
          problem = `HTTP ${res.status} ${body}`.trim();
        }
      }
    } catch (e) {
      problem = e instanceof Error ? e.message : String(e);
    }

    const done = await supabase.rpc('complete_notification', {
      p_secret: secret,
      p_id: n.notification_id,
      p_error: problem,
    });
    if (done.error) console.error('notify: complete failed', done.error.message);
    if (problem) {
      failed++;
      console.error('notify: send failed', n.kind, problem);
    } else {
      sent++;
    }
  }
  return { status: 'ok', sent, failed };
}
