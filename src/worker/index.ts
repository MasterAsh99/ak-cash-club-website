/**
 * Worker entry point.
 *
 * - fetch: every web request is handled by the Astro site as before.
 * - scheduled: every 10 minutes (see "triggers" in wrangler.jsonc), sends any
 *   queued notification emails.
 */
import { handle } from '@astrojs/cloudflare/handler';
import { processOutbox, type NotifyEnv } from '../lib/notify';

export default {
  fetch: handle,
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      processOutbox(env as unknown as NotifyEnv).then((r) => {
        if (r.status === 'not_configured') console.log('notify: email sending not set up yet; missing', r.missing?.join(', '));
        else if (r.sent || r.failed) console.log(`notify: sent ${r.sent}, failed ${r.failed}`);
      }),
    );
  },
} satisfies ExportedHandler<Env>;
