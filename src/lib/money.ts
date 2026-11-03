/**
 * Money helpers. All amounts are integer cents held as BigInt.
 * Nothing here ever uses floating-point arithmetic on money.
 */

/** Largest single amount the forms accept: $1,000,000.00 (matches DB checks). */
export const MAX_CENTS = 100_000_000n;

const AMOUNT_RE = /^\$?\s*((?:\d{1,3}(?:,\d{3})+)|\d+)(?:\.(\d{1,2}))?$/;

export type ParseResult = { ok: true; cents: bigint } | { ok: false; error: string };

/**
 * Parse a dollar amount typed by a person into integer cents.
 * Accepts "200", "200.5", "$1,250.75". Rejects negatives, >2 decimals, junk.
 */
export function parseDollars(input: string, { allowEmpty = false } = {}): ParseResult {
  const raw = (input ?? '').trim();
  if (raw === '') {
    return allowEmpty ? { ok: true, cents: 0n } : { ok: false, error: 'Enter an amount.' };
  }
  const m = AMOUNT_RE.exec(raw);
  if (!m) return { ok: false, error: 'Use a dollar amount like 200 or 1,250.50.' };
  const whole = BigInt(m[1]!.replaceAll(',', ''));
  const frac = BigInt((m[2] ?? '').padEnd(2, '0') || '0');
  const cents = whole * 100n + frac;
  if (cents > MAX_CENTS) return { ok: false, error: 'That amount is too large.' };
  return { ok: true, cents };
}

/**
 * Parse a list of rebuys/top-ups such as "100 + 50" or "100; 1,000 + 25.50".
 * Separators: "+", ";" or whitespace/new lines. Each amount must be > 0.
 */
export function parseAddOns(input: string): { ok: true; cents: bigint[] } | { ok: false; error: string } {
  const raw = (input ?? '').trim();
  if (raw === '') return { ok: true, cents: [] };
  const parts = raw.split(/[+;\s]+/).filter(Boolean);
  if (parts.length > 50) return { ok: false, error: 'Too many rebuys in one row (max 50).' };
  const out: bigint[] = [];
  for (const part of parts) {
    const r = parseDollars(part);
    if (!r.ok) return { ok: false, error: `“${part}” isn’t a valid amount. Separate rebuys with “+”.` };
    if (r.cents <= 0n) return { ok: false, error: 'Rebuys and top-ups must be more than $0.' };
    out.push(r.cents);
  }
  const total = out.reduce((a, b) => a + b, 0n);
  if (total > MAX_CENTS) return { ok: false, error: 'Total rebuys are too large.' };
  return { ok: true, cents: out };
}

/** Convert a value from the database (number or numeric string) to BigInt cents. */
export function toCents(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new Error('Unsafe money value from database');
    return BigInt(v);
  }
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return BigInt(v);
  throw new Error('Invalid money value from database');
}

/** BigInt cents -> JSON-safe integer for sending to Postgres. */
export function centsToJson(c: bigint): number {
  const n = Number(c);
  if (!Number.isSafeInteger(n)) throw new Error('Amount out of range');
  return n;
}

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Format cents as Canadian dollars, e.g. 125075n -> "$1,250.75".
 * `signed`: prefix "+" for gains and "−" (minus sign) for losses.
 */
export function formatCents(cents: bigint, { signed = false, compact = false } = {}): string {
  const neg = cents < 0n;
  const abs = neg ? -cents : cents;
  const dollars = abs / 100n;
  const rem = abs % 100n;
  let body = `$${groupThousands(dollars.toString())}`;
  if (!(compact && rem === 0n)) body += `.${rem.toString().padStart(2, '0')}`;
  if (neg) return `−${body}`;
  if (signed && cents > 0n) return `+${body}`;
  return body;
}

/** Cents -> plain editable string for form inputs ("1250.75", "200"). */
export function centsToInput(cents: bigint): string {
  const abs = cents < 0n ? -cents : cents;
  const rem = abs % 100n;
  const s = `${abs / 100n}${rem === 0n ? '' : '.' + rem.toString().padStart(2, '0')}`;
  return cents < 0n ? `-${s}` : s;
}

/** Signed dollar parse for adjustments (may be negative, never zero). */
export function parseSignedDollars(input: string): ParseResult {
  const raw = (input ?? '').trim().replace(/^[−–]/, '-');
  const neg = raw.startsWith('-');
  const r = parseDollars(neg ? raw.slice(1) : raw);
  if (!r.ok) return r;
  if (r.cents === 0n) return { ok: false, error: 'An adjustment can’t be $0.' };
  return { ok: true, cents: neg ? -r.cents : r.cents };
}

/** Integer division rounded half away from zero (for averages). */
export function divRound(n: bigint, d: bigint): bigint {
  if (d === 0n) throw new Error('Division by zero');
  const q = n / d;
  const r = n % d;
  if (r === 0n) return q;
  const twice = (r < 0n ? -r : r) * 2n;
  const absD = d < 0n ? -d : d;
  if (twice >= absD) return (n < 0n) !== (d < 0n) ? q - 1n : q + 1n;
  return q;
}
