/**
 * Runs the end-to-end walkthrough:
 *   1. builds the site
 *   2. starts the local Supabase stand-in (fresh database)
 *   3. starts the built Worker with `wrangler dev`, pointed at the stand-in
 *   4. runs tests/e2e/flow.cjs in Chromium (Playwright)
 *
 * Requires Playwright with Chromium installed (`npx playwright install chromium`).
 */
import { spawn, execSync } from 'node:child_process';

const env = { ...process.env, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
const procs = [];
const start = (cmd, args) => {
  const p = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(p);
  return p;
};
const stopAll = () => procs.forEach((p) => p.kill('SIGTERM'));
process.on('exit', stopAll);

async function waitFor(url, ms = 60_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      await fetch(url);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`Timed out waiting for ${url}`);
}

execSync('npm run build', { stdio: 'inherit', env });
start('node', ['--experimental-strip-types', 'tests/e2e/mock-supabase.mts']);
start('npx', [
  'wrangler', 'dev', '--config', 'dist/server/wrangler.json', '--port', '4321', '--ip', '127.0.0.1',
  '--var', 'SUPABASE_URL:http://127.0.0.1:54321',
  '--var', 'SUPABASE_PUBLISHABLE_KEY:e2e-test-key',
  '--var', 'PUBLIC_SITE_URL:http://127.0.0.1:4321',
]);
await waitFor('http://127.0.0.1:54321/__test/outbox');
await waitFor('http://127.0.0.1:4321/');

const flow = spawn('node', ['tests/e2e/flow.cjs'], { env, stdio: 'inherit' });
flow.on('exit', (code) => {
  stopAll();
  process.exit(code ?? 1);
});
