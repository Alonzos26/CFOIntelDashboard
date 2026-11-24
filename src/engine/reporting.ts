// Reporting rhythms from Greg Crabtree, "Simple Numbers, Straight Talk, Big Profits!", ch. 8:
// weekly sales and productivity report (labor yield by week / month to date / year to date), the rolling-twelve P&L
// with pretax target, salary cap and labor-yield target, checks on the five operating-expense categories,
// and whether monthly reports arrive by the agreed day of the month.
import { type MonthData, type Ratio, type Settings, type WindowResult, fmtMoney, fmtPct, periodLabel, ratio, trailing } from './core.ts';
import { addDays, toDay } from './cash.ts';

// ---------- Sales and productivity report ----------
export interface ProdWeek { weekStart: string; revenueCents: number; cogsCents: number; directLaborCents: number; otherLaborCents: number | null }
export interface ProdRow {
  kind: 'month' | 'week' | 'month_total'; label: string; key: string;
  gpPct: Ratio; salesCents: number; gpCents: number; laborCents: number | null;
  weekLER: Ratio | null; mtdLER: Ratio; ytdLER: Ratio;
  /** Payroll that this row's gross profit supports at the target labor yield, and how far actual payroll is over (+) or under (−) it. */
  supportedLaborCents: number | null; laborOverUnderCents: number | null;
}
export interface Productivity { fiscalYearStart: string; rows: ProdRow[]; targetLER: number | null; weeksMissingLabor: number }
const NO_LABOR = 'office and management payroll was not entered for every week';

/**
 * Closed months come from the accounting P&L; the open month is built from weekly entries.
 * Gross profit is sales less non-labor direct costs; labor is all payroll as paid (direct plus office and management),
 * without payroll taxes or the owner market-wage adjustment, so months and weeks are measured the same way.
 */
export function salesProductivity(months: MonthData[], weeks: ProdWeek[], s: Settings, targetLER: number | null): Productivity | null {
  const ws = [...weeks].sort((a, b) => a.weekStart.localeCompare(b.weekStart));
  const anchor = ws.length ? ws[ws.length - 1].weekStart : months.length ? `${months[months.length - 1].period}-01` : null; if (!anchor) return null;
  const y = Number(anchor.slice(0, 4)), m = Number(anchor.slice(5, 7)); const fy = `${m >= s.fiscalYearStartMonth ? y : y - 1}-${String(s.fiscalYearStartMonth).padStart(2, '0')}`;
  const closed = months.filter((x) => x.period >= fy && x.period <= anchor.slice(0, 7)); const lastClosed = closed.length ? closed[closed.length - 1].period : '';
  const open = ws.filter((w) => w.weekStart >= `${fy}-01` && w.weekStart.slice(0, 7) > lastClosed);
  const sup = (gp: number, labor: number | null) => { const t = targetLER && targetLER > 0 ? Math.round(gp / targetLER) : null; return { supportedLaborCents: t, laborOverUnderCents: t === null || labor === null ? null : labor - t }; };
  const rows: ProdRow[] = []; let yGp = 0, yLabor = 0, yKnown = true, missing = 0;
  for (const x of closed) {
    const gp = x.pnl.revenue - x.pnl.cogs, labor = x.pnl.direct_labor + x.pnl.mgmt_labor; yGp += gp; yLabor += labor;
    rows.push({ kind: 'month', label: periodLabel(x.period), key: x.period, gpPct: ratio(gp, x.pnl.revenue, 'there is no revenue'), salesCents: x.pnl.revenue, gpCents: gp, laborCents: labor, weekLER: null, mtdLER: ratio(gp, labor, 'no labor cost was recorded'), ytdLER: ratio(yGp, yLabor, 'no labor cost was recorded'), ...sup(gp, labor) });
  }
  const na: Ratio = { value: null, reason: `Not available: ${NO_LABOR}.` };
  for (const mo of [...new Set(open.map((w) => w.weekStart.slice(0, 7)))]) {
    let mSales = 0, mGp = 0, mLabor = 0, mKnown = true;
    open.filter((w) => w.weekStart.slice(0, 7) === mo).forEach((w, i) => {
      const gp = w.revenueCents - w.cogsCents; const labor = w.otherLaborCents === null ? null : w.directLaborCents + w.otherLaborCents;
      mSales += w.revenueCents; mGp += gp; yGp += gp;
      if (labor === null) { mKnown = false; yKnown = false; missing++; } else { mLabor += labor; yLabor += labor; }
      rows.push({ kind: 'week', label: `Week ${i + 1}`, key: w.weekStart, gpPct: ratio(gp, w.revenueCents, 'no sales were recorded'), salesCents: w.revenueCents, gpCents: gp, laborCents: labor,
        weekLER: labor === null ? na : ratio(gp, labor, 'no labor cost was recorded'), mtdLER: mKnown ? ratio(mGp, mLabor, 'no labor cost was recorded') : na, ytdLER: yKnown ? ratio(yGp, yLabor, 'no labor cost was recorded') : na, ...sup(gp, labor) });
    });
    rows.push({ kind: 'month_total', label: `${periodLabel(mo)} to date`, key: `${mo}-total`, gpPct: ratio(mGp, mSales, 'no sales were recorded'), salesCents: mSales, gpCents: mGp, laborCents: mKnown ? mLabor : null, weekLER: null,
      mtdLER: mKnown ? ratio(mGp, mLabor, 'no labor cost was recorded') : na, ytdLER: yKnown ? ratio(yGp, yLabor, 'no labor cost was recorded') : na, ...sup(mGp, mKnown ? mLabor : null) });
  }
  return { fiscalYearStart: fy, rows, targetLER, weeksMissingLabor: missing };
}
/** Labor yield (gross profit per payroll dollar as paid) at which the window would have hit the pretax target. Null when the cap leaves no room for payroll. */
export function wagesLerTarget(w: WindowResult): number | null {
  const wages = w.directLaborCost + w.mgmtLaborCost; const cap = w.salaryCap - w.ownerAdj - (w.totalLabor - wages);
  return cap > 0 && w.grossProfit > 0 ? w.grossProfit / cap : null;
}

// ---------- Rolling-twelve P&L ----------
export interface R12Row {
  period: string; revenue: number; cogs: number; grossProfit: number; gpPct: Ratio;
  labor: number; marketing: number; facilities: number; payrollTaxesBenefits: number | null; otherOpex: number; otherNet: number;
  pretax: number; pretaxPct: Ratio; targetCents: number; aboveBelowCents: number;
  salaryCap: number; ler: Ratio; lerTarget: Ratio;
  stretchPct: number; additionalGpForStretchCents: number; productivityIncrease: Ratio;
}
/** One column of the rolling-twelve view. Labor includes the owner at market wage; profit is true pretax profit. */
export function r12Row(w: WindowResult, s: Settings): R12Row {
  const l = w.lines; const target = Math.round(s.pretaxTargetPct * l.revenue); const need = Math.max(0, Math.round(s.stretchPretaxPct * l.revenue) - w.adjustedPretax);
  return { period: w.to, revenue: l.revenue, cogs: l.cogs, grossProfit: w.grossProfit, gpPct: w.grossMarginPct, labor: w.adjustedLabor, marketing: l.marketing, facilities: l.facilities,
    payrollTaxesBenefits: s.burdenTreatment === 'labor' ? null : l.payroll_taxes_benefits, otherOpex: l.other_opex, otherNet: w.otherTotal, pretax: w.adjustedPretax, pretaxPct: w.adjustedPretaxPct,
    targetCents: target, aboveBelowCents: w.adjustedPretax - target, salaryCap: w.salaryCap, ler: w.adjustedLER,
    lerTarget: w.salaryCap > 0 ? ratio(w.grossProfit, w.salaryCap) : { value: null, reason: 'Not available: at this revenue the non-labor costs alone leave no room for labor at the profit target.' },
    stretchPct: s.stretchPretaxPct, additionalGpForStretchCents: need, productivityIncrease: ratio(need, w.grossProfit, 'there is no gross profit') };
}
/** The last `count` complete twelve-month windows, each ending one month later than the one before. */
export function rolling12Table(months: MonthData[], s: Settings, count = 13): R12Row[] {
  const out: R12Row[] = []; for (let i = Math.max(11, months.length - count); i < months.length; i++) { const w = trailing(months, i, 12, s); if (w?.complete) out.push(r12Row(w, s)); } return out;
}

// ---------- Operating expense category checks ----------
export interface ExpenseCheck { key: 'marketing' | 'payroll_taxes_benefits' | 'facilities' | 'other_opex'; label: string; value: string; tone: 'info' | 'warn'; text: string; spikeMonths?: string[] }
const median = (a: number[]) => { const b = [...a].sort((x, y) => x - y); const n = b.length; return n ? (n % 2 ? b[(n - 1) / 2] : (b[n / 2 - 1] + b[n / 2]) / 2) : 0; };
/** Evidence-based checks on the latest month. Each states the figures it rests on; none is a grade. */
export function expenseChecks(months: MonthData[], s: Settings): ExpenseCheck[] {
  const n = months.length; if (n < 7) return []; const cur = months[n - 1]; const prior = months.slice(Math.max(0, n - 13), n - 1); const out: ExpenseCheck[] = [];
  const sum = (ms: MonthData[], f: (m: MonthData) => number) => ms.reduce((a, m) => a + f(m), 0); const wages = (m: MonthData) => m.pnl.direct_labor + m.pnl.mgmt_labor;
  // Marketing: share of revenue over the trailing window. The 2–5% range is the book's franchise rule of thumb, not a sourced benchmark.
  const win = months.slice(Math.max(0, n - 12)); const mk = ratio(sum(win, (m) => m.pnl.marketing), sum(win, (m) => m.pnl.revenue));
  if (mk.value !== null) out.push({ key: 'marketing', label: 'Marketing', value: `${fmtPct(mk.value)} of revenue`, tone: mk.value < 0.02 ? 'warn' : 'info',
    text: `${fmtMoney(sum(win, (m) => m.pnl.marketing))} over the last ${win.length} months. ${mk.value < 0.02 ? 'That is under 2% of revenue. The book cites 2–5% as the usual franchise recommendation; it is a rule of thumb, not a benchmark for this industry.' : 'The book cites 2–5% of revenue as the usual franchise recommendation; it is a rule of thumb, not a benchmark for this industry.'} Whatever the level, track what the spending produces.` });
  // Payroll taxes and benefits should move with payroll.
  const base = ratio(sum(prior, (m) => m.pnl.payroll_taxes_benefits), sum(prior, wages)); const now = ratio(cur.pnl.payroll_taxes_benefits, wages(cur));
  if (base.value !== null && now.value !== null && base.value > 0) {
    const expected = Math.round(wages(cur) * base.value); const diff = cur.pnl.payroll_taxes_benefits - expected; const off = Math.abs(now.value - base.value) / base.value > 0.25 && Math.abs(diff) > 50_000;
    out.push({ key: 'payroll_taxes_benefits', label: 'Payroll taxes and benefits', value: `${fmtPct(now.value)} of payroll`, tone: off ? 'warn' : 'info',
      text: off ? `${periodLabel(cur.period)} was ${fmtMoney(cur.pnl.payroll_taxes_benefits)}, ${fmtMoney(Math.abs(diff))} ${diff > 0 ? 'more' : 'less'} than the ${fmtMoney(expected)} that the prior ${prior.length}-month rate of ${fmtPct(base.value)} of payroll would give. This cost should move with payroll; look for a mis-posted bill, a missed accrual, a benefit renewal or a tax deposit booked in the wrong month.`
        : `In line with the prior ${prior.length}-month rate of ${fmtPct(base.value)} of payroll.` });
  }
  // Facilities and other operating expenses are steady; a spike has a cause worth naming.
  for (const [key, label] of [['facilities', 'Facilities'], ['other_opex', 'Other operating expenses']] as const) {
    const hist = months.slice(Math.max(0, n - 24)); const med = median(hist.map((m) => m.pnl[key])); if (med <= 0) continue;
    const isSpike = (m: MonthData) => m.pnl[key] > med * 1.5 && m.pnl[key] - med > 50_000; const spikes = hist.filter(isSpike).map((m) => m.period); const curSpike = isSpike(cur);
    out.push({ key, label, value: fmtMoney(cur.pnl[key]), tone: curSpike ? 'warn' : 'info', spikeMonths: spikes,
      text: `${curSpike ? `${periodLabel(cur.period)} is ${fmtMoney(cur.pnl[key] - Math.round(med))} above the typical month of ${fmtMoney(Math.round(med))}. Find what drove it.` : `Typical month over the last ${hist.length}: ${fmtMoney(Math.round(med))}.`}${spikes.length ? ` Months well above typical: ${spikes.map(periodLabel).join(', ')}. If the same months recur each year, plan cash for them.` : ' No month stood well above typical.'}` });
  }
  return out;
}

// ---------- Monthly reporting rhythm ----------
export interface ReportRhythm { expectedPeriod: string; dueDate: string; status: 'on_time' | 'late' | 'due' | 'overdue'; days: number; text: string }
/** Were the reports for last month ready by the agreed day of this month? `approvedOn` is the date last month's figures were approved, if they were. */
export function reportRhythm(today: string, dueDay: number, approvedOn: string | null): ReportRhythm {
  const y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7)); const expected = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
  const due = `${today.slice(0, 7)}-${String(dueDay).padStart(2, '0')}`; const lbl = periodLabel(expected); const nth = `${dueDay}${dueDay === 1 ? 'st' : dueDay === 2 ? 'nd' : dueDay === 3 ? 'rd' : 'th'}`;
  if (approvedOn) { const late = toDay(approvedOn) - toDay(due); return late <= 0 ? { expectedPeriod: expected, dueDate: due, status: 'on_time', days: 0, text: `${lbl} reports were ready on time (target: the ${nth}).` } : { expectedPeriod: expected, dueDate: due, status: 'late', days: late, text: `${lbl} reports were ready ${late} day(s) after the ${nth}. Find the bottleneck in the monthly close.` }; }
  const d = toDay(today) - toDay(due);
  return d > 0 ? { expectedPeriod: expected, dueDate: due, status: 'overdue', days: d, text: `${lbl} reports are ${d} day(s) past the ${nth} and not yet approved.` } : { expectedPeriod: expected, dueDate: due, status: 'due', days: -d, text: `${lbl} reports are due by the ${nth}${d === 0 ? ' (today)' : ` (${-d} day(s))`}.` };
}

/** Bills are paid on one day of the week: a bill is paid on the last pay day on or before its due date. */
export function payDayOnOrBefore(dueDate: string, weekday: number): string {
  const dow = new Date(dueDate + 'T00:00:00Z').getUTCDay(); return addDays(dueDate, -((dow - weekday + 7) % 7));
}

// ---------- Rolling three: direction, read beside the rolling twelve ----------
// The rolling twelve is the number of record. Three months show a turn sooner but carry the season with them,
// so a difference only counts as a change when the same three months last year do not explain it.
export type RecentKey = 'profitability' | 'sales' | 'opex' | 'labor' | 'gross_profit';
export type RecentStatus = 'better' | 'worse' | 'in_line' | 'seasonal' | 'mixed';
export interface RecentSignal { key: RecentKey; label: string; kind: 'pct' | 'ratio' | 'money'; r3: number | null; r12: number | null; lastYear: number | null; status: RecentStatus | null; confirmed: boolean; text: string }
export interface Rolling3 { period: string; from: string; lastYearAvailable: boolean; signals: RecentSignal[] }
const R3_DEFS: { key: Exclude<RecentKey, 'sales'>; label: string; kind: 'pct' | 'ratio'; margin: number; higherIsBetter: boolean; get: (w: WindowResult) => number | null }[] = [
  { key: 'profitability', label: 'True pretax profit', kind: 'pct', margin: 0.02, higherIsBetter: true, get: (w) => w.adjustedPretaxPct.value },
  { key: 'gross_profit', label: 'Gross profit before labor', kind: 'pct', margin: 0.02, higherIsBetter: true, get: (w) => w.grossMarginPct.value },
  { key: 'labor', label: 'Labor yield', kind: 'ratio', margin: 0.15, higherIsBetter: true, get: (w) => w.adjustedLER.value },
  { key: 'opex', label: 'Operating expenses', kind: 'pct', margin: 0.02, higherIsBetter: false, get: (w) => w.opexPct.value },
];
export const SALES_MARGIN = 0.05;
/** Null until twelve complete months exist; the same-months-last-year check needs fifteen. */
export function rolling3(months: MonthData[], idx: number, s: Settings): Rolling3 | null {
  if (idx < 11 || idx >= months.length) return null; const r3 = trailing(months, idx, 3, s)!; const r12 = trailing(months, idx, 12, s)!; if (!r3.complete || !r12.complete) return null;
  const ly = idx >= 14 ? trailing(months, idx - 12, 3, s) : null; const f = (v: number | null, kind: string) => (v === null ? 'n/a' : kind === 'pct' ? fmtPct(v) : kind === 'ratio' ? `${v.toFixed(2)}x` : fmtMoney(v));
  // Labor yield follows the scorecard: gross profit per dollar of direct labor where the business has direct labor, all labor otherwise.
  const direct = r12.dLER.value !== null && r3.dLER.value !== null; const defs = R3_DEFS.map((d) => (d.key === 'labor' ? { ...d, label: direct ? 'Labor yield (direct labor)' : 'Labor yield (all labor)', get: (w: WindowResult) => (direct ? w.dLER.value : w.adjustedLER.value) } : d));
  const signals: RecentSignal[] = defs.map((d) => {
    const a = d.get(r3), b = d.get(r12), c = ly ? d.get(ly) : null; const sign = d.higherIsBetter ? 1 : -1; let status: RecentStatus | null = null; let confirmed = false;
    if (a !== null && b !== null) { const diff = (a - b) * sign;
      if (Math.abs(diff) < d.margin - 1e-12) status = 'in_line';
      else if (c === null) status = diff > 0 ? 'better' : 'worse';
      else { const dly = (a - c) * sign; if (Math.abs(dly) < d.margin - 1e-12) status = 'seasonal'; else if (Math.sign(dly) === Math.sign(diff)) { status = diff > 0 ? 'better' : 'worse'; confirmed = true; } else status = 'mixed'; } }
    const base = `${d.label} over the last three months is ${f(a, d.kind)}, against ${f(b, d.kind)} for the twelve months${c !== null ? ` and ${f(c, d.kind)} in the same three months last year` : ''}`;
    const text = status === null ? `${d.label}: not available for the last three months.` : status === 'in_line' ? `${base}: in line.` : status === 'seasonal' ? `${base}: different from the twelve months, but normal for this time of year.`
      : status === 'mixed' ? `${base}: ${(a! - b!) * sign > 0 ? 'ahead of the twelve months but behind last year' : 'behind the twelve months but ahead of last year'}, so no clear direction yet.` : `${base}: ${status === 'better' ? 'improving' : 'slipping'}${confirmed ? '' : ' (not yet checked against last year, so it may be seasonal)'}.`;
    return { key: d.key, label: d.label, kind: d.kind, r3: a, r12: b, lastYear: c, status, confirmed, text };
  });
  // Sales are compared with the same three months last year only: three months against twelve says nothing about sales.
  const sr = r3.lines.revenue, sl = ly ? ly.lines.revenue : null; const ch = sl ? (sr - sl) / sl : null; const st: RecentStatus | null = ch === null ? null : ch >= SALES_MARGIN ? 'better' : ch <= -SALES_MARGIN ? 'worse' : 'in_line';
  signals.splice(1, 0, { key: 'sales', label: 'Sales', kind: 'money', r3: sr, r12: r12.lines.revenue, lastYear: sl, status: st, confirmed: st === 'better' || st === 'worse',
    text: ch === null ? `Sales over the last three months were ${fmtMoney(sr)}. There is no same period last year to compare with yet.` : `Sales over the last three months were ${fmtMoney(sr)}, ${Math.abs(ch) < 0.0005 ? 'level with' : `${fmtPct(Math.abs(ch))} ${ch > 0 ? 'above' : 'below'}`} the same three months last year (${fmtMoney(sl!)})${st === 'in_line' ? ': in line.' : st === 'better' ? ': growing.' : ': falling.'}` });
  return { period: months[idx].period, from: r3.from, lastYearAvailable: !!ly, signals };
}
