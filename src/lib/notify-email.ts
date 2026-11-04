/**
 * Builds the branded notification emails. Pure functions (no I/O), so the
 * content is unit-tested.
 *
 * Emails deliberately contain no amounts and no other players' names. They
 * say something happened and link to the member area, where the details are
 * shown after logging in.
 */
import { formatDate } from './stats';

export type NotificationKind = 'results_ready' | 'game_announcement' | 'seat_update' | 'game_reminder';

/** The preference each kind of email is controlled by (used by unsubscribe links). */
export const PREF_FOR_KIND: Record<NotificationKind, PrefKey> = {
  results_ready: 'results_ready',
  game_announcement: 'game_announcements',
  seat_update: 'seat_updates',
  game_reminder: 'game_reminders',
};

export type PrefKey = 'results_ready' | 'game_announcements' | 'seat_updates' | 'game_reminders';
export const PREF_KEYS: readonly PrefKey[] = ['results_ready', 'game_announcements', 'seat_updates', 'game_reminders'];

export const PREF_LABELS: Record<PrefKey, { title: string; description: string }> = {
  results_ready: {
    title: 'Your result is ready',
    description: 'An email when the host posts your result from a game (tracked players only). No amounts are included in the email.',
  },
  game_announcements: {
    title: 'New game nights',
    description: 'An email when the host opens a new game night for seat requests.',
  },
  seat_updates: {
    title: 'Seat updates',
    description: 'When a seat you asked for is confirmed, moves off the waitlist, or the game changes.',
  },
  game_reminders: {
    title: 'Game-day reminders',
    description: 'A reminder the day before a game you have a confirmed seat for.',
  },
};

export interface ClaimedNotification {
  notification_id: string;
  kind: NotificationKind;
  email: string;
  username: string;
  unsubscribe_token: string;
  payload: Record<string, unknown> | null;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
  unsubscribeUrl: string;
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function str(v: unknown, max = 80): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

interface Content {
  subject: string;
  preheader: string;
  heading: string;
  paragraphs: string[];
  button: { label: string; path: string };
  why: string;
}

function content(n: ClaimedNotification): Content | null {
  const p = n.payload ?? {};
  switch (n.kind) {
    case 'results_ready': {
      const date = str(p.played_on, 10);
      const when = date ? formatDate(date) : 'your last game';
      const title = str(p.title);
      const game = title ? `${title} (${when})` : `the game on ${when}`;
      return {
        subject: `Your result from ${when} is ready`,
        preheader: `The host has posted your result from ${when}.`,
        heading: 'Your result is ready',
        paragraphs: [
          `Hi ${n.username}, the host has posted your result from ${game}.`,
          'Log in to see it on your dashboard, along with your updated totals and chart.',
        ],
        button: { label: 'View my dashboard', path: '/dashboard' },
        why: 'You’re receiving this because you turned on “Your result is ready” emails.',
      };
    }
    default:
      // Other kinds are added together with the features that send them.
      return null;
  }
}

export function renderNotification(n: ClaimedNotification, site: string): RenderedEmail | null {
  const c = content(n);
  if (!c) return null;
  const base = site.replace(/\/+$/, '');
  const pref = PREF_FOR_KIND[n.kind];
  const unsubscribeUrl = `${base}/unsubscribe?t=${encodeURIComponent(n.unsubscribe_token)}&k=${pref}`;
  const manageUrl = `${base}/account#notifications`;
  const buttonUrl = `${base}${c.button.path}`;
  const sans = "-apple-system,'Segoe UI',Helvetica,Arial,sans-serif";
  const serif = "Georgia,'Times New Roman',serif";

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>${esc(c.heading)}</title>
</head>
<body style="margin:0;padding:0;background:#05070c;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(c.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#05070c;">
  <tr><td align="center" style="padding:32px 16px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#0a1120;border:1px solid #1f3254;border-radius:16px;">
      <tr><td align="center" style="padding:36px 32px 8px;">
        <img src="${esc(base)}/brand/emblem-email.png" width="88" height="88" alt="AK Cash Club" style="display:block;border:0;border-radius:44px;">
        <p style="margin:20px 0 0;font-family:${serif};font-size:13px;letter-spacing:4px;color:#a3bde6;text-transform:uppercase;">AK Cash Club</p>
      </td></tr>
      <tr><td style="padding:12px 36px 0;">
        <h1 style="margin:0;font-family:${serif};font-weight:normal;font-size:28px;line-height:1.25;color:#f4f6f9;text-align:center;">${esc(c.heading)}</h1>
      </td></tr>
      <tr><td style="padding:20px 36px 0;font-family:${sans};font-size:15px;line-height:1.65;color:#ccd3dd;">
        ${c.paragraphs.map((t, i) => `<p style="margin:${i ? '14px' : '0'} 0 0;">${esc(t)}</p>`).join('\n        ')}
      </td></tr>
      <tr><td align="center" style="padding:28px 36px 32px;">
        <a href="${esc(buttonUrl)}" style="display:inline-block;padding:14px 30px;border-radius:999px;background:#e6eaf0;color:#070b14;font-family:${sans};font-size:15px;font-weight:600;text-decoration:none;">${esc(c.button.label)}</a>
      </td></tr>
    </table>
    <p style="margin:20px 0 0;max-width:520px;font-family:${sans};font-size:11px;line-height:1.6;color:#6c7789;text-align:center;">
      AK Cash Club · London, Ontario · <a href="${esc(base)}" style="color:#8d98a9;">${esc(base.replace(/^https?:\/\//, ''))}</a><br>
      ${esc(c.why)}<br>
      <a href="${esc(unsubscribeUrl)}" style="color:#8d98a9;">Unsubscribe from these emails</a> · <a href="${esc(manageUrl)}" style="color:#8d98a9;">Manage email preferences</a>
    </p>
  </td></tr>
</table>
</body>
</html>`;

  const text = [
    'AK Cash Club',
    '',
    c.heading,
    '',
    ...c.paragraphs.flatMap((t) => [t, '']),
    `${c.button.label}: ${buttonUrl}`,
    '',
    '--',
    'AK Cash Club · London, Ontario',
    c.why,
    `Unsubscribe from these emails: ${unsubscribeUrl}`,
    `Manage email preferences: ${manageUrl}`,
  ].join('\n');

  return { subject: c.subject, html, text, unsubscribeUrl };
}
