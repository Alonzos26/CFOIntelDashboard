// Annual budget, budget to actual, and the running outlook.
// The budget is set once, in round numbers, during the last quarter of the fiscal year, then locked: it records what was planned
// with what was known at the time. Actuals are measured against it every month. Because reality drifts from any plan,
// an adjustable forecast (the outlook) runs beside it and shows where the year is now expected to land.
import { type MonthData, type PnlLines, type Ratio, type Settings, LINE_LABELS, PNL_LINES, addMonths, computePnl, fmtMoney, fmtPct, periodLabel, ratio, zeroPnl } from './core.ts';

/** Budget figures are whole hundreds of dollars. */
export const BUDGET_ROUND_CENTS = 10_000;
export const roundBudget = (cents: number) => Math.round(cents / BUDGET_ROUND_CENTS) * BUDGET_ROUND_CENTS || 0;
export const BUDGET_LINES = [...PNL_LINES, 'owner_adj'] as const;
export type BudgetLine = (typeof BUDGET_LINES)[number];
/** A specific thing the business plans for the year (a hire, a lease, a campaign), kept separate from the base so the reasoning stays visible. */
export interface PlannedItem { id: string; line: BudgetLine; description: string; monthlyCents: number; fromMonth: number; toMonth: number }
export interface BudgetData { fiscalYear: string; base: Record<BudgetLine, number[]>; items: PlannedItem[] }
export interface LineMonth { period: string; pnl: PnlLines; ownerAdj: number }

export const fyPeriods = (fiscalYear: string) => Array.from({ length: 12 }, (_, i) => addMonths(fiscalYear, i));
export const fiscalYearOf = (period: string, startMonth: number) => { const y = Number(period.slice(0, 4)), m = Number(period.slice(5, 7)); return `${m >= startMonth ? y : y - 1}-${String(startMonth).padStart(2, '0')}`; };
export const fyLabel = (fiscalYear: string) => (fiscalYear.endsWith('-01') ? `${fiscalYear.slice(0, 4)}` : `${periodLabel(fiscalYear)} – ${periodLabel(addMonths(fiscalYear, 11))}`);
/** Default deadline: the 15th of the last month before the budget year starts. */
export const defaultDeadline = (fiscalYear: string) => `${addMonths(fiscalYear, -1)}-15`;

export interface Season { currentFy: string; nextFy: string; inSeason: boolean; seasonOpens: string; suggestedFy: string }
/** Budget season is the last quarter of the client's fiscal year; the budget prepared then is for the following year. */
export function budgetSeason(today: string, startMonth: number): Season {
  const cur = fiscalYearOf(today.slice(0, 7), startMonth); const next = addMonths(cur, 12); const opens = addMonths(next, -3); const inSeason = today.slice(0, 7) >= opens;
  return { currentFy: cur, nextFy: next, inSeason, seasonOpens: opens, suggestedFy: inSeason ? next : cur };
}

export const emptyBase = (): Record<BudgetLine, number[]> => Object.fromEntries(BUDGET_LINES.map((k) => [k, Array(12).fill(0)])) as Record<BudgetLine, number[]>;
/** Starting figures from a forecast (and, for months already closed, from actuals), rounded. Months with no source are left at zero and reported. */
export function seedBudget(fiscalYear: string, source: LineMonth[]): { data: BudgetData; missing: string[] } {
  const by = new Map(source.map((m) => [m.period, m])); const base = emptyBase(); const missing: string[] = [];
  fyPeriods(fiscalYear).forEach((p, i) => { const m = by.get(p); if (!m) { missing.push(p); return; } for (const k of PNL_LINES) base[k][i] = roundBudget(m.pnl[k]); base.owner_adj[i] = roundBudget(m.ownerAdj); });
  return { data: { fiscalYear, base, items: [] }, missing };
}
/** Base plus planned items, month by month. */
export function budgetMonths(b: BudgetData): LineMonth[] {
  return fyPeriods(b.fiscalYear).map((period, i) => { const v = (k: BudgetLine) => (b.base[k]?.[i] ?? 0) + b.items.filter((x) => x.line === k && i >= x.fromMonth && i <= x.toMonth).reduce((a, x) => a + x.monthlyCents, 0);
    const pnl = zeroPnl(); for (const k of PNL_LINES) pnl[k] = v(k); return { period, pnl, ownerAdj: v('owner_adj') }; });
}

// ---------- Rows shown in the budget, in statement order ----------
export type RowKind = 'income' | 'cost' | 'subtotal';
export const BUDGET_ROWS: { key: string; label: string; kind: RowKind }[] = [
  { key: 'revenue', label: 'Revenue', kind: 'income' }, { key: 'cogs', label: LINE_LABELS.cogs, kind: 'cost' }, { key: 'gross_profit', label: 'Gross profit before labor', kind: 'subtotal' },
  { key: 'direct_labor', label: LINE_LABELS.direct_labor, kind: 'cost' }, { key: 'mgmt_labor', label: LINE_LABELS.mgmt_labor, kind: 'cost' }, { key: 'facilities', label: LINE_LABELS.facilities, kind: 'cost' }, { key: 'marketing', label: LINE_LABELS.marketing, kind: 'cost' },
  { key: 'payroll_taxes_benefits', label: LINE_LABELS.payroll_taxes_benefits, kind: 'cost' }, { key: 'other_opex', label: LINE_LABELS.other_opex, kind: 'cost' }, { key: 'operating_income', label: 'Operating income', kind: 'subtotal' },
  { key: 'other_income_expense', label: LINE_LABELS.other_income_expense, kind: 'income' }, { key: 'depreciation', label: LINE_LABELS.depreciation, kind: 'cost' }, { key: 'interest_expense', label: LINE_LABELS.interest_expense, kind: 'cost' }, { key: 'pretax', label: 'Pretax profit', kind: 'subtotal' },
  { key: 'owner_adj', label: 'Owner pay adjustment to market wage', kind: 'cost' }, { key: 'true_pretax', label: 'True pretax profit', kind: 'subtotal' },
];
const sumLines = (ms: LineMonth[]): LineMonth => { const pnl = zeroPnl(); let o = 0; for (const m of ms) { for (const k of PNL_LINES) pnl[k] += m.pnl[k]; o += m.ownerAdj; } return { period: ms.length ? ms[ms.length - 1].period : '', pnl, ownerAdj: o }; };
/** Every row's value for one month or a sum of months. */
export function rowValues(m: LineMonth, s: Settings): Record<string, number> {
  const r = computePnl(m.pnl, m.ownerAdj, s); return { ...m.pnl, owner_adj: m.ownerAdj, gross_profit: r.grossProfit, operating_income: r.operatingIncome, pretax: r.pretax, true_pretax: r.adjustedPretax };
}
export const budgetTotals = (b: BudgetData, s: Settings) => { const ms = budgetMonths(b); return { months: ms.map((m) => rowValues(m, s)), year: rowValues(sumLines(ms), s) }; };

// ---------- Budget to actual ----------
export interface Cmp { actual: number; budget: number; variance: number; pct: Ratio; favorable: boolean | null }
const cmp = (actual: number, budget: number, kind: RowKind): Cmp => { const v = actual - budget; return { actual, budget, variance: v, pct: ratio(v, Math.abs(budget), 'nothing was budgeted'), favorable: v === 0 ? null : kind === 'cost' ? v < 0 : v > 0 }; };
export interface BvaRow { key: string; label: string; kind: RowKind; month: Cmp; ytd: Cmp; fullYearBudget: number; drifting: boolean }
export interface Bva { fiscalYear: string; through: string; monthsElapsed: number; rows: BvaRow[]; grossProfitBridge: { volumeCents: number; marginCents: number; budgetGpPct: number | null; actualGpPct: number | null } | null; drivers: string[]; headline: string }
const act = (m: MonthData): LineMonth => ({ period: m.period, pnl: m.pnl, ownerAdj: m.ownerAdj });
/** Actuals against the budget for the latest month and the year to date. Null until the budget year has an actual month. */
export function budgetVsActual(b: BudgetData, actual: MonthData[], s: Settings, through?: string): Bva | null {
  const periods = fyPeriods(b.fiscalYear); const by = new Map(actual.map((m) => [m.period, m])); const have = periods.filter((p) => by.has(p) && (!through || p <= through)); if (!have.length) return null;
  const last = have[have.length - 1]; const n = periods.indexOf(last) + 1; const bm = budgetMonths(b); const year = rowValues(sumLines(bm), s);
  // Year to date compares like with like: only months that have actuals count on both sides.
  const idx = have.map((p) => periods.indexOf(p)); const cum = (upTo: number) => { const ii = idx.filter((i) => i < upTo); return { a: rowValues(sumLines(ii.map((i) => act(by.get(periods[i])!))), s), b: rowValues(sumLines(ii.map((i) => bm[i])), s) }; };
  const ytd = cum(n); const mA = rowValues(act(by.get(last)!), s), mB = rowValues(bm[n - 1], s); const l3 = idx.slice(-3).map((i) => ({ a: rowValues(act(by.get(periods[i])!), s), b: rowValues(bm[i], s) })); // the last three months, each on its own
  const rows: BvaRow[] = BUDGET_ROWS.map((r) => { const y = cmp(ytd.a[r.key], ytd.b[r.key], r.kind); const series = l3.map((x) => x.a[r.key] - x.b[r.key]);
    const drifting = idx.length >= 3 && y.pct.value !== null && Math.abs(y.pct.value) >= 0.05 && Math.sign(series[0]) === Math.sign(series[2]) && Math.sign(series[1]) === Math.sign(series[2]) && Math.abs(series[2]) >= 50_000 && Math.abs(series[2]) > Math.abs(series[1]) && Math.abs(series[1]) > Math.abs(series[0]);
    return { key: r.key, label: r.label, kind: r.kind, month: cmp(mA[r.key], mB[r.key], r.kind), ytd: y, fullYearBudget: year[r.key], drifting }; });
  const row = (k: string) => rows.find((r) => r.key === k)!; const rev = row('revenue').ytd, gp = row('gross_profit').ytd; const mb = rev.budget ? gp.budget / rev.budget : null, ma = rev.actual ? gp.actual / rev.actual : null;
  const bridge = mb !== null && ma !== null ? { volumeCents: Math.round(rev.variance * mb), marginCents: gp.variance - Math.round(rev.variance * mb), budgetGpPct: mb, actualGpPct: ma } : null;
  const $ = (c: number) => fmtMoney(Math.abs(c)); const pc = (r: Ratio) => (r.value === null ? '' : ` (${fmtPct(Math.abs(r.value))})`); const tp = row('true_pretax').ytd; const span = idx.length === 1 ? periodLabel(last) : `the ${idx.length} months through ${periodLabel(last)}`;
  const headline = tp.variance === 0 ? `True pretax profit for ${span} is on budget at ${fmtMoney(tp.actual)}.` : `True pretax profit for ${span} is ${fmtMoney(tp.actual)}, ${$(tp.variance)} ${tp.variance > 0 ? 'ahead of' : 'behind'} the budget of ${fmtMoney(tp.budget)}.`;
  const drivers: string[] = [];
  if (bridge && Math.abs(gp.variance) >= 50_000) drivers.push(`Gross profit is ${$(gp.variance)} ${gp.variance > 0 ? 'above' : 'below'} budget: ${$(bridge.volumeCents)} ${bridge.volumeCents >= 0 ? 'from higher' : 'from lower'} sales volume and ${$(bridge.marginCents)} ${bridge.marginCents >= 0 ? 'from a better' : 'from a weaker'} margin (${fmtPct(ma!)} against ${fmtPct(mb!)} budgeted).`);
  const impact = (r: BvaRow) => (r.kind === 'cost' ? -r.ytd.variance : r.ytd.variance);
  for (const r of rows.filter((x) => x.kind === 'cost' && x.key !== 'cogs' && Math.abs(x.ytd.variance) >= 50_000).sort((a, b2) => Math.abs(impact(b2)) - Math.abs(impact(a))).slice(0, 4))
    drivers.push(`${r.label} is ${$(r.ytd.variance)} ${r.ytd.variance > 0 ? 'over' : 'under'} budget${pc(r.ytd.pct)}, which ${impact(r) > 0 ? 'adds to' : 'takes from'} profit.`);
  for (const r of rows.filter((x) => x.drifting && x.kind !== 'subtotal')) drivers.push(`${r.label} has moved further from budget in each of the last three months${r.ytd.favorable ? ', in the business\'s favor' : ''}. If this is the new normal, update the outlook rather than waiting for it to come back.`);
  return { fiscalYear: b.fiscalYear, through: last, monthsElapsed: idx.length, rows, grossProfitBridge: bridge, drivers, headline };
}

// ---------- Outlook: where the year is now expected to land ----------
export interface OutlookRow { key: string; label: string; kind: RowKind; budget: number; actualYtd: number; forecastRest: number; projected: number; variance: number; favorable: boolean | null }
export interface Horizon { from: string; to: string; months: number; revenue: number; grossProfit: number; truePretax: number; truePretaxPct: Ratio }
export interface Outlook { fiscalYear: string; actualMonths: number; forecastMonths: number; uncoveredMonths: string[]; rows: OutlookRow[]; next3: Horizon | null; next12: Horizon | null; headline: string }
const horizon = (f: LineMonth[], n: number, s: Settings): Horizon | null => { const ms = f.slice(0, n); if (ms.length < n) return null; const v = rowValues(sumLines(ms), s); return { from: ms[0].period, to: ms[n - 1].period, months: n, revenue: v.revenue, grossProfit: v.gross_profit, truePretax: v.true_pretax, truePretaxPct: ratio(v.true_pretax, v.revenue, 'there is no revenue') }; };
/** Actual months so far plus the forecast for the rest of the budget year, against the budget; and the next three and twelve months of forecast. */
export function outlook(b: BudgetData, actual: MonthData[], forecast: LineMonth[], s: Settings): Outlook {
  const periods = fyPeriods(b.fiscalYear); const a = new Map(actual.map((m) => [m.period, act(m)])); const f = new Map(forecast.map((m) => [m.period, m])); const used: LineMonth[] = [], rest: LineMonth[] = []; const uncovered: string[] = [];
  for (const p of periods) { if (a.has(p)) used.push(a.get(p)!); else if (f.has(p)) rest.push(f.get(p)!); else uncovered.push(p); }
  const A = rowValues(sumLines(used), s), F = rowValues(sumLines(rest), s), B = rowValues(sumLines(budgetMonths(b)), s);
  const rows = BUDGET_ROWS.map((r) => { const projected = A[r.key] + F[r.key]; const c = cmp(projected, B[r.key], r.kind); return { key: r.key, label: r.label, kind: r.kind, budget: B[r.key], actualYtd: A[r.key], forecastRest: F[r.key], projected, variance: c.variance, favorable: c.favorable }; });
  const tp = rows.find((r) => r.key === 'true_pretax')!; const what = used.length ? `${used.length} month(s) of actuals and ${rest.length} of forecast` : 'the forecast alone';
  const headline = uncovered.length ? `The outlook does not yet cover ${uncovered.length} month(s) of this budget year.` : tp.variance === 0 ? `On ${what}, the year is expected to land on budget at ${fmtMoney(tp.projected)} of true pretax profit.` : `On ${what}, the year is expected to land at ${fmtMoney(tp.projected)} of true pretax profit, ${fmtMoney(Math.abs(tp.variance))} ${tp.variance > 0 ? 'above' : 'below'} the budget of ${fmtMoney(tp.budget)}.`;
  return { fiscalYear: b.fiscalYear, actualMonths: used.length, forecastMonths: rest.length, uncoveredMonths: uncovered, rows, next3: horizon(forecast, 3, s), next12: horizon(forecast, 12, s), headline };
}
/** Spread a new annual figure over the months in the line's existing pattern (evenly if the line is empty), in round numbers. */
export function spreadAnnual(months: number[], newTotalCents: number): number[] {
  const old = months.reduce((a, b) => a + b, 0); const out = months.map((m) => roundBudget(old !== 0 ? (m * newTotalCents) / old : newTotalCents / 12));
  return out;
}
