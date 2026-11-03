/**
 * Geometry for the cumulative profit/loss chart, rendered as server-side SVG.
 * Money stays BigInt; only pixel positions are converted to Number.
 */
import { formatCents } from './money';
import { formatDate, type PlayerStats } from './stats';

export interface ChartPoint {
  x: number;
  y: number;
  date: string;
  dateLabel: string;
  total: bigint;
  net: bigint;
  label: string; // full tooltip text
}

export interface ChartModel {
  width: number;
  height: number;
  plot: { left: number; right: number; top: number; bottom: number };
  zeroY: number;
  linePath: string;
  areaPath: string;
  points: ChartPoint[];
  yTicks: Array<{ y: number; label: string }>;
  xTicks: Array<{ x: number; label: string }>;
  summary: string;
}

const DAY_MS = 86_400_000;

function dayNumber(iso: string): number {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d) / DAY_MS;
}

/** "Nice" tick step in cents (1, 2, 2.5, 5 × 10^n dollars). */
function niceStep(rangeCents: bigint, target = 4): bigint {
  const raw = rangeCents / BigInt(target) || 1n;
  let mag = 1n;
  while (mag * 10n <= raw) mag *= 10n;
  for (const mult of [1n, 2n, 5n, 10n]) {
    if (mag * mult >= raw) return mag * mult;
  }
  return mag * 10n;
}

export function buildChart(stats: PlayerStats, width = 720, height = 300): ChartModel | null {
  const series = stats.cumulative;
  if (series.length === 0) return null;

  const plot = { left: width < 500 ? 56 : 64, right: width - 12, top: 16, bottom: height - 36 };

  // Y domain always includes zero so gains/losses are read against break-even.
  let min = 0n;
  let max = 0n;
  for (const p of series) {
    if (p.total < min) min = p.total;
    if (p.total > max) max = p.total;
  }
  if (min === max) max = min + 10_000n; // flat line: give it room ($100)
  const step = niceStep(max - min);
  const lo = min < 0n ? ((min - step + 1n) / step) * step : 0n;
  const hi = max > 0n ? ((max + step - 1n) / step) * step : 0n;
  const span = Number(hi - lo) || 1;
  const yOf = (c: bigint) => plot.bottom - ((Number(c - lo) / span) * (plot.bottom - plot.top));

  // X: real dates; same-day sessions are spaced slightly apart.
  const first = dayNumber(series[0]!.result.playedOn);
  const last = dayNumber(series[series.length - 1]!.result.playedOn);
  const daysSpan = Math.max(last - first, 1);
  const sameDayIndex = new Map<string, number>();
  const xOf = (iso: string) => {
    const k = sameDayIndex.get(iso) ?? 0;
    sameDayIndex.set(iso, k + 1);
    // Leave a short run-in so the line visibly starts from break-even.
    const x0 = plot.left + 28;
    const base = series.length === 1 ? (x0 + plot.right) / 2 : x0 + ((dayNumber(iso) - first) / daysSpan) * (plot.right - x0);
    return Math.min(plot.right, base + k * 6);
  };

  // Start the line at break-even just before the first session.
  const points: ChartPoint[] = series.map(({ result, total }) => {
    const dateLabel = formatDate(result.playedOn);
    return {
      x: xOf(result.playedOn),
      y: yOf(total),
      date: result.playedOn,
      dateLabel,
      total,
      net: result.net,
      label: `${dateLabel} · ${result.stakes} · session ${formatCents(result.net, { signed: true })} · running total ${formatCents(total, { signed: true })}`,
    };
  });

  const zeroY = yOf(0n);
  const startX = plot.left;
  const coords = [{ x: startX, y: zeroY }, ...points.map((p) => ({ x: p.x, y: p.y }))];
  const linePath = coords.map((c, i) => `${i ? 'L' : 'M'}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ');
  const areaPath = `${linePath} L${coords[coords.length - 1]!.x.toFixed(1)},${zeroY.toFixed(1)} Z`;

  const yTicks: ChartModel['yTicks'] = [];
  for (let v = lo; v <= hi; v += step) {
    yTicks.push({ y: yOf(v), label: formatCents(v, { signed: true, compact: true }) });
  }

  // Up to 4 date labels, evenly chosen from the actual sessions.
  const xTicks: ChartModel['xTicks'] = [];
  const want = Math.min(width < 500 ? 2 : 4, points.length);
  const used = new Set<number>();
  for (let i = 0; i < want; i++) {
    const idx = want === 1 ? 0 : Math.round((i * (points.length - 1)) / (want - 1));
    if (used.has(idx)) continue;
    used.add(idx);
    xTicks.push({ x: points[idx]!.x, label: formatDate(points[idx]!.date, 'short') });
  }

  const end = series[series.length - 1]!.total;
  const summary = `Cumulative result over ${series.length} session${series.length === 1 ? '' : 's'}, from ${formatDate(series[0]!.result.playedOn)} to ${formatDate(series[series.length - 1]!.result.playedOn)}. Current running total ${formatCents(end, { signed: true })}.`;

  return { width, height, plot, zeroY, linePath, areaPath, points, yTicks, xTicks, summary };
}
