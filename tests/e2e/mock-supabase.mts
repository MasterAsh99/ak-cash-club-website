/**
 * A small local stand-in for Supabase, for end-to-end testing only.
 *
 *   - /auth/v1/*  : the subset of Supabase Auth (GoTrue) the site uses
 *   - /rest/v1/rpc: PostgREST-style function calls, executed in PGlite as the
 *                   `anon` / `authenticated` role with the caller's JWT claims,
 *                   so the REAL migration, RLS and host checks are exercised.
 *   - /__test/*   : helpers (read the email outbox, make a user the host)
 *
 * Not a full implementation and not for production. TOTP codes: any code
 * "123456" is accepted.
 *
 * Run: node --experimental-strip-types tests/e2e/mock-supabase.mts
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { TestDb } from '../db/harness.ts';

const PORT = Number(process.env.MOCK_PORT ?? 54321);
const SECRET = 'e2e-only-secret';
const db = await TestDb.create();
// Outbox secret shared with the site via --var NOTIFY_SECRET (see run.mjs).
export const E2E_NOTIFY_SECRET = 'e2e-notify-secret-0123456789abcdef0123456789abcdef';
await db.owner(
  `insert into private.app_settings (key, value) values ('outbox_secret_sha256', encode(sha256(convert_to($1, 'UTF8')), 'hex'))`,
  [E2E_NOTIFY_SECRET],
);
// Emails "sent" through the Resend stand-in.
const resendSent: Array<Record<string, unknown> & { idempotencyKey: string | undefined; auth: string | undefined }> = [];

type User = { id: string; email: string; password: string; confirmed: boolean; meta: Record<string, unknown>; newEmail?: string };
type Factor = { id: string; status: 'unverified' | 'verified'; friendly_name: string; userId: string };
const users = new Map<string, User>(); // by id
const tokens = new Map<string, { userId: string; type: string; newEmail?: string }>(); // token_hash -> purpose
const refresh = new Map<string, { userId: string; aal: string }>();
const factors = new Map<string, Factor>();
const codes = new Map<string, string>(); // PKCE auth code -> userId (default-template links)
const outbox: Array<{ to: string; type: string; token_hash: string; redirect_to: string | null }> = [];

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');
function sign(payload: Record<string, unknown>) {
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}
function verify(token: string | undefined): Record<string, any> | null {
  if (!token) return null;
  const [h, b, s] = token.split('.');
  if (!h || !b || !s) return null;
  if (createHmac('sha256', SECRET).update(`${h}.${b}`).digest('base64url') !== s) return null;
  const p = JSON.parse(Buffer.from(b, 'base64url').toString());
  return p.exp > Date.now() / 1000 ? p : null;
}
const userJson = (u: User) => ({
  id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email,
  email_confirmed_at: u.confirmed ? new Date().toISOString() : null, user_metadata: u.meta, app_metadata: {},
  identities: [{ id: u.id, provider: 'email' }],
  factors: [...factors.values()].filter((f) => f.userId === u.id).map((f) => ({
    id: f.id, factor_type: 'totp', status: f.status, friendly_name: f.friendly_name, created_at: '', updated_at: '',
  })),
  created_at: '', updated_at: '',
});
function session(u: User, aal = 'aal1') {
  const now = Math.floor(Date.now() / 1000);
  const access = sign({ sub: u.id, email: u.email, role: 'authenticated', aud: 'authenticated', aal, amr: [{ method: 'password', timestamp: now }], session_id: randomUUID(), iat: now, exp: now + 3600 });
  const rt = randomBytes(16).toString('hex');
  refresh.set(rt, { userId: u.id, aal });
  return { access_token: access, token_type: 'bearer', expires_in: 3600, expires_at: now + 3600, refresh_token: rt, user: userJson(u) };
}
const byEmail = (email: string) => [...users.values()].find((u) => u.email === email.toLowerCase());
function newToken(userId: string, type: string, to: string, redirect: string | null, newEmail?: string) {
  const token_hash = randomBytes(20).toString('hex');
  tokens.set(token_hash, { userId, type, newEmail });
  outbox.push({ to, type, token_hash, redirect_to: redirect });
}

async function body(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString();
  return raw ? JSON.parse(raw) : {};
}
function send(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(data === undefined ? '' : JSON.stringify(data));
}
const authErr = (res: ServerResponse, status: number, code: string, msg: string) =>
  send(res, status, { code: status, error_code: code, msg });

async function handleAuth(req: IncomingMessage, res: ServerResponse, url: URL, path: string) {
  const claims = verify(req.headers.authorization?.replace(/^Bearer /, ''));
  const me = claims ? users.get(claims.sub) : undefined;
  const b = ['POST', 'PUT'].includes(req.method!) ? await body(req) : {};

  if (path === '/signup' && req.method === 'POST') {
    const email = String(b.email).toLowerCase();
    if (byEmail(email)) return send(res, 200, { id: randomUUID(), email, identities: [] }); // obfuscated
    try {
      const id = (await db.owner<{ id: string }>(`insert into auth.users (email, raw_user_meta_data) values ($1, $2::jsonb) returning id`, [email, JSON.stringify(b.data ?? {})]))[0]!.id;
      const u: User = { id, email, password: b.password, confirmed: false, meta: b.data ?? {} };
      users.set(id, u);
      newToken(id, 'signup', email, url.searchParams.get('redirect_to'));
      return send(res, 200, userJson(u));
    } catch {
      return authErr(res, 500, 'unexpected_failure', 'Database error saving new user');
    }
  }
  if (path === '/token') {
    const grant = url.searchParams.get('grant_type');
    if (grant === 'password') {
      const u = byEmail(String(b.email));
      if (!u || u.password !== b.password) return authErr(res, 400, 'invalid_credentials', 'Invalid login credentials');
      if (!u.confirmed) return authErr(res, 400, 'email_not_confirmed', 'Email not confirmed');
      return send(res, 200, session(u));
    }
    if (grant === 'pkce') {
      const userId = codes.get(b.auth_code);
      codes.delete(b.auth_code);
      const u = userId && users.get(userId);
      if (!u || !b.code_verifier) return authErr(res, 400, 'bad_code_verifier', 'code challenge does not match previously saved code verifier');
      return send(res, 200, session(u));
    }
    if (grant === 'refresh_token') {
      const r = refresh.get(b.refresh_token);
      const u = r && users.get(r.userId);
      if (!r || !u) return authErr(res, 400, 'refresh_token_not_found', 'Invalid Refresh Token');
      refresh.delete(b.refresh_token);
      return send(res, 200, session(u, r.aal));
    }
  }
  if (path === '/user' && req.method === 'GET') {
    if (!me) return authErr(res, 401, 'bad_jwt', 'invalid JWT');
    return send(res, 200, userJson(me));
  }
  if (path === '/user' && req.method === 'PUT') {
    if (!me) return authErr(res, 401, 'bad_jwt', 'invalid JWT');
    if (b.password) {
      if (b.password === me.password) return authErr(res, 422, 'same_password', 'New password should be different');
      me.password = b.password;
    }
    if (b.email) {
      newToken(me.id, 'email_change', me.email, url.searchParams.get('redirect_to'), b.email);
      newToken(me.id, 'email_change', b.email, url.searchParams.get('redirect_to'), b.email);
    }
    return send(res, 200, userJson(me));
  }
  if (path === '/logout') return send(res, 204, undefined);
  if (path === '/recover') {
    const u = byEmail(String(b.email));
    if (u) newToken(u.id, 'recovery', u.email, url.searchParams.get('redirect_to'));
    return send(res, 200, {});
  }
  if (path === '/resend') {
    const u = byEmail(String(b.email));
    if (u && !u.confirmed) newToken(u.id, 'signup', u.email, null);
    return send(res, 200, {});
  }
  if (path === '/verify' && req.method === 'POST') {
    const t = tokens.get(b.token_hash);
    if (!t || (t.type !== b.type && !(t.type === 'signup' && b.type === 'email'))) {
      return authErr(res, 403, 'otp_expired', 'Email link is invalid or has expired');
    }
    tokens.delete(b.token_hash);
    const u = users.get(t.userId)!;
    if (t.type === 'signup') u.confirmed = true;
    if (t.type === 'email_change') {
      const remaining = [...tokens.values()].some((x) => x.userId === u.id && x.type === 'email_change');
      if (remaining) return send(res, 200, { msg: 'Confirmation link accepted. Please proceed to confirm link sent to the other email' });
      u.email = t.newEmail!;
      await db.owner('update auth.users set email = $1 where id = $2', [u.email, u.id]);
    }
    return send(res, 200, session(u));
  }
  if (path === '/factors' && req.method === 'POST') {
    if (!me) return authErr(res, 401, 'bad_jwt', 'invalid JWT');
    const id = randomUUID();
    factors.set(id, { id, status: 'unverified', friendly_name: b.friendly_name, userId: me.id });
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180"><rect width="180" height="180" fill="#ffffff"/><rect x="20" y="20" width="40" height="40" fill="#000"/><rect x="120" y="20" width="40" height="40" fill="#000"/><rect x="20" y="120" width="40" height="40" fill="#000"/><text x="90" y="95" text-anchor="middle" font-size="14">QR (test)</text></svg>`;
    return send(res, 200, { id, type: 'totp', friendly_name: b.friendly_name, totp: { qr_code: svg, secret: 'TESTSECRET234567', uri: 'otpauth://totp/test' } });
  }
  const fm = /^\/factors\/([^/]+)(\/challenge|\/verify)?$/.exec(path);
  if (fm && me) {
    const f = factors.get(fm[1]!);
    if (!f || f.userId !== me.id) return authErr(res, 404, 'mfa_factor_not_found', 'Factor not found');
    if (req.method === 'DELETE') { factors.delete(f.id); return send(res, 200, { id: f.id }); }
    if (fm[2] === '/challenge') return send(res, 200, { id: randomUUID(), type: 'totp', expires_at: Math.floor(Date.now() / 1000) + 300 });
    if (fm[2] === '/verify') {
      if (b.code !== '123456') return authErr(res, 422, 'mfa_verification_failed', 'Invalid TOTP code entered');
      f.status = 'verified';
      return send(res, 200, session(me, 'aal2'));
    }
  }
  return authErr(res, 404, 'not_found', `mock: unsupported ${req.method} ${path}`);
}

async function handleRpc(req: IncomingMessage, res: ServerResponse, fn: string) {
  if (!/^[a-z_]+$/.test(fn)) return send(res, 404, { message: 'not found' });
  const claims = verify(req.headers.authorization?.replace(/^Bearer /, ''));
  const args = (await body(req)) as Record<string, unknown>;
  const meta = await db.owner<{ proretset: boolean; rettype: string }>(
    `select p.proretset, p.prorettype::regtype::text as rettype from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = $1`, [fn]);
  if (!meta.length) return send(res, 404, { code: 'PGRST202', message: `Could not find the function public.${fn}` });
  const keys = Object.keys(args).filter((k) => /^p_[a-z_]+$/.test(k));
  const params = keys.map((k) => (args[k] !== null && typeof args[k] === 'object' ? JSON.stringify(args[k]) : args[k]));
  const call = `public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')})`;
  const sql = meta[0]!.proretset ? `select * from ${call}` : `select ${call} as r`;
  try {
    const actor = claims ? { kind: 'user' as const, id: claims.sub, aal: claims.aal } : { kind: 'anon' as const };
    const rows = await db.as<Record<string, unknown>>(actor, sql, params);
    // PostgREST returns `date` columns as YYYY-MM-DD strings.
    for (const r of rows) for (const k of Object.keys(r)) {
      if (r[k] instanceof Date && /(^|_)(on|date)$/.test(k)) r[k] = (r[k] as Date).toISOString().slice(0, 10);
    }
    const fix = (v: unknown) => (typeof v === 'bigint' ? Number(v) : v instanceof Date ? v.toISOString() : v);
    const clean = rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Array.isArray(v) ? v.map(fix) : fix(v)])));
    if (meta[0]!.proretset) return send(res, 200, clean);
    const val = clean[0]?.r;
    return send(res, 200, meta[0]!.rettype === 'void' ? null : val);
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return send(res, err.code === '42501' ? 403 : 400, { code: err.code, message: err.message, details: null, hint: null });
  }
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url!, `http://127.0.0.1:${PORT}`);
    if (url.pathname.startsWith('/auth/v1')) return await handleAuth(req, res, url, url.pathname.slice(8));
    if (url.pathname.startsWith('/rest/v1/rpc/')) return await handleRpc(req, res, url.pathname.slice(13));
    if (url.pathname === '/__test/outbox') return send(res, 200, outbox);
    // Resend stand-in (the site's RESEND_API_URL points here in e2e runs).
    if (url.pathname === '/__test/resend/emails' && req.method === 'POST') {
      const auth = req.headers.authorization;
      if (auth !== 'Bearer re_e2e_key') return send(res, 401, { message: 'bad key' });
      const key = req.headers['idempotency-key'];
      const idempotencyKey = Array.isArray(key) ? key[0] : key;
      if (!resendSent.some((m) => m.idempotencyKey === idempotencyKey)) {
        resendSent.push({ ...((await body(req)) as Record<string, unknown>), idempotencyKey, auth });
      }
      return send(res, 200, { id: randomUUID() });
    }
    // Move a game night to late tonight (Toronto time), so it's "game day".
    if (url.pathname === '/__test/game-today' && req.method === 'POST') {
      const { id } = await body(req);
      await db.owner(`update public.game_nights set starts_at = ((now() at time zone 'America/Toronto')::date + time '23:59') at time zone 'America/Toronto' where id = $1`, [id]);
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/__test/resend/sent') return send(res, 200, resendSent);
    // Skip the 15-minute settle time for queued notification emails.
    if (url.pathname === '/__test/notify-due' && req.method === 'POST') {
      await db.owner(`update private.notification_outbox set send_after = now() - interval '1 minute' where status = 'pending'`);
      return send(res, 200, await db.owner(`select kind, status from private.notification_outbox`));
    }
    // Simulates Supabase's default template: verify on Supabase's side, then
    // redirect to the site with ?code=. Returns the code.
    if (url.pathname === '/__test/default-link' && req.method === 'POST') {
      const { email } = await body(req);
      const u = byEmail(email);
      if (!u) return send(res, 404, { error: 'no such user' });
      u.confirmed = true;
      const code = randomUUID();
      codes.set(code, u.id);
      return send(res, 200, { code });
    }
    if (url.pathname === '/__test/make-host' && req.method === 'POST') {
      const { email } = await body(req);
      const u = byEmail(email);
      if (!u) return send(res, 404, { error: 'no such user' });
      await db.makeHost(u.id);
      return send(res, 200, { ok: true });
    }
    send(res, 404, { message: `mock: unsupported ${req.method} ${url.pathname}` });
  } catch (e) {
    console.error(e);
    send(res, 500, { message: 'mock error' });
  }
}).listen(PORT, '127.0.0.1', () => console.log(`mock supabase on http://127.0.0.1:${PORT}`));
