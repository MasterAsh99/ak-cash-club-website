import { describe, expect, it } from 'vitest';
import { renderNotification, type ClaimedNotification } from '../../src/lib/notify-email';
import { missingNotifySettings, processOutbox, type NotifyEnv } from '../../src/lib/notify';

const n = (extra: Partial<ClaimedNotification> = {}): ClaimedNotification => ({
  notification_id: '11111111-1111-4111-8111-111111111111',
  kind: 'results_ready',
  email: 'alice@example.com',
  username: 'alice',
  unsubscribe_token: 'a'.repeat(64),
  payload: { played_on: '2026-11-01', title: null, stakes: '$1/$2' },
  ...extra,
});

describe('renderNotification', () => {
  it('builds a results email with no amounts and working links', () => {
    const e = renderNotification(n(), 'https://akcashclub.com/')!;
    expect(e.subject).toBe('Your result from Nov 1, 2026 is ready');
    expect(e.html).toContain('https://akcashclub.com/dashboard');
    expect(e.unsubscribeUrl).toBe(`https://akcashclub.com/unsubscribe?t=${'a'.repeat(64)}&k=results_ready`);
    expect(e.html).toContain('Manage email preferences');
    expect(e.text).toContain(e.unsubscribeUrl);
    expect(e.html).not.toMatch(/\$\d|cash-out|buy-in/i);
  });

  it('uses the game title when there is one', () => {
    const e = renderNotification(n({ payload: { played_on: '2026-11-01', title: 'Friday Night', stakes: '$1/$2' } }), 'https://akcashclub.com')!;
    expect(e.text).toContain('Friday Night (Nov 1, 2026)');
  });

  it('escapes anything that reaches the HTML', () => {
    const e = renderNotification(n({ username: '<b>x</b>', payload: { played_on: '2026-11-01', title: '"><script>' } }), 'https://akcashclub.com')!;
    expect(e.html).not.toContain('<script>');
    expect(e.html).not.toContain('<b>x</b>');
    expect(e.html).toContain('&lt;b&gt;x&lt;/b&gt;');
  });

  it('returns null for unknown seat events', () => {
    expect(renderNotification(n({ kind: 'seat_update', payload: { event: 'bogus', starts_local: '2026-11-06T19:30' } }), 'https://akcashclub.com')).toBeNull();
  });
});

describe('processOutbox', () => {
  const env: NotifyEnv = {
    SUPABASE_URL: 'https://db.example.test',
    SUPABASE_PUBLISHABLE_KEY: 'pk',
    PUBLIC_SITE_URL: 'https://akcashclub.com',
    NOTIFY_SECRET: 's'.repeat(64),
    RESEND_API_KEY: 're_test',
    EMAIL_FROM: 'AK Cash Club <no-reply@example.test>',
  };

  it('does nothing until every setting is present', async () => {
    expect(missingNotifySettings({ ...env, RESEND_API_KEY: ' ' })).toEqual(['RESEND_API_KEY']);
    const r = await processOutbox({ ...env, NOTIFY_SECRET: undefined }, () => {
      throw new Error('should not be called');
    });
    expect(r).toMatchObject({ status: 'not_configured', missing: ['NOTIFY_SECRET'] });
  });

  it('claims, sends through Resend and reports each outcome', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = [];
    const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const body = JSON.parse(String(init?.body ?? '{}'));
      calls.push({ url, body, headers: new Headers(init?.headers) });
      const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } });
      if (url.endsWith('/rpc/claim_notifications')) {
        return json([n(), n({ notification_id: '22222222-2222-4222-8222-222222222222', email: 'bob@example.com', username: 'bob' })]);
      }
      if (url.endsWith('/rpc/complete_notification')) return new Response(null, { status: 204 });
      if (url === 'https://api.resend.com/emails') {
        return body.to[0] === 'bob@example.com' ? json({ message: 'rate limited' }, 429) : json({ id: 'em_1' });
      }
      return json({}, 404);
    }) as typeof fetch;

    const r = await processOutbox(env, fake);
    expect(r).toEqual({ status: 'ok', sent: 1, failed: 1 });

    const claim = calls.find((c) => c.url.endsWith('/rpc/claim_notifications'))!;
    expect(claim.body).toEqual({ p_secret: env.NOTIFY_SECRET, p_limit: 25 });

    const sends = calls.filter((c) => c.url === 'https://api.resend.com/emails');
    expect(sends).toHaveLength(2);
    expect(sends[0]!.headers.get('Authorization')).toBe('Bearer re_test');
    expect(sends[0]!.headers.get('Idempotency-Key')).toBe('akc-11111111-1111-4111-8111-111111111111');
    expect(sends[0]!.body).toMatchObject({ from: env.EMAIL_FROM, to: ['alice@example.com'] });
    expect((sends[0]!.body.headers as Record<string, string>)['List-Unsubscribe']).toMatch(/^<https:\/\/akcashclub\.com\/unsubscribe\?t=/);

    const completes = calls.filter((c) => c.url.endsWith('/rpc/complete_notification')).map((c) => c.body);
    expect(completes).toEqual([
      { p_secret: env.NOTIFY_SECRET, p_id: '11111111-1111-4111-8111-111111111111', p_error: null },
      { p_secret: env.NOTIFY_SECRET, p_id: '22222222-2222-4222-8222-222222222222', p_error: expect.stringMatching(/^HTTP 429/) },
    ]);
  });
});

describe('game emails', () => {
  const g = (kind: ClaimedNotification['kind'], event: string) =>
    renderNotification(n({ kind, payload: { event, starts_local: '2026-11-06T19:30', stakes: '$1/$2', game_night_id: '33333333-3333-4333-8333-333333333333' } }), 'https://akcashclub.com')!;

  it.each([
    ['game_announcement', 'new', /New game night: Friday, November 6 at 7:30 p\.m\./, 'k=game_announcements'],
    ['seat_update', 'confirmed', /Your seat is confirmed for Friday, November 6/, 'k=seat_updates'],
    ['seat_update', 'promoted', /Your seat is confirmed/, 'k=seat_updates'],
    ['seat_update', 'waitlisted', /waitlist/, 'k=seat_updates'],
    ['seat_update', 'declined', /About your seat request/, 'k=seat_updates'],
    ['seat_update', 'changed', /Game time changed/, 'k=seat_updates'],
    ['seat_update', 'cancelled', /Game cancelled/, 'k=seat_updates'],
    ['game_reminder', 'reminder', /Reminder: you’re playing Friday/, 'k=game_reminders'],
  ] as const)('%s / %s', (kind, event, subject, pref) => {
    const e = g(kind, event);
    expect(e.subject).toMatch(subject);
    expect(e.unsubscribeUrl).toContain(pref);
    expect(e.html).not.toMatch(/address:|St\b/);
  });

  it('links to the game page', () => {
    expect(g('seat_update', 'confirmed').html).toContain('https://akcashclub.com/games/33333333-3333-4333-8333-333333333333');
    expect(g('seat_update', 'promoted').text).toContain('moved off the waitlist');
  });
});
