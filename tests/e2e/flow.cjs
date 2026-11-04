/**
 * End-to-end walkthrough against a locally running site + mock Supabase.
 * Usage: node tests/e2e/flow.cjs  (see tests/e2e/README.md)
 */
const { chromium, devices } = require('playwright');
const assert = require('node:assert/strict');

const SITE = process.env.SITE ?? 'http://127.0.0.1:4321';
const MOCK = process.env.MOCK ?? 'http://127.0.0.1:54321';
const SHOTS = process.env.SHOTS ?? '/tmp/e2e-shots';
require('node:fs').mkdirSync(SHOTS, { recursive: true });

const results = [];
async function step(name, fn) {
  try {
    await fn();
    results.push(['PASS', name]);
    console.log('PASS', name);
  } catch (e) {
    results.push(['FAIL', name, e.message]);
    console.log('FAIL', name, '\n   ', e.message.split('\n')[0]);
  }
}
const outbox = async () => (await fetch(`${MOCK}/__test/outbox`)).json();
async function latestToken(email, type) {
  const items = (await outbox()).filter((m) => m.to === email && m.type === type);
  assert.ok(items.length, `no ${type} email for ${email}`);
  return items[items.length - 1].token_hash;
}
async function accessToken(context) {
  // @supabase/ssr may split the session across sb-*-auth-token.0, .1, ... cookies.
  const parts = (await context.cookies())
    .filter((x) => /^sb-.*-auth-token(\.\d+)?$/.test(x.name))
    .sort((x, y) => x.name.localeCompare(y.name, undefined, { numeric: true }));
  assert.ok(parts.length, 'no auth cookie');
  for (const c of parts) assert.equal(c.httpOnly, true, `${c.name} must be HttpOnly`);
  const raw = parts.map((c) => decodeURIComponent(c.value)).join('').replace(/^base64-/, '');
  return JSON.parse(Buffer.from(raw, 'base64url').toString()).access_token;
}

async function signupAndVerify(page, email, username, password) {
  await page.goto(`${SITE}/signup`);
  await page.fill('#email', email);
  await page.fill('#username', username);
  await page.fill('#password', password);
  await page.fill('#confirm', password);
  await page.click('main button[type=submit]');
  await page.waitForURL(/check-email/);
  const token = await latestToken(email, 'signup');
  await page.goto(`${SITE}/auth/confirm?token_hash=${token}&type=email`);
  await page.click('main button[type=submit]');
  await page.waitForURL(/dashboard\?notice=verified/);
}
async function login(page, email, password, next = '') {
  await page.goto(`${SITE}/login${next}`);
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.click('button[type=submit]');
}

(async () => {
  const browser = await chromium.launch();
  const mobile = devices['iPhone 13'];
  const alice = await browser.newContext({ ...mobile, reducedMotion: 'reduce' });
  const a = await alice.newPage();
  const errors = [];
  a.on('pageerror', (e) => errors.push(e.message));

  await step('sign-up form rejects the host name and look-alikes', async () => {
    await a.goto(`${SITE}/signup`);
    await a.screenshot({ path: `${SHOTS}/01-signup-mobile.png` });
    for (const name of ['AK (host)', 'ak_host', 'AK-H0st']) {
      await a.fill('#email', 'x@example.com');
      await a.fill('#username', name);
      await a.fill('#password', 'correct horse battery');
      await a.fill('#confirm', 'correct horse battery');
      await a.click('button[type=submit]');
      await a.waitForLoadState();
      assert.match(await a.textContent('body'), /isn’t allowed|reserved/, name);
    }
  });

  await step('player signs up, verifies email, lands on opt-in empty state', async () => {
    await signupAndVerify(a, 'alice@example.com', 'alice', 'correct horse battery');
    assert.match(await a.textContent('body'), /Keep a private record/);
    await a.screenshot({ path: `${SHOTS}/02-dashboard-optin-mobile.png`, fullPage: true });
  });

  await step('verification link is single-use', async () => {
    const token = (await outbox()).find((m) => m.to === 'alice@example.com').token_hash;
    const p = await (await browser.newContext()).newPage();
    await p.goto(`${SITE}/auth/confirm?token_hash=${token}&type=email`);
    await p.click('button[type=submit]');
    assert.match(await p.textContent('body'), /can’t be used/);
  });

  await step('auth cookie is HttpOnly and the host area is hidden from players', async () => {
    await accessToken(alice);
    const r = await a.goto(`${SITE}/host`);
    assert.equal(r.status(), 404);
  });

  await step('player opts in to tracking with explicit consent', async () => {
    await a.goto(`${SITE}/account#tracking`);
    await a.click('form:has(input[value=tracking_on]) button[type=submit]');
    assert.match(await a.textContent('body'), /Please confirm you understand/);
    await a.check('input[name=consent]');
    await a.click('form:has(input[value=tracking_on]) button[type=submit]');
    assert.match(await a.textContent('body'), /Tracking is on/);
    await a.screenshot({ path: `${SHOTS}/03-account-mobile.png`, fullPage: true });
  });

  await step('player cannot rename to "AK (host)"', async () => {
    await a.goto(`${SITE}/account`);
    await a.fill('#username', 'AK (host)');
    await a.click('form:has(input[value=username]) button[type=submit]');
    assert.match(await a.textContent('body'), /isn’t allowed/);
  });

  await step('direct API calls with a player token cannot write results', async () => {
    const token = await accessToken(alice);
    const who = await fetch(`${MOCK}/rest/v1/rpc/my_access`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal((await who.json())[0].username, 'alice', 'token should identify alice');
    const res = await fetch(`${MOCK}/rest/v1/rpc/host_save_session`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ p_session: { played_on: '2026-10-30', stakes: '$1/$2', results: [] } }),
    });
    assert.equal(res.status, 403);
    assert.match(await res.text(), /not_authorized/);
  });

  // ---- host ----
  const hostCtx = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  const h = await hostCtx.newPage();
  h.on('pageerror', (e) => errors.push(e.message));

  await step('host account is activated only by the owner step, then requires MFA', async () => {
    await signupAndVerify(h, 'owner@example.com', 'aaronk', 'host password 123');
    let r = await h.goto(`${SITE}/host`);
    assert.equal(r.status(), 404, 'not host yet');
    await fetch(`${MOCK}/__test/make-host`, { method: 'POST', body: JSON.stringify({ email: 'owner@example.com' }) });
    await h.goto(`${SITE}/host`);
    await h.waitForURL(/\/host\/mfa/);
    await h.screenshot({ path: `${SHOTS}/04-host-mfa-start.png` });
    await h.click('main button[type=submit]'); // start setup
    await h.screenshot({ path: `${SHOTS}/05-host-mfa-qr.png` });
    await h.fill('#code', '000000');
    await h.click('main button[type=submit]');
    assert.match(await h.textContent('body'), /didn’t work/);
    await h.fill('#code', '123456');
    await h.click('main button[type=submit]');
    await h.waitForURL(`${SITE}/host`);
    assert.match(await h.textContent('header'), /AK \(host\)/);
  });

  // a second player who never opts in
  const bobCtx = await browser.newContext();
  await step('second player without tracking', async () => {
    await signupAndVerify(await bobCtx.newPage(), 'bob@example.com', 'bob_99', 'another fine password');
  });

  async function recordSession(date, rows, { title = '', adjustments = [] } = {}) {
    await h.goto(`${SITE}/host/sessions/new`);
    await h.fill('#played_on', date);
    await h.fill('#stakes', '$1/$2');
    if (title) await h.fill('#title', title);
    for (const [i, r] of rows.entries()) {
      await h.selectOption(`#row_player_${i}`, r.player === 'guest' ? 'guest' : { label: r.player });
      if (r.guest) await h.fill(`#row_guest_${i}`, r.guest);
      await h.fill(`#row_initial_${i}`, r.initial);
      if (r.addons) await h.fill(`#row_addons_${i}`, r.addons);
      await h.fill(`#row_cashout_${i}`, r.cashout);
    }
    for (const [i, adj] of adjustments.entries()) {
      await h.fill(`#adj_amount_${i}`, adj.amount);
      await h.fill(`#adj_reason_${i}`, adj.reason);
    }
    await h.click('button[value=review]');
    await h.waitForSelector('#review');
  }

  await step('host cannot select a player who has not opted in', async () => {
    await h.goto(`${SITE}/host/sessions/new`);
    const options = await h.$$eval('#row_player_0 option', (os) => os.map((o) => o.textContent));
    assert.ok(options.includes('alice'));
    assert.ok(!options.some((o) => o.includes('bob_99')));
  });

  await step('host records a session, reviews the calculation, then saves', async () => {
    await recordSession('2026-10-16', [
      { player: 'alice', initial: '200', cashout: '120' },
      { player: 'guest', guest: 'Guest 1', initial: '200', cashout: '280' },
    ], { title: 'Mid-October game' });
    await h.click('button[value=save]');
    await h.waitForURL(/notice=created/);

    await recordSession('2026-10-30', [
      { player: 'alice', initial: '200', addons: '100 + 50', cashout: '525.50' },
      { player: 'guest', guest: 'Guest 1', initial: '200', cashout: '24.50' },
      { player: 'guest', guest: 'Guest 2', initial: '200', cashout: '0' },
    ], { title: 'Friday game', adjustments: [{ amount: '-1', reason: 'Chip count rounding' }] });
    const review = await h.textContent('#review');
    assert.match(review, /\+\$175\.50/);
    assert.match(review, /−\$175\.50/);
    assert.match(review, /Unexplained difference of −\$201\.00/);
    await h.locator('#review').screenshot({ path: `${SHOTS}/06-host-review.png` });
    await h.screenshot({ path: `${SHOTS}/06b-host-session-form.png`, fullPage: true });
    await h.click('button[value=save]');
    await h.waitForURL(/notice=created/);
  });

  await step('editing requires a reason and lands in the audit log', async () => {
    await h.goto(`${SITE}/host`);
    await h.screenshot({ path: `${SHOTS}/07-host-sessions.png` });
    await h.click('a:has-text("Oct 30, 2026")');
    await h.fill('#row_cashout_2', '1');
    await h.click('button[value=review]');
    assert.match(await h.textContent('body'), /Give a short reason/);
    await h.fill('#reason', 'Guest 2 cashed out $1 in change');
    await h.click('button[value=review]');
    await h.waitForSelector('#review');
    await h.click('button[value=save]');
    await h.waitForURL(/notice=updated/);
    await h.goto(`${SITE}/host/audit`);
    const audit = (await h.innerText('main')).replace(/\s+/g, ' ');
    console.log('   audit sample:', audit.slice(0, 400));
    assert.match(audit, /Guest 2 cash-out: \$0\.00 → \$1\.00/);
    assert.match(audit, /Guest 2 cashed out \$1 in change/);
    await h.screenshot({ path: `${SHOTS}/08-host-audit.png` });
  });

  await step('host player list shows tracking status', async () => {
    await h.goto(`${SITE}/host/players`);
    const body = await h.textContent('main');
    assert.match(body, /alice/);
    assert.match(body, /bob_99/);
    await h.screenshot({ path: `${SHOTS}/09-host-players.png` });
  });

  await step('host records expenses (per game and general) with exact totals', async () => {
    await h.goto(`${SITE}/host/expenses`);
    await h.fill('#spent_on', '2026-10-30');
    await h.selectOption('#category', 'food');
    await h.fill('#description', 'Pizza and pop for Friday');
    await h.fill('#amount', '64.50');
    await h.selectOption('#session_id', { label: 'Oct 30, 2026 · Friday game · $1/$2' });
    await h.click('main button[value=save]');
    await h.waitForURL(/notice=added/);
    await h.fill('#spent_on', '2026-10-20');
    await h.selectOption('#category', 'cards');
    await h.fill('#description', 'Two KEM decks');
    await h.fill('#amount', '108.99');
    await h.click('main button[value=save]');
    await h.waitForURL(/notice=added/);
    const body = (await h.innerText('main')).replace(/\s+/g, ' ');
    assert.match(body, /Total spent · 2026 \$173\.49/i);
    assert.match(body, /Not linked to a game \$108\.99/i);
    await h.screenshot({ path: `${SHOTS}/15-host-expenses.png`, fullPage: true });
  });

  await step('expense form rejects bad input and edits need a reason', async () => {
    await h.goto(`${SITE}/host/expenses`);
    await h.selectOption('#category', 'food');
    await h.fill('#description', 'x');
    await h.fill('#amount', '-5');
    await h.click('main button[value=save]');
    const body = await h.textContent('main');
    assert.match(body, /Describe what it was for/);
    await h.click('tr:has-text("Two KEM decks") a');
    await h.fill('#amount', '110.00');
    await h.click('main button[value=save]');
    assert.match(await h.textContent('main'), /Give a short reason/);
    await h.fill('#reason', 'Receipt included tax');
    await h.click('main button[value=save]');
    await h.waitForURL(/notice=updated/);
    await h.goto(`${SITE}/host/audit`);
    assert.match((await h.innerText('main')).replace(/\s+/g, ' '), /amount: \$108\.99 → \$110\.00/);
  });

  await step('the game page shows its expenses', async () => {
    await h.goto(`${SITE}/host`);
    await h.click('a:has-text("Oct 30, 2026")');
    const body = (await h.innerText('main')).replace(/\s+/g, ' ');
    assert.match(body, /Expenses for this game Total \$64\.50/);
  });

  await step('players cannot see or reach expenses', async () => {
    const r = await a.goto(`${SITE}/host/expenses`);
    assert.equal(r.status(), 404);
    const token = await accessToken(alice);
    const res = await fetch(`${MOCK}/rest/v1/rpc/host_list_expenses`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(res.status, 403);
    assert.match(await res.text(), /not_authorized/);
  });

  await step('player sees only their own results, stats and chart', async () => {
    await a.goto(`${SITE}/dashboard`);
    const body = await a.textContent('main');
    assert.match(body, /\+\$95\.50/); // lifetime: -80 + 175.50
    assert.match(body, /Sessions played\s*2/);
    assert.match(body, /\$550\.00/); // total buy-ins 200 + (200 + 100 + 50)
    assert.match(body, /\+\$47\.75/); // average
    assert.ok(!/Guest 1|Guest 2/.test(body));
    assert.ok(await a.$('svg[role=img]'));
    await a.screenshot({ path: `${SHOTS}/10-dashboard-mobile.png`, fullPage: true });
    const desk = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, storageState: await alice.storageState(), reducedMotion: 'reduce' })).newPage();
    await desk.goto(`${SITE}/dashboard`);
    await desk.screenshot({ path: `${SHOTS}/11-dashboard-desktop.png`, fullPage: true });
  });

  await step('password reset: generic response, single-use link, new password works', async () => {
    const p = await (await browser.newContext({ ...mobile })).newPage();
    await p.goto(`${SITE}/forgot-password`);
    await p.fill('#email', 'nobody@example.com');
    await p.click('button[type=submit]');
    await p.waitForURL(/check-email\?for=reset/);
    const generic = await p.textContent('main');
    await p.goto(`${SITE}/forgot-password`);
    await p.fill('#email', 'alice@example.com');
    await p.click('button[type=submit]');
    await p.waitForURL(/check-email\?for=reset/);
    assert.equal(await p.textContent('main'), generic, 'same message for unknown and known emails');
    const token = await latestToken('alice@example.com', 'recovery');
    await p.goto(`${SITE}/auth/confirm?token_hash=${token}&type=recovery`);
    await p.screenshot({ path: `${SHOTS}/12-reset-password-mobile.png` });
    await p.fill('#password', 'a brand new passphrase');
    await p.fill('#confirm', 'a brand new passphrase');
    await p.click('button[type=submit]');
    await p.waitForURL(/password-updated/);
    await p.goto(`${SITE}/auth/confirm?token_hash=${token}&type=recovery`);
    await p.fill('#password', 'another passphrase here');
    await p.fill('#confirm', 'another passphrase here');
    await p.click('button[type=submit]');
    assert.match(await p.textContent('main'), /can’t be used/);
    const q = await (await browser.newContext()).newPage();
    await login(q, 'alice@example.com', 'correct horse battery');
    assert.match(await q.textContent('main'), /Incorrect email or password/);
    await login(q, 'alice@example.com', 'a brand new passphrase');
    await q.waitForURL(/dashboard/);
  });

  await step('logging out requires POST and clears the session', async () => {
    await a.goto(`${SITE}/dashboard`);
    await a.click('form[action="/logout"] button');
    await a.waitForURL(`${SITE}/`);
    const r = await a.goto(`${SITE}/dashboard`);
    assert.match(a.url(), /login/);
    void r;
  });

  // ---- links from Supabase's default email templates (?code=…) ----
  const defaultLink = async (email) =>
    (await (await fetch(`${MOCK}/__test/default-link`, { method: 'POST', body: JSON.stringify({ email }) })).json()).code;

  await step('default-template verify link in the same browser signs the player in', async () => {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await p.goto(`${SITE}/signup`);
    await p.fill('#email', 'erin@example.com');
    await p.fill('#username', 'erin');
    await p.fill('#password', 'violet lanterns at dusk');
    await p.fill('#confirm', 'violet lanterns at dusk');
    await p.click('main button[type=submit]');
    await p.waitForURL(/check-email/);
    await p.goto(`${SITE}/auth/confirm?flow=signup&code=${await defaultLink('erin@example.com')}`);
    await p.waitForURL(/dashboard\?notice=verified/);
  });

  await step('default-template verify link in another browser says verified, please log in', async () => {
    const p = await (await browser.newContext()).newPage();
    await p.goto(`${SITE}/auth/confirm?code=${await defaultLink('erin@example.com')}`);
    assert.match(await p.textContent('main'), /Your email is verified/);
  });

  await step('default-template link that landed on the home page is forwarded', async () => {
    const p = await (await browser.newContext()).newPage();
    await p.goto(`${SITE}/?code=abcdefgh12345678`);
    await p.waitForURL(/\/auth\/confirm\?code=/);
    assert.match(await p.textContent('main'), /Your email is verified/);
  });

  await step('default-template error redirect shows the expired page', async () => {
    const p = await (await browser.newContext()).newPage();
    await p.goto(`${SITE}/auth/confirm?flow=recovery&error=access_denied&error_code=otp_expired`);
    assert.match(await p.textContent('main'), /can’t be used/);
    assert.ok(await p.$('a[href="/forgot-password"]'));
  });

  await step('default-template password reset lets the player choose a new password', async () => {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    // The code verifier cookie is created when the reset is requested in this browser.
    await p.goto(`${SITE}/forgot-password`);
    await p.fill('#email', 'erin@example.com');
    await p.click('main button[type=submit]');
    await p.waitForURL(/check-email/);
    await p.goto(`${SITE}/auth/confirm?flow=recovery&code=${await defaultLink('erin@example.com')}`);
    await p.fill('#password', 'copper kettle morning');
    await p.fill('#confirm', 'copper kettle morning');
    await p.click('main button[type=submit]');
    await p.waitForURL(/password-updated/);
    const q = await (await browser.newContext()).newPage();
    await login(q, 'erin@example.com', 'copper kettle morning');
    await q.waitForURL(/dashboard/);
  });

  await step('the recovery password step cannot be reused without the link', async () => {
    const p = await (await browser.newContext()).newPage();
    await login(p, 'erin@example.com', 'copper kettle morning');
    await p.waitForURL(/dashboard/);
    const r = await p.request.post(`${SITE}/auth/confirm`, {
      form: { mode: 'recovery_session', flow: 'recovery', password: 'attacker password 1', confirm: 'attacker password 1' },
      headers: { origin: SITE },
    });
    assert.match(await r.text(), /can’t be used/);
  });

  await step('public home page still renders with a Log in link', async () => {
    const p = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })).newPage();
    await p.goto(`${SITE}/`);
    assert.ok(await p.$('a[href="/login"]'));
    await p.screenshot({ path: `${SHOTS}/13-home-desktop.png` });
  });

  await step('no client-side errors', async () => {
    assert.deepEqual(errors, []);
  });

  await browser.close();
  const failed = results.filter((r) => r[0] === 'FAIL');
  console.log(`\n${results.length - failed.length}/${results.length} steps passed`);
  process.exit(failed.length ? 1 : 0);
})();
