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
  await page.waitForURL(/\/(games)?\?notice=verified|\/games$/);
}
async function login(page, email, password, next = '') {
  await page.goto(`${SITE}/login${next}`);
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.click('main button[type=submit]');
}

(async () => {
  const browser = await chromium.launch();
  const mobile = devices['iPhone 13'];
  const alice = await browser.newContext({ ...mobile, reducedMotion: 'reduce' });
  const a = await alice.newPage();
  const errors = [];
  a.on('pageerror', (e) => errors.push(e.message));


  await step('home: Sign up and Log in are visible without scrolling, on a phone and on desktop', async () => {
    for (const [name, ctxOpts] of [['mobile', { ...mobile }], ['desktop', { viewport: { width: 1280, height: 800 } }]]) {
      const p = await (await browser.newContext({ ...ctxOpts, reducedMotion: 'reduce' })).newPage();
      await p.goto(`${SITE}/`);
      const vh = p.viewportSize().height;
      for (const label of ['Sign up', 'Log in']) {
        const box = await p.locator(`main a:has-text("${label}")`).first().boundingBox();
        assert.ok(box && box.y + box.height <= vh, `${label} above the fold on ${name}`);
      }
      assert.match(await p.textContent('main'), /Create an account or log in to view upcoming games, request a seat, and track your poker results/);
      await p.screenshot({ path: `${SHOTS}/00-home-${name}.png` });
    }
  });

  await step('no Instagram reservation links anywhere; About the Club holds the details', async () => {
    for (const path of ['/', '/about', '/privacy', '/login', '/signup']) {
      const html = await (await fetch(`${SITE}${path}`)).text();
      assert.ok(!/ig\.me\//.test(html), `${path} has an Instagram DM link`);
      assert.ok(!/Reserve a seat on Instagram|reserved by Instagram|arranged personally through Instagram|DM to reserve/i.test(html), `${path} still sends people to Instagram to reserve`);
    }
    const p = await (await browser.newContext({ ...mobile, reducedMotion: 'reduce' })).newPage();
    await p.goto(`${SITE}/about`);
    for (const t of ['Our games', 'Equipment & setup', 'Food & drinks', 'Promotions & jackpots', 'Club information', 'Contact']) {
      assert.ok(await p.isVisible(`summary:has-text("${t}")`), t);
    }
    await p.click('summary:has-text("Food & drinks")');
    assert.match(await p.textContent('#food'), /BYOB/);
    await p.screenshot({ path: `${SHOTS}/00-about-mobile.png`, fullPage: true });
    await p.click('main a:has-text("Upcoming games")');
    await p.waitForURL(/\/login\?next=%2Fgames/);
  });

  await step('sign-up form rejects the host name and look-alikes', async () => {
    await a.goto(`${SITE}/signup`);
    await a.screenshot({ path: `${SHOTS}/01-signup-mobile.png` });
    for (const name of ['AK (host)', 'ak_host', 'AK-H0st']) {
      await a.fill('#email', 'x@example.com');
      await a.fill('#username', name);
      await a.fill('#password', 'correct horse battery');
      await a.fill('#confirm', 'correct horse battery');
      await a.click('main button[type=submit]');
      await a.waitForLoadState();
      assert.match(await a.textContent('body'), /isn’t allowed|reserved/, name);
    }
  });

  await step('player signs up, verifies email, lands on the games home; dashboard shows the opt-in', async () => {
    await signupAndVerify(a, 'alice@example.com', 'alice', 'correct horse battery');
    const home = (await a.innerText('main')).replace(/\s+/g, ' ');
    assert.match(home, /Hi, alice/);
    assert.match(home, /Your email is verified/);
    assert.match(home, /Upcoming games/);
    assert.ok(await a.isVisible('nav[aria-label="Members (mobile)"]'), 'bottom tab bar on phones');
    await a.goto(`${SITE}/dashboard`);
    assert.match(await a.textContent('body'), /Keep a private record/);
    await a.screenshot({ path: `${SHOTS}/02-dashboard-optin-mobile.png`, fullPage: true });
  });

  await step('signing up from "Upcoming games" returns you there after verifying', async () => {
    const p = await (await browser.newContext({ ...mobile })).newPage();
    await p.goto(`${SITE}/`);
    await p.click('main a:has-text("Sign up")');
    await p.waitForURL(/\/signup\?next=%2Fgames|\/signup\?next=\/games/);
    await p.fill('#email', 'dana@example.com');
    await p.fill('#username', 'dana');
    await p.fill('#password', 'quiet rivers run deep');
    await p.fill('#confirm', 'quiet rivers run deep');
    await p.click('main button[type=submit]');
    await p.waitForURL(/check-email/);
    const token = await latestToken('dana@example.com', 'signup');
    await p.goto(`${SITE}/auth/confirm?token_hash=${token}&type=email`);
    await p.click('main button[type=submit]');
    await p.waitForURL(`${SITE}/games`);
    assert.match(await p.textContent('h1'), /Upcoming games/);
  });

  await step('verification link is single-use', async () => {
    const token = (await outbox()).find((m) => m.to === 'alice@example.com').token_hash;
    const p = await (await browser.newContext()).newPage();
    await p.goto(`${SITE}/auth/confirm?token_hash=${token}&type=email`);
    await p.click('main button[type=submit]');
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


  await step('dashboard offers result emails; account shows email preferences', async () => {
    await a.goto(`${SITE}/dashboard`);
    assert.match(await a.textContent('main'), /Get an email when your result is posted\?/);
    await a.screenshot({ path: `${SHOTS}/18-dashboard-email-prompt-mobile.png` });
    await a.click('button[name=results_email][value=on]');
    await a.waitForURL(/notice=results-email-on/);
    assert.ok(!/Get an email when your result is posted/.test(await a.textContent('main')), 'prompt hidden once on');
    await a.goto(`${SITE}/account#notifications`);
    assert.equal(await a.isChecked('#notifications input[name=results_ready]'), true);
    assert.equal(await a.isChecked('#notifications input[name=game_announcements]'), false);
    assert.equal(await a.isChecked('#notifications input[name=seat_updates]'), true);
    await a.locator('#notifications').screenshot({ path: `${SHOTS}/19-account-notifications-mobile.png` });
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
    await h.goto(`${SITE}/account`);
    assert.match(await h.textContent('main'), /AK \(host\)/);
    assert.ok(await h.isVisible('nav[aria-label=Members] a[href="/host"]'), 'host link in the menu');
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
    await h.goto(`${SITE}/host/sessions`);
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

  await step('host records how players paid and ticks payouts as done', async () => {
    await h.goto(`${SITE}/host/sessions`);
    await h.click('a:has-text("Oct 30, 2026")');
    const panel = h.locator('#payments');
    assert.match(await panel.innerText(), /3 payouts to make/i);
    const row = (name) => panel.locator('[data-payment-row]', { hasText: name });
    await row('alice').locator('select[name=pay_buy_in]').selectOption('etransfer');
    await row('alice').locator('select[name=pay_payout]').selectOption('etransfer');
    await row('alice').locator('input[type=checkbox]').check();
    await row('Guest 1').locator('select[name=pay_buy_in]').selectOption('cash');
    await row('Guest 1').locator('select[name=pay_payout]').selectOption('cash');
    await row('Guest 1').locator('input[type=checkbox]').check();
    await row('Guest 2').locator('select[name=pay_buy_in]').selectOption('mixed');
    await panel.locator('button[type=submit]').click();
    await h.waitForURL(/payments=saved/);
    const after = await h.locator('#payments').innerText();
    assert.match(after, /Payments saved/);
    assert.match(after, /1 payout to make · \$1\.00/i);
    await h.locator('#payments').screenshot({ path: `${SHOTS}/16-host-payments.png` });
    await h.goto(`${SITE}/host/sessions`);
    assert.match(await h.innerText('main'), /1 to pay/);
    await h.goto(`${SITE}/host/audit`);
    assert.match((await h.innerText('main')).replace(/\s+/g, ' '), /alice paid out: no → yes/);
  });

  await step('players cannot touch payment records', async () => {
    const token = await accessToken(alice);
    const res = await fetch(`${MOCK}/rest/v1/rpc/host_update_payments`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ p_session_id: '00000000-0000-4000-8000-000000000000', p_rows: [] }),
    });
    assert.equal(res.status, 403);
    const r = await a.request.post(`${SITE}/host/sessions/00000000-0000-4000-8000-000000000000/payments`, { form: { pay_result_id: 'x' }, headers: { origin: SITE } });
    assert.equal(r.status(), 404);
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
    await h.goto(`${SITE}/host/sessions`);
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
    await p.click('main button[type=submit]');
    await p.waitForURL(/check-email\?for=reset/);
    const generic = await p.textContent('main');
    await p.goto(`${SITE}/forgot-password`);
    await p.fill('#email', 'alice@example.com');
    await p.click('main button[type=submit]');
    await p.waitForURL(/check-email\?for=reset/);
    assert.equal(await p.textContent('main'), generic, 'same message for unknown and known emails');
    const token = await latestToken('alice@example.com', 'recovery');
    await p.goto(`${SITE}/auth/confirm?token_hash=${token}&type=recovery`);
    await p.screenshot({ path: `${SHOTS}/12-reset-password-mobile.png` });
    await p.fill('#password', 'a brand new passphrase');
    await p.fill('#confirm', 'a brand new passphrase');
    await p.click('main button[type=submit]');
    await p.waitForURL(/password-updated/);
    await p.goto(`${SITE}/auth/confirm?token_hash=${token}&type=recovery`);
    await p.fill('#password', 'another passphrase here');
    await p.fill('#confirm', 'another passphrase here');
    await p.click('main button[type=submit]');
    assert.match(await p.textContent('main'), /can’t be used/);
    const q = await (await browser.newContext()).newPage();
    await login(q, 'alice@example.com', 'correct horse battery');
    assert.match(await q.textContent('main'), /Incorrect email or password/);
    await login(q, 'alice@example.com', 'a brand new passphrase');
    await q.waitForURL(`${SITE}/`);
  });

  await step('logging out requires POST and clears the session', async () => {
    await a.goto(`${SITE}/dashboard`);
    await a.click('form[action="/logout"] button');
    await a.waitForURL(`${SITE}/`);
    const r = await a.goto(`${SITE}/dashboard`);
    assert.match(a.url(), /login/);
    void r;
  });

  await step('a player keeps a private log of games outside the club', async () => {
    await login(a, 'alice@example.com', 'a brand new passphrase').catch(() => {});
    await a.goto(`${SITE}/poker-log`);
    if (a.url().includes('/login')) {
      await login(a, 'alice@example.com', 'a brand new passphrase', '?next=/poker-log');
      await a.waitForURL(/poker-log/);
    }
    assert.match(await a.textContent('main'), /Only record games played outside AK Cash Club/);
    // AK Cash Club games are refused
    await a.fill('#venue', 'AK Cash Club');
    await a.fill('#buy_in', '200');
    await a.fill('#cash_out', '300');
    await a.click('main button[value=save]');
    assert.match(await a.textContent('main'), /recorded by the host/);
    // real entries
    for (const [date, venue, format, buy, out, hrs] of [
      ['2026-10-18', 'Casino Rama', 'cash', '500', '810', '4'],
      ['2026-10-24', 'PokerStars', 'tournament', '55', '0', ''],
    ]) {
      await a.goto(`${SITE}/poker-log`);
      await a.fill('#played_on', date);
      await a.fill('#venue', venue);
      await a.selectOption('#format', format);
      await a.fill('#buy_in', buy);
      await a.fill('#cash_out', out);
      if (hrs) await a.fill('#duration', hrs);
      await a.click('main button[value=save]');
      await a.waitForURL(/notice=added/);
    }
    const body = (await a.innerText('main')).replace(/\s+/g, ' ');
    assert.match(body, /Net result \+\$255\.00/i);
    assert.match(body, /\+\$77\.50\/h/);
    await a.screenshot({ path: `${SHOTS}/17-poker-log-mobile.png`, fullPage: true });
    // the AK Cash Club dashboard is unaffected by the personal log
    await a.goto(`${SITE}/dashboard`);
    assert.match(await a.innerText('main'), /\+\$95\.50/);
  });

  await step('nobody else can see a player’s poker log, including the host', async () => {
    await h.goto(`${SITE}/poker-log`);
    const hostView = await h.innerText('main');
    assert.ok(!/Casino Rama|PokerStars/.test(hostView), 'host must not see alice’s log');
    const token = await accessToken(alice);
    const list = await (await fetch(`${MOCK}/rest/v1/rpc/my_log_list`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}',
    })).json();
    const r = await h.goto(`${SITE}/poker-log/${list[0].entry_id}`);
    assert.equal(r.status(), 404);
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
    await p.waitForURL(/\/\?notice=verified/);
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
    await q.waitForURL(`${SITE}/`);
  });

  await step('the recovery password step cannot be reused without the link', async () => {
    const p = await (await browser.newContext()).newPage();
    await login(p, 'erin@example.com', 'copper kettle morning');
    await p.waitForURL(`${SITE}/`);
    const r = await p.request.post(`${SITE}/auth/confirm`, {
      form: { mode: 'recovery_session', flow: 'recovery', password: 'attacker password 1', confirm: 'attacker password 1' },
      headers: { origin: SITE },
    });
    assert.match(await r.text(), /can’t be used/);
  });


  await step('"result is ready" email: sent by the scheduled job, no amounts, unsubscribe works', async () => {
    const today = new Date().toISOString().slice(0, 10);
    await h.goto(`${SITE}/host`);
    if (!h.url().includes('/host')) throw new Error('host signed out');
    await recordSession(today, [
      { player: 'alice', initial: '100', cashout: '160' },
      { player: 'guest', guest: 'Guest 1', initial: '100', cashout: '40' },
    ], { title: 'Email test game' });
    await h.click('button[value=save]');
    await h.waitForURL(/notice=created/);
    const queued = await (await fetch(`${MOCK}/__test/notify-due`, { method: 'POST' })).json();
    assert.ok(queued.some((q) => q.kind === 'results_ready' && q.status === 'pending'), 'email queued');
    const before = (await (await fetch(`${MOCK}/__test/resend/sent`)).json()).length;
    const cron = await fetch(`${SITE}/cdn-cgi/handler/scheduled?cron=${encodeURIComponent('*/10 * * * *')}`);
    assert.equal(cron.status, 200);
    let sent = [];
    for (let i = 0; i < 40 && sent.length <= before; i++) {
      await new Promise((r) => setTimeout(r, 250));
      sent = await (await fetch(`${MOCK}/__test/resend/sent`)).json();
    }
    const mail = sent.find((m) => m.subject && m.subject.includes(new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(`${today}T00:00:00Z`))));
    assert.ok(mail, 'email sent for today’s game');
    assert.deepEqual(mail.to, ['alice@example.com']);
    assert.equal(mail.from, 'AK Cash Club <no-reply@example.test>');
    assert.ok(!/\$\d|160|Guest 1|bob/.test(mail.html + mail.text), 'no amounts or other players');
    assert.ok(sent.every((m) => m.to[0] === 'alice@example.com'), 'only the opted-in player is emailed');
    // Running the job again doesn't resend.
    await fetch(`${SITE}/cdn-cgi/handler/scheduled`);
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal((await (await fetch(`${MOCK}/__test/resend/sent`)).json()).length, sent.length);

    const preview = await (await browser.newContext({ ...mobile, reducedMotion: 'reduce' })).newPage();
    await preview.setContent(mail.html);
    await preview.screenshot({ path: `${SHOTS}/20-results-email-mobile.png`, fullPage: true });

    const unsub = mail.headers['List-Unsubscribe'].slice(1, -1);
    assert.ok(unsub.startsWith(`${SITE}/unsubscribe?t=`));
    const u = await (await browser.newContext({ ...mobile, reducedMotion: 'reduce' })).newPage();
    await u.goto(unsub);
    assert.match(await u.textContent('main'), /Stop receiving “Your result is ready” emails\?/);
    await u.screenshot({ path: `${SHOTS}/21-unsubscribe-mobile.png` });
    await u.click('main button[type=submit]:not([name])');
    assert.match(await u.textContent('main'), /You won’t receive “Your result is ready” emails any more/);
    await a.goto(`${SITE}/account#notifications`);
    assert.equal(await a.isChecked('#notifications input[name=results_ready]'), false);
    assert.equal(await a.isChecked('#notifications input[name=seat_updates]'), true);
    const bad = await (await browser.newContext()).newPage();
    await bad.goto(`${SITE}/unsubscribe?t=${'0'.repeat(64)}&k=results_ready`);
    await bad.click('main button[type=submit]:not([name])');
    assert.match(await bad.textContent('main'), /isn’t valid/);
  });

  // ---- game nights ----
  let gameId = '';
  const b = await bobCtx.newPage();
  b.on('pageerror', (e) => errors.push(e.message));
  const inDays = (n) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + n * 86_400_000));

  await step('host opens a game night; members can request seats but never see who else or the address', async () => {
    await h.goto(`${SITE}/host/games/new`);
    await h.fill('#date', inDays(3));
    await h.fill('#time', '19:30');
    await h.fill('#stakes', '$1/$2');
    await h.fill('#seats', '2');
    await h.fill('#address', '123 Test Lane');
    await h.fill('#arrival_note', 'Side door');
    await h.check('input[name=auto_fill_waitlist]');
    await h.click('main form button[type=submit]');
    await h.waitForURL(/\/host\/games\/[0-9a-f-]{36}\?notice=created/);
    gameId = h.url().match(/games\/([0-9a-f-]{36})/)[1];

    await a.goto(`${SITE}/games`);
    assert.match((await a.innerText('main')).replace(/\s+/g, ' '), /Confirmed 0\/2 Waitlist 0 2 seats open/);
    await a.screenshot({ path: `${SHOTS}/24-games-mobile.png`, fullPage: true });
    await a.click(`form:has(input[value="${gameId}"]) button[type=submit]`);
    await a.waitForURL(/notice=requested/);

    const c = await (await browser.newContext({ ...mobile })).newPage();
    await signupAndVerify(c, 'carol@example.com', 'carol', 'third player passphrase');
    await c.goto(`${SITE}/games/${gameId}`);
    await c.click('form:has(input[value=request]) button[type=submit]');
    await c.waitForURL(/notice=requested/);

    await b.goto(`${SITE}/games/${gameId}`);
    await b.fill('input[name=note]', 'Might be 15 minutes late');
    await b.click('form:has(input[value=request]) button[type=submit]');
    await b.waitForURL(/notice=requested/);
    for (const p of [a, b]) {
      const text = await p.textContent('main');
      assert.ok(!/123 Test Lane|alice|bob_99/.test(text.replace(/Signed in as \w+/, '')), 'no address or other players');
    }
    assert.equal((await a.goto(`${SITE}/host/games/${gameId}`)).status(), 404, 'host page hidden from players');
  });

  await step('host confirms with one tap; when a confirmed player cancels, the waitlist moves up', async () => {
    await h.goto(`${SITE}/host/games/${gameId}`);
    assert.match(await h.textContent('#players'), /Might be 15 minutes late/);
    await h.screenshot({ path: `${SHOTS}/25-host-game-night.png`, fullPage: true });
    const req = (name, status) => h.locator(`#players li:has-text("${name}") form:has(input[name=status][value=${status}]) button`);
    await req('alice', 'confirmed').click();
    await h.waitForURL(/notice=confirmed/);
    await req('carol', 'confirmed').click();
    await h.waitForURL(/notice=confirmed/);
    assert.equal(await req('bob_99', 'confirmed').isDisabled(), true, 'table full');
    await req('bob_99', 'waitlisted').click();
    await h.waitForURL(/notice=waitlisted/);

    await b.goto(`${SITE}/games/${gameId}`);
    assert.match(await b.textContent('main'), /number 1 on the waitlist/);
    await a.goto(`${SITE}/dashboard`);
    assert.match(await a.textContent('main'), /Your next game/);
    await a.goto(`${SITE}/games/${gameId}`);
    assert.match(await a.textContent('main'), /Your seat is confirmed/);
    await a.screenshot({ path: `${SHOTS}/26-game-confirmed-mobile.png`, fullPage: true });
    await a.check('input[name=confirm_cancel]');
    await a.click('form:has(input[value=cancel]) button[type=submit]');
    await a.waitForURL(/notice=cancelled/);
    await b.goto(`${SITE}/games/${gameId}`);
    assert.match(await b.textContent('main'), /Your seat is confirmed/);
  });

  await step('seat emails are sent; the address appears only on game day, only to confirmed players', async () => {
    await fetch(`${MOCK}/__test/notify-due`, { method: 'POST' });
    await fetch(`${SITE}/cdn-cgi/handler/scheduled`);
    let sent = [];
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250));
      sent = await (await fetch(`${MOCK}/__test/resend/sent`)).json();
      if (sent.some((m) => m.to[0] === 'bob@example.com' && /seat is confirmed/.test(m.subject))) break;
    }
    const bobMail = sent.find((m) => m.to[0] === 'bob@example.com' && /seat is confirmed/.test(m.subject));
    assert.ok(bobMail, 'bob emailed when moved off the waitlist');
    assert.match(bobMail.text, /moved off the waitlist/);
    assert.ok(sent.some((m) => m.to[0] === 'alice@example.com' && /seat is confirmed/.test(m.subject)), 'alice emailed on confirm');
    assert.ok(!sent.some((m) => /123 Test Lane/.test(m.html + m.text)), 'address never emailed');

    await b.goto(`${SITE}/games/${gameId}`);
    assert.ok(!/123 Test Lane/.test(await b.textContent('main')), 'not before game day');
    await fetch(`${MOCK}/__test/game-today`, { method: 'POST', body: JSON.stringify({ id: gameId }) });
    await b.goto(`${SITE}/games/${gameId}`);
    assert.match(await b.textContent('main'), /123 Test Lane/);
    await b.screenshot({ path: `${SHOTS}/27-game-day-address.png`, fullPage: true });
    await a.goto(`${SITE}/games/${gameId}`);
    assert.ok(!/123 Test Lane/.test(await a.textContent('main')), 'cancelled player cannot see it');
  });

  await step('live game: check-in, buy-ins with payment method, cash-outs, finalize into a session', async () => {
    await h.goto(`${SITE}/host/games/${gameId}`);
    await h.click('a:has-text("Open live game")');
    await h.waitForURL(/\/host\/live\//);
    await h.click('button:has-text("Start live game")');
    await h.waitForSelector('#players article');
    const card = (name) => h.locator(`#players article:has(h2:has-text("${name}"))`);
    const act = async (name, kind, amount, method) => {
      await card(name).locator(`form:has(input[value=${kind}]) input[name=amount]`).fill(amount);
      await card(name).locator(`form:has(input[value=${kind}]) button[value=${method}]`).click();
      await h.waitForLoadState('load');
    };
    assert.equal(await card('bob_99').count(), 1, 'confirmed seat listed');
    assert.equal(await card('carol').count(), 1);
    await h.selectOption('select[name=player_id]', { label: 'alice' });
    await h.click('form:has(input[value=add_member]) button[type=submit]');
    await h.waitForSelector('#players article:has(h2:has-text("alice"))');
    await act('alice', 'buyin', '200', 'cash');
    await act('alice', 'buyin', '100', 'etransfer');
    await act('bob_99', 'buyin', '200', 'etransfer');
    await act('carol', 'buyin', '200', 'cash');
    await act('carol', 'buyin', 'abc', 'cash');
    assert.match(await h.textContent('[role=alert]'), /dollar amount/);
    const totals = (await h.innerText('section[aria-label=Totals]')).replace(/\s+/g, ' ');
    assert.match(totals, /Bought in \$700\.00/i);
    assert.match(await h.textContent('button[value=finalize], form:has(input[value=finalize]) button'), /Finalize/);
    assert.equal(await h.isDisabled('form:has(input[value=finalize]) button'), true, 'cannot finalize while players are still in');
    const phone = await (await browser.newContext({ ...mobile, storageState: await hostCtx.storageState(), reducedMotion: 'reduce' })).newPage();
    await phone.goto(h.url().split('#')[0]);
    await phone.locator('#players article').first().scrollIntoViewIfNeeded();
    await phone.screenshot({ path: `${SHOTS}/28-live-game-mobile.png` });
    await act('alice', 'cashout', '450.50', 'etransfer');
    await act('bob_99', 'cashout', '0', 'cash');
    await act('carol', 'cashout', '249.50', 'cash');
    const done = (await h.innerText('section[aria-label=Totals]')).replace(/\s+/g, ' ');
    assert.match(done, /Cashed out \$700\.00/i);
    assert.match(done, /Difference \$0\.00/i);
    await h.check('form:has(input[value=finalize]) input[name=confirm]');
    await h.click('form:has(input[value=finalize]) button');
    await h.waitForURL(/\/host\/sessions\/[0-9a-f-]{36}/);
    const body = (await h.innerText('main')).replace(/\s+/g, ' ');
    assert.match(body, /alice/);
    assert.match(body, /bob_99/);
    assert.match(body, /\+\$150\.50/);
    await h.locator('#payments').screenshot({ path: `${SHOTS}/29-live-finalized-payments.png` });
    await a.goto(`${SITE}/dashboard`);
    assert.match(await a.textContent('main'), /\+\$150\.50/);
  });


  // ---- host-managed attendance: guests, members, masking, waitlist ----
  let game2 = '';
  await step('host adds a guest and a registered player; members see Guest N and masked names only', async () => {
    await h.goto(`${SITE}/host/games/new`);
    await h.fill('#date', inDays(5));
    await h.fill('#time', '19:00');
    await h.fill('#stakes', '$0.50/$1');
    await h.fill('#seats', '3');
    await h.fill('#address', '9 Hidden Way');
    await h.click('main form button[type=submit]');
    await h.waitForURL(/\/host\/games\/[0-9a-f-]{36}\?notice=created/);
    game2 = h.url().match(/games\/([0-9a-f-]{36})/)[1];

    await h.fill('input[name=guest_name]', 'John Smith');
    await h.click('form:has(input[value=add_guest]) button[type=submit]');
    await h.waitForURL(/notice=added/);
    await h.click('summary:has-text("Add player")');
    await h.fill('input[name=guest_name]', 'john smith');
    await h.click('form:has(input[value=add_guest]) button[type=submit]');
    assert.match(await h.textContent('#add'), /already on this game/);
    assert.equal(await h.locator('#member-list option[value="alice"]').count(), 1, 'autocomplete lists members');
    await h.fill('input[name=username]', 'alice');
    await h.click('form:has(input[value=add_member]) button[type=submit]');
    await h.waitForURL(/notice=added/);
    await h.click('summary:has-text("Add player")');
    await h.fill('input[name=username]', 'nobody_here');
    await h.click('form:has(input[value=add_member]) button[type=submit]');
    assert.match(await h.textContent('#add'), /No member called/);
    await h.fill('input[name=guest_name]', 'Michael Brown');
    await h.click('form:has(input[value=add_guest]) button[type=submit]');
    await h.waitForURL(/notice=added/);
    const hostView = await h.innerText('#players');
    assert.match(hostView, /John Smith/);
    assert.match(hostView, /alice/);

    // A member's view: masked, and no real guest names anywhere in the page.
    const c = await (await browser.newContext({ ...mobile, reducedMotion: 'reduce' })).newPage();
    await login(c, 'carol@example.com', 'third player passphrase', `?next=/games/${game2}`);
    await c.waitForURL(new RegExp(`/games/${game2}`));
    const html = await c.content();
    assert.ok(!/John Smith|Michael Brown|9 Hidden Way/.test(html), 'no guest names or address in the member page');
    const who = (await c.innerText('#who-title + ul')).replace(/\s+/g, ' ');
    assert.equal(who, 'Guest 1 A***** Guest 2');
    assert.match(await c.textContent('main'), /This game is full\. You can join the waitlist/);
    assert.equal(await c.textContent('form:has(input[value=request]) button[type=submit]'), 'Join waitlist');
    await c.click('form:has(input[value=request]) button[type=submit]');
    await c.waitForURL(/notice=waitlisted/);
    await c.screenshot({ path: `${SHOTS}/33-member-game-masked-mobile.png`, fullPage: true });

    await a.goto(`${SITE}/games/${game2}`);
    assert.match((await a.innerText('#who-title + ul')).replace(/\s+/g, ' '), /alice \(you\)/);
    await a.goto(`${SITE}/`);
    assert.match(await a.innerText('main'), /My games/);
  });

  await step('host reorders the waitlist and gives a freed seat (no automatic confirmation)', async () => {
    await b.goto(`${SITE}/games/${game2}`);
    await b.click('form:has(input[value=request]) button[type=submit]');
    await b.waitForURL(/notice=waitlisted/);
    assert.match(await b.textContent('main'), /number 2 on the waitlist/);
    await h.goto(`${SITE}/host/games/${game2}`);
    await h.click('#waitlist li:has-text("bob_99") button[aria-label^="Move bob_99 up"]');
    await h.waitForURL(/notice=moved/);
    await b.goto(`${SITE}/games/${game2}`);
    assert.match(await b.textContent('main'), /number 1 on the waitlist/);
    // Free a seat: with auto-fill off nobody is confirmed until the host decides.
    await h.click('#players li:has-text("Michael Brown") button:has-text("Remove")');
    await h.waitForURL(/notice=removed/);
    await b.goto(`${SITE}/games/${game2}`);
    assert.match(await b.textContent('main'), /number 1 on the waitlist/);
    await h.click('#waitlist li:has-text("bob_99") button:has-text("Give seat")');
    await h.waitForURL(/notice=confirmed/);
    await b.goto(`${SITE}/games/${game2}`);
    assert.match(await b.textContent('main'), /Your seat is confirmed/);
    await h.screenshot({ path: `${SHOTS}/34-host-game-desktop.png`, fullPage: true });
    const phone = await (await browser.newContext({ ...mobile, storageState: await hostCtx.storageState(), reducedMotion: 'reduce' })).newPage();
    await phone.goto(`${SITE}/host/games/${game2}`);
    await phone.screenshot({ path: `${SHOTS}/35-host-game-mobile.png`, fullPage: true });
    await phone.goto(`${SITE}/host`);
    await phone.screenshot({ path: `${SHOTS}/36-host-home-mobile.png`, fullPage: true });
  });

  await step('all results: AK games and outside games together, with filters', async () => {
    await a.goto(`${SITE}/poker-log/results`);
    const body = (await a.innerText('main')).replace(/\s+/g, ' ');
    assert.match(body, /AK Cash Club/);
    assert.match(body, /Casino Rama/);
    await a.screenshot({ path: `${SHOTS}/30-all-results-mobile.png`, fullPage: true });
    await a.selectOption('#source', 'ak');
    await a.click('form[aria-label=Filters] button[type=submit]');
    await a.waitForURL(/source=ak/);
    const ak = (await a.innerText('main section[aria-labelledby=list-title]')).replace(/\s+/g, ' ');
    assert.ok(!/Casino Rama|PokerStars/.test(ak), 'outside games filtered out');
    assert.match(ak, /Recorded by the host/);
  });

  await step('hand notes with card pickers; duplicates rejected; private to the player', async () => {
    await a.goto(`${SITE}/poker-log/hands`);
    await a.fill('#title', 'Rivered top two');
    await a.selectOption('select[name=position]', 'BTN');
    await a.selectOption('select[name=hole_0]', 'As');
    await a.selectOption('select[name=hole_1]', 'Kd');
    await a.selectOption('select[name=board_0]', 'Ah');
    await a.selectOption('select[name=board_1]', '7c');
    await a.selectOption('select[name=board_2]', '2d');
    await a.selectOption('select[name=board_3]', 'Ks');
    assert.equal(await a.$eval('select[name=board_4] option[value=As]', (o) => o.disabled), true, 'used cards greyed out');
    await a.fill('#notes', 'Villain shoved the river. Snap call.');
    await a.click('form[data-hand-form] button[type=submit]');
    await a.waitForURL(/notice=saved/);
    assert.match(await a.textContent('main'), /Rivered top two/);
    assert.ok(await a.$('[aria-label="Ace of spades"]'));
    await a.screenshot({ path: `${SHOTS}/31-hand-notes-mobile.png`, fullPage: true });
    // Server-side check still applies if the picker is bypassed.
    const r = await a.request.post(`${SITE}/poker-log/hands`, { headers: { Origin: SITE }, form: { action: 'save', played_on: '2026-11-01', title: 'x', hole_0: 'As', hole_1: 'As' } });
    assert.match(await r.text(), /same card is used twice/);
    await h.goto(`${SITE}/poker-log/hands`);
    assert.ok(!/Rivered top two/.test(await h.textContent('main')), 'host cannot see it');
  });

  await step('responsible play: loss limit, session reminder, and a break that pauses seat requests', async () => {
    await a.goto(`${SITE}/account#play-safely`);
    await a.fill('#limit', '300');
    await a.click('form:has(input[value=loss_limit]) button:has-text("Set limit")');
    assert.match(await a.textContent('#play-safely'), /monthly loss limit is set/);
    await a.fill('#limit', '500');
    await a.click('form:has(input[value=loss_limit]) button:has-text("Set limit")');
    assert.match(await a.textContent('#play-safely'), /takes effect in 24 hours/);
    await a.selectOption('#minutes', '240');
    await a.click('form:has(input[value=session_reminder]) button[type=submit]');
    assert.match(await a.textContent('#play-safely'), /after 4 hours/);
    await a.locator('#play-safely').screenshot({ path: `${SHOTS}/32-play-safely-mobile.png` });

    await b.goto(`${SITE}/account#play-safely`);
    await b.selectOption('#days', '7');
    await b.click('form:has(input[value=break]) button[type=submit]');
    assert.match(await b.textContent('#play-safely'), /Please tick the box/);
    await b.check('input[name=confirm_break]');
    await b.click('form:has(input[value=break]) button[type=submit]');
    assert.match(await b.textContent('#play-safely'), /Your break has started/);
    await b.goto(`${SITE}/games`);
    assert.match(await b.textContent('main'), /You’re taking a break/);
    assert.equal(await b.locator('form:has(input[value=request])').count(), 0, 'no request buttons during a break');
    assert.match(await b.textContent('main'), /1-866-531-2600|taking a break/);
  });

  await step('installable app: manifest, icons, offline page; member pages never cached', async () => {
    const m = await (await fetch(`${SITE}/manifest.webmanifest`)).json();
    assert.equal(m.start_url, '/');
    assert.equal(m.display, 'standalone');
    for (const icon of m.icons) assert.equal((await fetch(`${SITE}${icon.src}`)).status, 200, icon.src);
    assert.equal((await fetch(`${SITE}/offline/`)).status, 200);
    await a.goto(`${SITE}/account#install`);
    assert.match(await a.textContent('#install'), /Add to Home Screen/);
    await a.locator('#install').screenshot({ path: `${SHOTS}/22-account-install-mobile.png` });
    const swOk = await a.evaluate(async () => {
      const reg = await Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(() => r(null), 8000))]);
      return Boolean(reg && reg.active);
    });
    assert.ok(swOk, 'service worker active');
    await a.goto(`${SITE}/dashboard`);
    await a.goto(`${SITE}/poker-log`);
    const cached = await a.evaluate(async () => {
      const out = [];
      for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) out.push(new URL(r.url).pathname);
      return out;
    });
    assert.ok(cached.includes('/offline/'), 'offline page cached');
    assert.ok(!cached.some((p) => /^\/(dashboard|account|poker-log|host)/.test(p)), `member pages cached: ${cached}`);
    await alice.setOffline(true);
    await a.goto(`${SITE}/dashboard`).catch(() => {});
    assert.match(await a.textContent('main'), /You’re offline/);
    await a.screenshot({ path: `${SHOTS}/23-offline-mobile.png` });
    await alice.setOffline(false);
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
