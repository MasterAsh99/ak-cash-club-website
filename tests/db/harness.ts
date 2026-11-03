/**
 * Test harness: runs the real migration inside PGlite (Postgres compiled to
 * WebAssembly) with a minimal stand-in for Supabase's `auth` schema and roles.
 *
 * What is emulated (mirrors Supabase):
 *   - roles `anon` and `authenticated` (no RLS bypass)
 *   - auth.users, auth.uid(), auth.jwt() reading `request.jwt.claims`
 *   - Supabase's broad default privileges on new public tables/functions,
 *     so the migration's REVOKEs are genuinely exercised.
 */
import { PGlite, type Transaction } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations');

const SUPABASE_STUB = /* sql */ `
  create role anon nologin noinherit;
  create role authenticated nologin noinherit;

  create schema auth;
  create table auth.users (
    id uuid primary key default gen_random_uuid(),
    email text unique,
    raw_user_meta_data jsonb not null default '{}',
    created_at timestamptz not null default now()
  );

  create function auth.jwt() returns jsonb language sql stable as $$
    select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
  $$;
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(auth.jwt() ->> 'sub', '')::uuid
  $$;

  grant usage on schema auth to anon, authenticated;
  grant execute on function auth.jwt(), auth.uid() to anon, authenticated;
  grant usage on schema public to anon, authenticated;

  -- Supabase's default privileges (the migration must revoke these).
  alter default privileges in schema public grant all on tables to anon, authenticated;
  alter default privileges in schema public grant all on functions to anon, authenticated;
  alter default privileges in schema public grant all on sequences to anon, authenticated;
`;

export type Actor =
  | { kind: 'anon' }
  | { kind: 'user'; id: string; aal?: 'aal1' | 'aal2' };

export class TestDb {
  readonly pg: PGlite;
  private constructor(pg: PGlite) {
    this.pg = pg;
  }

  static async create(): Promise<TestDb> {
    const pg = new PGlite();
    await pg.exec(SUPABASE_STUB);
    for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
      await pg.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
    }
    return new TestDb(pg);
  }

  /** Create an auth user (as Supabase Auth would) and return its id. */
  async createUser(email: string, username: string): Promise<string> {
    const res = await this.pg.query<{ id: string }>(
      `insert into auth.users (email, raw_user_meta_data) values ($1, jsonb_build_object('username', $2::text)) returning id`,
      [email, username],
    );
    return res.rows[0]!.id;
  }

  /** Make a user the host — the step the owner runs in the SQL editor. */
  async makeHost(userId: string): Promise<void> {
    await this.pg.query(`insert into private.host_account (user_id) values ($1)`, [userId]);
  }

  /** Run SQL as an API role, exactly as PostgREST would (inside a transaction). */
  async as<T = Record<string, unknown>>(actor: Actor, sql: string, params: unknown[] = []): Promise<T[]> {
    return this.pg.transaction(async (tx: Transaction) => {
      if (actor.kind === 'anon') {
        await tx.query(`select set_config('request.jwt.claims', '{"role":"anon"}', true)`);
        await tx.exec('set local role anon');
      } else {
        const claims = JSON.stringify({ sub: actor.id, role: 'authenticated', aal: actor.aal ?? 'aal1' });
        await tx.query(`select set_config('request.jwt.claims', $1, true)`, [claims]);
        await tx.exec('set local role authenticated');
      }
      const res = await tx.query<T>(sql, params);
      return res.rows;
    });
  }

  /** Run as the database owner (like the Supabase SQL editor). */
  async owner<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.pg.query<T>(sql, params)).rows;
  }
}

/** Await a promise and return the error message (or null if it resolved). */
export async function errorOf(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
