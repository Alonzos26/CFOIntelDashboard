// Read models: turn stored actuals + settings into the views the UI renders. All figures come from src/engine.
import {
  type BsLines, type MonthData, type PeriodStatus, type PnlLines, type Settings, type WindowResult, BS_LINES, ENGINE_VERSION, PNL_LINES,
  addMonths, bsImbalance, cashFlowMonth, computePnl, coreCapital, dso, sweatEquity, mergeSettings, monthsBetween, periodLabel, rolling12, trailing, ytd, zeroBs, zeroPnl,
} from '../engine/core.ts';
import { buildScorecard, type Scorecard } from '../engine/scorecard.ts';
import { defaultDrivers, forecastMonths } from '../engine/forecast.ts';
import { type HiringBaseline } from '../engine/hiring.ts';
import { type CashItem, type CashOverrides, forecast13, nonPnlMonthly, weekStart } from '../engine/cash.ts';
import { type WeeklyEntry, draftBriefing, weeklyRows } from '../engine/weekly.ts';
import { evaluateFormula, financialVars, formulaVariables, isFinancialVariable, kpiStatus } from '../engine/kpi.ts';
import { generateInsights } from '../engine/insights.ts';
import { cashWalk, fourForces, nextEstimatedTaxDate } from '../engine/fourforces.ts';
import { addDays, occurrences, twoWeekView } from '../engine/cash.ts';
import { capitalView } from '../engine/capital.ts';
import { type ValuationBase } from '../engine/valuation.ts';
import { type Levers, whatIf } from '../engine/whatif.ts';
import { expenseChecks, reportRhythm, rolling12Table, rolling3, salesProductivity, wagesLerTarget } from '../engine/reporting.ts';
import { type Db } from './db.ts';

export interface Month extends MonthData { missing: boolean }

export function loadSettings(db: Db, tenantId: string): Settings {
  const t = db.get('SELECT settings_json FROM tenants WHERE id = ?', tenantId);
  return mergeSettings(t ? JSON.parse(t.settings_json) : {});
}

/** Monthly actuals for one tenant. `approvedOnly` (client view) returns only the unbroken run of advisor-approved months. */
export function loadMonths(db: Db, tenantId: string, approvedOnly: boolean): Month[] {
  const rows = db.all(`SELECT f.period, a.statement, a.line, SUM(f.amount_cents * a.sign) AS cents FROM facts f JOIN accounts a ON a.id = f.account_id
    WHERE f.tenant_id = ? AND f.active = 1 AND a.line IS NOT NULL AND a.line NOT IN ('ignore','control_pretax') GROUP BY f.period, a.statement, a.line`, tenantId);
  const pnl = new Map<string, PnlLines>(), bs = new Map<string, BsLines>();
  for (const r of rows) {
    if (r.statement === 'pnl') { const p = pnl.get(r.period) ?? zeroPnl(); (p as any)[r.line] = r.cents; pnl.set(r.period, p); }
    else { const b = bs.get(r.period) ?? zeroBs(); (b as any)[r.line] = r.cents; bs.set(r.period, b); }
  }
  if (!pnl.size) return [];
  const status = new Map(db.all('SELECT period, status FROM period_status WHERE tenant_id = ?', tenantId).map((r) => [r.period as string, r.status as PeriodStatus]));
  const adj = new Map(db.all("SELECT period, SUM(amount_cents) AS cents FROM adjustments WHERE tenant_id = ? AND kind = 'owner_comp' AND reversed_at IS NULL GROUP BY period", tenantId).map((r) => [r.period as string, r.cents as number]));
  const periods = [...pnl.keys()].sort();
  const out: Month[] = [];
  for (let p = periods[0]; p <= periods[periods.length - 1]; p = addMonths(p, 1)) {
    out.push({ period: p, pnl: pnl.get(p) ?? zeroPnl(), bs: bs.get(p) ?? null, ownerAdj: adj.get(p) ?? 0, status: status.get(p) ?? 'preliminary', missing: !pnl.has(p) });
  }
  if (!approvedOnly) return out;
  let end = out.length - 1; while (end >= 0 && out[end].status !== 'approved') end--;
  let start = end; while (start > 0 && out[start - 1].status === 'approved') start--;
  return end < 0 ? [] : out.slice(start, end + 1);
}

export type View = 'monthly' | 'quarterly' | 'ytd' | 'r12';
const VIEW_LABEL: Record<View, string> = { monthly: 'Month', quarterly: 'Quarter (trailing 3 months)', ytd: 'Year to date', r12: 'Rolling 12 months' };
function windowAt(months: Month[], idx: number, view: View, s: Settings): WindowResult | null {
  if (idx < 0) return null;
  return view === 'monthly' ? trailing(months, idx, 1, s) : view === 'quarterly' ? trailing(months, idx, 3, s) : view === 'ytd' ? ytd(months, idx, s) : rolling12(months, idx, s);
}
function operatingCash(months: Month[], w: WindowResult | null): number | null {
  if (!w) return null; let total = 0;
  for (let i = 0; i < months.length; i++) {
    const m = months[i]; if (m.period < w.from || m.period > w.to) continue;
    if (i === 0 || !m.bs || !months[i - 1].bs) return null;
    total += cashFlowMonth(months[i - 1].bs!, m.bs, m.pnl).operations;
  }
  return total;
}

export interface KpiCard {
  key: string; label: string; kind: 'money' | 'pct' | 'ratio' | 'months'; value: number | null; note: string | null;
  compare: { label: string; value: number | null } | null; target: { label: string; value: number } | null;
  higherIsBetter: boolean; spark: (number | null)[]; sparkLabels: string[];
  explain: { plain: string; formula: string; drivers: { label: string; value: number | null; kind: string }[]; actions: string[] };
}

export function overview(db: Db, tenantId: string, approvedOnly: boolean, view: View) {
  const s = loadSettings(db, tenantId);
  const months = loadMonths(db, tenantId, approvedOnly);
  const tenant = db.get('SELECT name, is_synthetic, industry_id FROM tenants WHERE id = ?', tenantId)!;
  const lastImport = db.get("SELECT MAX(committed_at) AS at FROM import_batches WHERE tenant_id = ? AND status = 'committed'", tenantId)?.at ?? null;
  const header = { tenantName: tenant.name, isSynthetic: !!tenant.is_synthetic, lastImportAt: lastImport, dataSource: 'Imported accounting data (not a live feed)', view, viewLabel: VIEW_LABEL[view], engineVersion: ENGINE_VERSION };
  if (!months.length) return { header: { ...header, period: null, periodLabel: null, status: null }, empty: true, emptyReason: approvedOnly ? 'Your advisor has not yet approved any financial periods.' : 'No financial data has been imported yet.', cards: [], scorecard: null, priorities: priorities(db, tenantId, approvedOnly) };
  const idx = months.length - 1; const cur = months[idx];
  const cmpOffset = view === 'monthly' ? 1 : view === 'quarterly' ? 3 : 12;
  const cmpLabel = view === 'monthly' ? 'Prior month' : view === 'quarterly' ? 'Prior quarter' : view === 'ytd' ? 'Prior year to date' : 'Previous rolling 12';
  const w = windowAt(months, idx, view, s)!; const c = idx - cmpOffset >= 0 ? windowAt(months, idx - cmpOffset, view, s) : null;
  const sparkIdx = Array.from({ length: Math.min(12, months.length) }, (_, k) => idx - (Math.min(12, months.length) - 1) + k);
  const sparkLabels = sparkIdx.map((i) => periodLabel(months[i].period));
  const series = (f: (w: WindowResult, i: number) => number | null) => sparkIdx.map((i) => { const x = windowAt(months, i, view, s); return x && (view === 'monthly' || view === 'quarterly' || x.complete || view === 'ytd') ? f(x, i) : null; });
  const cc = coreCapital(months, idx, s); const ccPrev = idx - cmpOffset >= 0 ? coreCapital(months, idx - cmpOffset, s) : null;
  const planTarget = Math.round(w.lines.revenue * s.pretaxTargetPct);
  const mk = (k: Omit<KpiCard, 'sparkLabels'>): KpiCard => ({ ...k, sparkLabels });
  const cards: KpiCard[] = [
    mk({ key: 'revenue', label: 'Revenue', kind: 'money', value: w.lines.revenue, note: null, compare: c ? { label: cmpLabel, value: c.lines.revenue } : null,
      target: view === 'r12' && s.salesTargetR12Cents ? { label: 'Sales target', value: s.salesTargetR12Cents } : null, higherIsBetter: true, spark: series((x) => x.lines.revenue),
      explain: { plain: 'Total sales for the period, before any costs.', formula: 'Sum of all accounts mapped to Revenue.', drivers: [{ label: 'Revenue', value: w.lines.revenue, kind: 'money' }, { label: cmpLabel, value: c?.lines.revenue ?? null, kind: 'money' }], actions: ['Compare price and volume changes in the Decision Lab.', 'Review the sales pipeline against the plan.'] } }),
    mk({ key: 'gross_margin', label: 'Gross margin', kind: 'pct', value: w.grossMarginPct.value, note: w.grossMarginPct.reason ?? null, compare: c ? { label: cmpLabel, value: c.grossMarginPct.value } : null, target: null, higherIsBetter: true, spark: series((x) => x.grossMarginPct.value),
      explain: { plain: 'The percentage of sales remaining after direct non-labor costs, before labor expenses.', formula: 'Gross Profit ÷ Revenue, where Gross Profit = Revenue − non-labor COGS.', drivers: [{ label: 'Revenue', value: w.lines.revenue, kind: 'money' }, { label: 'Non-labor COGS', value: w.lines.cogs, kind: 'money' }, { label: 'Gross profit', value: w.grossProfit, kind: 'money' }], actions: ['Check pricing on the lowest-margin jobs or services.', 'Review material and subcontractor costs for increases that were not passed on.'] } }),
    mk({ key: 'adjusted_pretax', label: 'Adjusted pretax profit', kind: 'money', value: w.adjustedPretax, note: null, compare: c ? { label: cmpLabel, value: c.adjustedPretax } : null, target: { label: `${(s.pretaxTargetPct * 100).toFixed(0)}% of revenue`, value: planTarget }, higherIsBetter: true, spark: series((x) => x.adjustedPretax),
      explain: { plain: 'Profit before income tax, after paying the owner a market-rate wage. This is the true economic profit of the business.', formula: 'Reported pretax profit − owner compensation adjustment.', drivers: [{ label: 'Reported pretax profit', value: w.pretax, kind: 'money' }, { label: 'Owner-pay adjustment', value: w.ownerAdj, kind: 'money' }, { label: 'Adjusted pretax %', value: w.adjustedPretaxPct.value, kind: 'pct' }], actions: ['Use the Profit Planner to size the gap to target.', 'Test price, volume and labor levers in the Decision Lab.'] } }),
    mk({ key: 'cash', label: 'Cash available', kind: 'money', value: cc.available, note: cc.available === null ? cc.attainment.reason ?? null : 'Balance at period end, net of line of credit.', compare: ccPrev ? { label: cmpLabel, value: ccPrev.available } : null, target: { label: 'Core capital target', value: cc.target }, higherIsBetter: true, spark: sparkIdx.map((i) => (months[i].bs ? months[i].bs!.cash - months[i].bs!.line_of_credit : null)),
      explain: { plain: 'Cash in the bank at period end, minus anything drawn on a line of credit.', formula: 'Cash − Line of credit balance.', drivers: [{ label: 'Cash', value: cc.cash, kind: 'money' }, { label: 'Line of credit', value: cc.locBalance, kind: 'money' }], actions: ['Review the 13-week cash forecast for upcoming low points.'] } }),
    mk({ key: 'labor_efficiency', label: 'Labor efficiency', kind: 'ratio', value: w.dLER.value, note: w.dLER.reason ?? null, compare: c ? { label: cmpLabel, value: c.dLER.value } : null, target: s.dlerTarget ? { label: 'Target direct LER', value: s.dlerTarget } : null, higherIsBetter: true, spark: series((x) => x.dLER.value),
      explain: { plain: 'Gross profit produced for every dollar of direct labor. Higher means your team is producing more for what it costs.', formula: 'Direct LER = Gross Profit ÷ Direct Labor.', drivers: [{ label: 'Gross profit', value: w.grossProfit, kind: 'money' }, { label: 'Direct labor', value: w.lines.direct_labor, kind: 'money' }, { label: 'Management LER', value: w.mLER.value, kind: 'ratio' }, { label: 'Total LER', value: w.tLER.value, kind: 'ratio' }], actions: ['Review utilization and scheduling.', 'Review service pricing before adding headcount.'] } }),
    mk({ key: 'operating_cash_flow', label: 'Operating cash flow', kind: 'money', value: operatingCash(months, w), note: operatingCash(months, w) === null ? 'Not available: needs a balance sheet for each month in the period and the month before it.' : null, compare: c ? { label: cmpLabel, value: operatingCash(months, c) } : null, target: null, higherIsBetter: true, spark: sparkIdx.map((i) => operatingCash(months, windowAt(months, i, view, s))),
      explain: { plain: 'Cash generated by running the business — profit adjusted for what customers still owe you and what you still owe suppliers.', formula: 'Pretax profit + depreciation − increase in receivables and other assets + increase in payables and other current liabilities.', drivers: [{ label: 'Pretax profit', value: w.pretax, kind: 'money' }, { label: 'Depreciation', value: w.lines.depreciation, kind: 'money' }], actions: ['If cash flow trails profit, look at receivables collection first.'] } }),
    mk({ key: 'reserve_coverage', label: 'Cash reserve coverage', kind: 'months', value: cc.monthsCovered.value, note: cc.monthsCovered.reason ?? null, compare: ccPrev ? { label: cmpLabel, value: ccPrev.monthsCovered.value } : null, target: { label: 'Target months', value: s.coreCapitalMonths }, higherIsBetter: true, spark: sparkIdx.map((i) => coreCapital(months, i, s).monthsCovered.value),
      explain: { plain: 'How many months of operating costs your available cash would cover.', formula: `Available cash ÷ average monthly spend. Target basis: ${cc.basisLabel}.`, drivers: [{ label: 'Available cash', value: cc.available, kind: 'money' }, { label: 'Average monthly spend', value: cc.monthlyBasis, kind: 'money' }, { label: 'Surplus (shortfall)', value: cc.surplus, kind: 'money' }], actions: ['Hold distributions beyond taxes until the reserve is funded.'] } }),
    mk({ key: 'plan', label: 'Performance against plan', kind: 'pct', value: planTarget > 0 ? w.adjustedPretax / planTarget : null, note: planTarget > 0 ? 'Adjusted pretax profit as a share of the profit target.' : 'Not available: there is no revenue in the period.', compare: c && c.lines.revenue > 0 ? { label: cmpLabel, value: c.adjustedPretax / Math.round(c.lines.revenue * s.pretaxTargetPct) } : null, target: { label: 'On plan', value: 1 }, higherIsBetter: true, spark: series((x) => (x.lines.revenue > 0 ? x.adjustedPretax / (x.lines.revenue * s.pretaxTargetPct) : null)),
      explain: { plain: 'How much of your profit target you achieved. 100% means you hit the plan.', formula: 'Adjusted pretax profit ÷ (Revenue × target pretax %).', drivers: [{ label: 'Adjusted pretax profit', value: w.adjustedPretax, kind: 'money' }, { label: 'Profit target', value: planTarget, kind: 'money' }], actions: ['Open the scorecard to see which measures are behind.'] } }),
  ];
  const sc = approvedOnly ? publishedScorecard(db, tenantId) : liveScorecard(db, tenantId, months, s);
  return {
    header: { ...header, period: cur.period, periodLabel: periodLabel(cur.period), status: cur.status, windowFrom: w.from, windowTo: w.to, windowComplete: w.complete, monthsIncluded: w.monthsIncluded },
    empty: false, cards, scorecard: sc, priorities: priorities(db, tenantId, approvedOnly),
    trend: months.slice(-24).map((m) => { const p = computePnl(m.pnl, m.ownerAdj, s); return { period: m.period, revenue: m.pnl.revenue, grossProfit: p.grossProfit, adjustedPretax: p.adjustedPretax, status: m.status }; }),
  };
}

export function priorities(db: Db, tenantId: string, clientOnly: boolean) {
  return db.all(`SELECT id, title, kpi, observation, cause, impact, recommendation, impact_cents, impact_basis, owner, due_date, status, scenario_id, client_visible FROM actions
    WHERE tenant_id = ? AND status IN ('open','in_progress') ${clientOnly ? 'AND client_visible = 1' : ''} ORDER BY priority, due_date IS NULL, due_date LIMIT 3`, tenantId);
}

export interface SavedScorecard { id: string | null; period: string; status: 'live' | 'draft' | 'published'; scorecard: Scorecard; commentary: Record<string, { grade?: string; comment?: string }>; internalNotes?: string; publishedAt: string | null }
export function liveScorecard(db: Db, tenantId: string, months: Month[], s: Settings): SavedScorecard | null {
  if (!months.length) return null;
  const sc = buildScorecard(months, months.length - 1, s); if (!sc) return null;
  const saved = db.get('SELECT id, status, commentary_json, internal_notes, published_at FROM scorecards WHERE tenant_id = ? AND period = ?', tenantId, sc.period);
  return { id: saved?.id ?? null, period: sc.period, status: saved?.status ?? 'live', scorecard: sc, commentary: saved ? JSON.parse(saved.commentary_json) : {}, internalNotes: saved?.internal_notes ?? '', publishedAt: saved?.published_at ?? null };
}
/** Clients only ever see the frozen snapshot the advisor published — never internal notes, never live recalculations. */
export function publishedScorecard(db: Db, tenantId: string, period?: string): SavedScorecard | null {
  const r = period ? db.get("SELECT * FROM scorecards WHERE tenant_id = ? AND status = 'published' AND period = ?", tenantId, period)
    : db.get("SELECT * FROM scorecards WHERE tenant_id = ? AND status = 'published' ORDER BY period DESC LIMIT 1", tenantId);
  return r ? { id: r.id, period: r.period, status: 'published', scorecard: JSON.parse(r.snapshot_json), commentary: JSON.parse(r.commentary_json), publishedAt: r.published_at } : null;
}

export function financials(db: Db, tenantId: string, approvedOnly: boolean) {
  const s = loadSettings(db, tenantId); const months = loadMonths(db, tenantId, approvedOnly);
  const entered = Object.fromEntries(db.all("SELECT period, SUM(amount_cents) AS cents FROM adjustments WHERE tenant_id = ? AND kind = 'owner_distribution' AND reversed_at IS NULL GROUP BY period", tenantId).map((r) => [r.period as string, r.cents as number]));
  const sweat = sweatEquity(months, entered);
  const rows = months.map((m, i) => {
    const p = computePnl(m.pnl, m.ownerAdj, s); const r = rolling12(months, i, s)!;
    const cf = i > 0 && m.bs && months[i - 1].bs ? cashFlowMonth(months[i - 1].bs!, m.bs, m.pnl) : null;
    const cap = m.bs ? capitalView({ equityCents: m.bs.equity, locCents: m.bs.line_of_credit, notesCents: m.bs.notes_payable, sweatEquityCents: sweat[i].balance, pretax12Cents: r.adjustedPretax, complete: r.complete }) : null;
    return { period: m.period, status: m.status, missing: m.missing, sweat: sweat[i], capital: cap, pnl: p, bs: m.bs, bsImbalance: m.bs ? bsImbalance(m.bs) : null, cashFlow: cf, dso: dso(months, i, s), r12: { complete: r.complete, monthsIncluded: r.monthsIncluded, revenue: r.lines.revenue, grossProfit: r.grossProfit, adjustedPretax: r.adjustedPretax, adjustedPretaxPct: r.adjustedPretaxPct.value, dLER: r.dLER.value, mLER: r.mLER.value, tLER: r.tLER.value, salaryCap: r.salaryCap, headroom: r.salaryCapHeadroom, opexPct: r.opexPct.value, grossMarginPct: r.grossMarginPct.value } };
  });
  let forecast: unknown[] = [], drivers = null;
  if (months.length >= 3) {
    drivers = defaultDrivers(months, s);
    forecast = forecastMonths(months, 12, drivers, s).map((f) => ({ period: f.period, pnl: computePnl(f.pnl, 0, s) }));
  }
  return { settings: s, months: rows, forecast, drivers, lines: PNL_LINES, bsLines: BS_LINES, rolling: rolling12Table(months, s), expenseChecks: expenseChecks(months, s), recent: rolling3(months, months.length - 1, s), basis: months.length ? accountingBasis(db, tenantId) : null, valuationBase: months.length ? valuationBase(db, tenantId, months, s) : null, reporting: months.length ? reportingRhythm(db, tenantId) : null };
}

export function cashItems(db: Db, tenantId: string): CashItem[] {
  return db.all('SELECT * FROM cash_items WHERE tenant_id = ? ORDER BY direction, name', tenantId).map((r) => ({ id: r.id, name: r.name, direction: r.direction, category: r.category, amountCents: r.amount_cents, cadence: r.cadence, anchorDate: r.anchor_date, endDate: r.end_date, secondDay: r.second_day, active: !!r.active }));
}
export function cashPosition(db: Db, tenantId: string, approvedOnly: boolean): { cents: number | null; asOf: string | null; source: string } {
  const wk = db.get('SELECT week_start, cash_balance_cents FROM weekly_entries WHERE tenant_id = ? AND cash_balance_cents IS NOT NULL ORDER BY week_start DESC LIMIT 1', tenantId);
  const day = db.get('SELECT date, cash_balance_cents FROM daily_cash WHERE tenant_id = ? ORDER BY date DESC LIMIT 1', tenantId);
  if (day && (!wk || day.date >= wk.week_start)) { const m = loadMonths(db, tenantId, approvedOnly); const b = [...m].reverse().find((x) => x.bs); if (!b || day.date.slice(0, 7) >= b.period) return { cents: day.cash_balance_cents, asOf: day.date, source: 'Daily cash report (bank balance in the accounting system; operational, not reconciled)' }; }
  const months = loadMonths(db, tenantId, approvedOnly); const withBs = [...months].reverse().find((m) => m.bs);
  if (wk && (!withBs || wk.week_start.slice(0, 7) >= withBs.period)) return { cents: wk.cash_balance_cents, asOf: wk.week_start, source: 'Bank balance entered with the weekly update (operational, not reconciled)' };
  if (withBs) return { cents: withBs.bs!.cash, asOf: withBs.period, source: `Balance sheet cash, ${periodLabel(withBs.period)} (${withBs.status})` };
  return { cents: null, asOf: null, source: 'No cash balance on file' };
}
export function cashForecast(db: Db, tenantId: string, approvedOnly: boolean, ov: CashOverrides = {}, today = new Date().toISOString().slice(0, 10)) {
  const s = loadSettings(db, tenantId); const pos = cashPosition(db, tenantId, approvedOnly); const items = cashItems(db, tenantId);
  const start = weekStart(today, s.weekStartDay);
  const months = loadMonths(db, tenantId, approvedOnly);
  const cc = months.length ? coreCapital(months, months.length - 1, s) : null;
  const base = pos.cents === null ? null : forecast13(start, pos.cents, items, s.cashFloorCents, {}, 13, s.billPayWeekday);
  const scenario = pos.cents === null || !(ov.delays?.length || ov.extra?.length || ov.scaleInflowsPct) ? null : forecast13(start, pos.cents, items, s.cashFloorCents, ov, 13, s.billPayWeekday);
  return { position: pos, startDate: start, floorCents: s.cashFloorCents, billPayWeekday: s.billPayWeekday, items, forecast: base, scenario, coreCapital: cc, nonPnlMonthlyCents: nonPnlMonthly(items) };
}

export function hiringBaseline(db: Db, tenantId: string, approvedOnly: boolean): { baseline: HiringBaseline; settings: Settings } | { error: string } {
  const s = loadSettings(db, tenantId); const months = loadMonths(db, tenantId, approvedOnly);
  if (months.length < 3) return { error: 'At least three months of financial history are needed to build a scenario baseline.' };
  const idx = months.length - 1; const fc = forecastMonths(months, 24, defaultDrivers(months, s), s);
  const d = dso(months, idx, s); const cc = coreCapital(months, idx, s); const pos = cashPosition(db, tenantId, approvedOnly);
  const recent = months.slice(-12);
  return { settings: s, baseline: {
    asOf: months[idx].period, months: fc, ownerAdjMonthlyCents: Math.round(recent.reduce((a, m) => a + m.ownerAdj, 0) / recent.length),
    startingCashCents: pos.cents === null ? null : pos.cents - (months[idx].bs?.line_of_credit ?? 0),
    nonPnlCashOutMonthlyCents: nonPnlMonthly(cashItems(db, tenantId)), collectionLagMonths: d.value === null ? 0 : Math.min(3, Math.round(d.value / 30)), coreCapitalTargetCents: cc.target,
  } };
}

export function weeklyData(db: Db, tenantId: string, clientOnly: boolean) {
  const s = loadSettings(db, tenantId);
  let entries: WeeklyEntry[] = db.all('SELECT * FROM weekly_entries WHERE tenant_id = ? ORDER BY week_start', tenantId).map((r) => ({ weekStart: r.week_start, revenueCents: r.revenue_cents, cogsCents: r.cogs_cents, directLaborCents: r.direct_labor_cents, otherLaborCents: r.other_labor_cents ?? null, cashBalanceCents: r.cash_balance_cents, source: r.source }));
  const reports = db.all(`SELECT id, week_start, status, published_at, acknowledged_at FROM weekly_reports WHERE tenant_id = ? ${clientOnly ? "AND status = 'published'" : ''} ORDER BY week_start DESC`, tenantId);
  if (clientOnly) { const last = reports[0]?.week_start ?? ''; entries = entries.filter((e) => e.weekStart <= last); } // clients see weeks only once a report is published
  const months = loadMonths(db, tenantId, clientOnly); const r12 = months.length ? rolling12(months, months.length - 1, s) : null;
  const productivity = salesProductivity(months, entries.map((e) => ({ weekStart: e.weekStart, revenueCents: e.revenueCents, cogsCents: e.cogsCents, directLaborCents: e.directLaborCents, otherLaborCents: e.otherLaborCents ?? null })), s, r12?.complete ? wagesLerTarget(r12) : null);
  return { settings: s, rows: weeklyRows(entries, s), productivity, reports, estimateLabel: 'Operational estimate — entered weekly from sales, payroll and bank data; not reconciled to the monthly accounting close.' };
}
export function buildWeeklySnapshot(db: Db, tenantId: string, week: string) {
  const { rows, settings } = weeklyData(db, tenantId, false);
  const idx = rows.findIndex((r) => r.weekStart === week); if (idx < 0) return null;
  const cf = cashForecast(db, tenantId, false, {}, week).forecast;
  const cash = cf ? { lowestCents: cf.lowestCents, lowestWeek: cf.lowestWeek, floorCents: cf.floorCents } : null;
  return { snapshot: { week, row: rows[idx], prior: rows.slice(Math.max(0, idx - 7), idx), cash, cashWeeks: cf?.weeks.map((w) => ({ weekStart: w.weekStart, endCents: w.endCents, belowFloor: w.belowFloor })) ?? [], targets: { dler: settings.dlerTarget, weeklyGp: settings.weeklyGpTargetCents }, engineVersion: ENGINE_VERSION }, briefing: draftBriefing(rows, idx, settings, cash) };
}

export function kpiValues(db: Db, tenantId: string, approvedOnly: boolean) {
  const s = loadSettings(db, tenantId); const months = loadMonths(db, tenantId, approvedOnly);
  const defs = db.all(`SELECT d.*, tk.target AS t_target, tk.alert_threshold AS t_alert, tk.client_visible AS t_visible, i.name AS industry FROM tenant_kpis tk JOIN kpi_definitions d ON d.id = tk.kpi_id JOIN industries i ON i.id = d.industry_id
    WHERE tk.tenant_id = ? AND d.status = 'active' ${approvedOnly ? 'AND tk.client_visible = 1 AND d.client_visible = 1' : ''} ORDER BY i.name, d.name`, tenantId);
  const inputs = db.all('SELECT key, period, value FROM kpi_inputs WHERE tenant_id = ?', tenantId);
  const idx = months.length - 1;
  const at = (def: any, i: number) => {
    if (i < 0) return { value: null, reason: 'Not available: no financial period.' };
    const w = def.basis === 'r12' ? rolling12(months, i, s)! : trailing(months, i, 1, s)!;
    const vars: Record<string, number | null> = { ...financialVars(w, months[i].bs, def.basis === 'r12' ? 365 : 365 / 12) };
    const lo = def.basis === 'r12' ? addMonths(months[i].period, -11) : months[i].period;
    for (const name of formulaVariables(def.formula)) if (!isFinancialVariable(name)) {
      const vals = inputs.filter((x) => x.key === name && x.period >= lo && x.period <= months[i].period);
      vars[name] = vals.length === (def.basis === 'r12' ? 12 : 1) ? vals.reduce((a, x) => a + x.value, 0) : null; // operational inputs are summed over the window; partial windows are N/A
    }
    return evaluateFormula(def.formula, vars);
  };
  return {
    period: idx >= 0 ? months[idx].period : null,
    kpis: defs.map((d) => {
      const cur = at(d, idx); const target = d.t_target ?? d.default_target; const alert = d.t_alert ?? d.alert_threshold;
      const needs = formulaVariables(d.formula).filter((n) => !isFinancialVariable(n));
      return { id: d.id, key: d.key, name: d.name, industry: d.industry, formula: d.formula, unit: d.unit, basis: d.basis, direction: d.direction, description: d.description, recommendedAction: d.recommended_action, dataSource: d.data_source, benchmarkSource: d.benchmark_source,
        value: cur.value, reason: cur.reason ?? null, target, alert, status: kpiStatus(cur.value, target, alert, d.direction), clientVisible: !!d.t_visible, inputsNeeded: needs,
        history: Array.from({ length: Math.min(12, months.length) }, (_, k) => { const i = idx - (Math.min(12, months.length) - 1) + k; return { period: months[i].period, value: at(d, i).value }; }) };
    }),
    inputs: approvedOnly ? [] : inputs,
  };
}

/** Insights are drafted from ADVISOR-APPROVED periods only, so anything later shared with the client matches what the client can see. */
export function insightsFor(db: Db, tenantId: string) {
  const s = loadSettings(db, tenantId); const months = loadMonths(db, tenantId, true);
  if (!months.length) return [];
  const idx = months.length - 1; const sc = buildScorecard(months, idx, s); const r = rolling12(months, idx, s);
  if (!sc || !r) return [];
  return generateInsights(sc, r, idx >= 12 ? rolling12(months, idx - 12, s) : null, coreCapital(months, idx, s), s);
}

/** Portfolio view for advisors: one row per assigned client with the alerts that need attention. */
export function portfolio(db: Db, tenantIds: string[]) {
  const thisMonth = new Date().toISOString().slice(0, 7);
  return tenantIds.map((id) => {
    const t = db.get('SELECT t.id, t.name, t.is_synthetic, i.name AS industry FROM tenants t LEFT JOIN industries i ON i.id = t.industry_id WHERE t.id = ?', id)!;
    const s = loadSettings(db, id); const months = loadMonths(db, id, false); const alerts: { type: string; text: string }[] = [];
    let summary: Record<string, unknown> = {};
    if (!months.length) alerts.push({ type: 'reporting', text: 'No financial data imported yet.' });
    else {
      const idx = months.length - 1; const r = rolling12(months, idx, s)!; const prev = idx >= 3 ? rolling12(months, idx - 3, s) : null;
      const lag = monthsBetween(months[idx].period, thisMonth);
      if (lag > 1) alerts.push({ type: 'reporting', text: `Financials are ${lag - 1} month(s) behind: latest period is ${periodLabel(months[idx].period)}.` });
      const rr = reportingRhythm(db, id); if (rr.status === 'overdue' || rr.status === 'late') alerts.push({ type: 'reporting', text: rr.text });
      const unapproved = months.filter((m) => m.status !== 'approved').length;
      if (unapproved) alerts.push({ type: 'reporting', text: `${unapproved} period(s) awaiting approval.` });
      if (prev && r.adjustedPretaxPct.value !== null && prev.adjustedPretaxPct.value !== null && r.adjustedPretaxPct.value < prev.adjustedPretaxPct.value - 0.01) alerts.push({ type: 'profitability', text: `True profit margin fell from ${(prev.adjustedPretaxPct.value * 100).toFixed(1)}% to ${(r.adjustedPretaxPct.value * 100).toFixed(1)}% (rolling 12, last 3 months).` });
      const sc = buildScorecard(months, idx, s);
      const behind = sc?.measures.filter((m) => m.grade === 'Caution').map((m) => m.label) ?? [];
      if (behind.length) alerts.push({ type: 'targets', text: `Below target: ${behind.join(', ')}.` });
      const cf = cashForecast(db, id, false).forecast;
      if (cf && cf.weeksBelowFloor > 0) alerts.push({ type: 'cash', text: `Projected cash falls below the minimum in ${cf.weeksBelowFloor} of the next 13 weeks (low point ${Math.round(cf.lowestCents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })}).` });
      summary = { period: months[idx].period, status: months[idx].status, revenueR12: r.lines.revenue, adjustedPretaxPct: r.adjustedPretaxPct.value, dLER: r.dLER.value, grades: sc?.measures.map((m) => ({ key: m.key, label: m.label, grade: m.grade })) ?? [] };
    }
    return { id: t.id, name: t.name, industry: t.industry, isSynthetic: !!t.is_synthetic, alerts, summary };
  });
}

/** Four forces of cash flow for the fiscal year to date: taxes, debt, core capital, then distributions. */
export function fourForcesView(db: Db, tenantId: string, approvedOnly: boolean, today = new Date().toISOString().slice(0, 10)) {
  const s = loadSettings(db, tenantId); const months = loadMonths(db, tenantId, approvedOnly);
  if (!months.length) return { available: false as const, reason: 'No financial periods are available yet.' };
  const idx = months.length - 1; const cur = months[idx];
  if (!cur.bs) return { available: false as const, reason: `No balance sheet has been imported for ${periodLabel(cur.period)}. The four forces start from cash on hand.` };
  const y = ytd(months, idx, s)!; const fromIdx = months.findIndex((m) => m.period >= y.from); const fiscalYear = y.from.slice(0, 4);
  const cc = coreCapital(months, idx, s); const recent = trailing(months, idx, 3, s)!;
  const start = weekStart(today, s.weekStartDay); const end = addDays(start, 13 * 7 - 1);
  const scheduledDebt = cashItems(db, tenantId).filter((i) => i.active && i.direction === 'out' && i.category === 'loan_payment').reduce((a, i) => a + occurrences(i, start, end).length * i.amountCents, 0);
  const entered = Object.fromEntries(db.all("SELECT period, SUM(amount_cents) AS cents FROM adjustments WHERE tenant_id = ? AND kind = 'owner_distribution' AND reversed_at IS NULL GROUP BY period", tenantId).map((r) => [r.period as string, r.cents as number]));
  const sweat = sweatEquity(months, entered).slice(fromIdx); const haveDist = sweat.some((r) => r.distributions !== null);
  const taxesPaid = s.taxesPaid[fiscalYear] ?? 0;
  const projectedTax = Object.hasOwn(s.taxProjected, fiscalYear) ? s.taxProjected[fiscalYear] : null;
  const forces = fourForces({ cashCents: cur.bs.cash, locCents: cur.bs.line_of_credit, pretaxYtdCents: y.pretax, taxRate: s.taxReserveRate, taxesPaidYtdCents: taxesPaid, projectedTaxCents: projectedTax, scheduledDebtCents: scheduledDebt, coreCapitalTargetCents: cc.target, avgMonthlyPretaxCents: Math.round(recent.pretax / recent.monthsIncluded), distributionsYtdCents: haveDist ? sweat.reduce((a, r) => a + (r.distributions ?? 0), 0) : null });
  return { available: true as const, asOf: cur.period, status: cur.status, fiscalYear, ytdFrom: y.from, ytdComplete: y.complete, taxRate: s.taxReserveRate, taxesPaidCents: taxesPaid, projectedTaxCents: projectedTax, rateBasedTaxCents: Math.round(Math.max(0, y.pretax) * s.taxReserveRate), coreCapitalBasis: cc.basisLabel, forces, walk: cashWalk(months, fromIdx, idx), nextTaxDate: nextEstimatedTaxDate(today), quarterSetAsideCents: Math.max(0, Math.round(trailing(months, idx, 3, s)!.pretax * s.taxReserveRate)) };
}

/** Daily cash reports and the two-week cash flow forecast report (bank, line of credit, receivables aging, payables by group). */
export function cashReports(db: Db, tenantId: string, approvedOnly: boolean) {
  const s = loadSettings(db, tenantId); const cf = cashForecast(db, tenantId, approvedOnly);
  const days = db.all('SELECT * FROM daily_cash WHERE tenant_id = ? ORDER BY date DESC LIMIT 14', tenantId).map((d) => ({ date: d.date, cashBalanceCents: d.cash_balance_cents, deposits: JSON.parse(d.deposits_json) as { payer: string; cents: number }[], aging: d.ar_aging_json ? JSON.parse(d.ar_aging_json) : null, missedOwnerPayCents: d.missed_owner_pay_cents }));
  const aging = db.get('SELECT date, ar_aging_json FROM daily_cash WHERE tenant_id = ? AND ar_aging_json IS NOT NULL ORDER BY date DESC LIMIT 1', tenantId);
  const missed = db.get('SELECT date, missed_owner_pay_cents FROM daily_cash WHERE tenant_id = ? AND missed_owner_pay_cents IS NOT NULL ORDER BY date DESC LIMIT 1', tenantId);
  const months = loadMonths(db, tenantId, approvedOnly); const bs = [...months].reverse().find((m) => m.bs);
  const locBalance = bs ? bs.bs!.line_of_credit : null;
  return { consent: bankFeedConsent(db, tenantId), days, position: cf.position, startDate: cf.startDate, twoWeek: cf.forecast ? twoWeekView(cf.forecast) : null,
    loc: { limitCents: s.locLimitCents, balanceCents: locBalance, availableCents: s.locLimitCents !== null && locBalance !== null ? Math.max(0, s.locLimitCents - locBalance) : null, asOf: bs?.period ?? null },
    aging: aging ? { asOf: aging.date, ...JSON.parse(aging.ar_aging_json) } : null, receivablesOnBooksCents: bs ? bs.bs!.accounts_receivable : null,
    missedOwnerPay: missed ? { asOf: missed.date, cents: missed.missed_owner_pay_cents } : null };
}

/** Monthly reporting rhythm: were last month's figures approved by the agreed day of this month? */
export function reportingRhythm(db: Db, tenantId: string, today = new Date().toISOString().slice(0, 10)) {
  const s = loadSettings(db, tenantId); const probe = reportRhythm(today, s.reportDueDay, null);
  const row = db.get("SELECT updated_at FROM period_status WHERE tenant_id = ? AND period = ? AND status = 'approved'", tenantId, probe.expectedPeriod);
  const has = !!db.get('SELECT 1 AS x FROM facts WHERE tenant_id = ? AND period = ? AND active = 1 LIMIT 1', tenantId, probe.expectedPeriod);
  return reportRhythm(today, s.reportDueDay, row && has ? String(row.updated_at).slice(0, 10) : null);
}

/** How the books behind the P&L months now in use were kept, from the flag set on each import. */
export function accountingBasis(db: Db, tenantId: string) {
  const rows = db.all("SELECT DISTINCT b.accounting_basis AS basis FROM facts f JOIN import_batches b ON b.id = f.batch_id JOIN accounts a ON a.id = f.account_id WHERE f.tenant_id = ? AND f.active = 1 AND a.statement = 'pnl'", tenantId).map((r) => r.basis as string);
  const value = rows.length === 0 ? 'unknown' : rows.length > 1 ? (rows.includes('cash') ? 'mixed' : 'unknown') : rows[0];
  const text = value === 'cash' ? 'These books are kept on the cash basis. Sales count when collected and bills when paid, so monthly profit, receivables, days sales outstanding and labor efficiency can be distorted by timing. Accrual-basis books are needed for these measures to mean what they say.'
    : value === 'mixed' ? 'Some months were imported from cash-basis books and others from accrual-basis books. Comparisons across those months are not like for like.'
    : value === 'unknown' ? 'The accounting basis (cash or accrual) has not been recorded for the imported files. Set it under Data Sources so timing-sensitive measures can be read correctly.' : null;
  return { value, text };
}

/** P&L line drill-down: the mapped accounts behind one line for the twelve months ending `to`. Tenant-scoped; clients see approved months only. */
const DRILL: Record<string, { label: string; lines: string[] }> = {
  revenue: { label: 'Revenue', lines: ['revenue'] }, cogs: { label: 'Non-labor cost of goods sold', lines: ['cogs'] }, labor: { label: 'Labor — all', lines: ['direct_labor', 'mgmt_labor'] },
  marketing: { label: 'Marketing', lines: ['marketing'] }, facilities: { label: 'Facilities', lines: ['facilities'] }, payroll_taxes_benefits: { label: 'Payroll taxes & benefits', lines: ['payroll_taxes_benefits'] },
  other_opex: { label: 'Other operating expenses', lines: ['other_opex'] }, other_net: { label: 'Other income, depreciation, interest', lines: ['other_income_expense', 'depreciation', 'interest_expense'] },
};
export const DRILL_LINES = Object.keys(DRILL);
export function lineAccounts(db: Db, tenantId: string, line: string, to: string, approvedOnly: boolean) {
  const def = DRILL[line]; const s = loadSettings(db, tenantId); const lines = line === 'labor' && s.burdenTreatment === 'labor' ? [...def.lines, 'payroll_taxes_benefits'] : def.lines;
  const visible = loadMonths(db, tenantId, approvedOnly); const from = addMonths(to, -11); const periods = visible.filter((m) => m.period >= from && m.period <= to).map((m) => m.period);
  if (!periods.length) return null;
  const rows = db.all(`SELECT a.id, a.name, a.line, f.period, SUM(f.amount_cents * a.sign) AS cents FROM facts f JOIN accounts a ON a.id = f.account_id
    WHERE f.tenant_id = ? AND a.tenant_id = ? AND f.active = 1 AND a.statement = 'pnl' AND a.line IN (${lines.map(() => '?').join(',')}) AND f.period IN (${periods.map(() => '?').join(',')}) GROUP BY a.id, f.period`, tenantId, tenantId, ...lines, ...periods);
  const acc = new Map<string, { name: string; line: string; totalCents: number; latestCents: number; byMonth: Record<string, number> }>();
  for (const r of rows) { const sign = line === 'other_net' && r.line !== 'other_income_expense' ? -1 : 1; const a = acc.get(r.id) ?? { name: r.name, line: r.line, totalCents: 0, latestCents: 0, byMonth: {} }; a.byMonth[r.period] = r.cents * sign; a.totalCents += r.cents * sign; if (r.period === to) a.latestCents += r.cents * sign; acc.set(r.id, a); }
  if (line === 'labor') { const adj = visible.filter((m) => periods.includes(m.period)); const total = adj.reduce((x, m) => x + m.ownerAdj, 0); if (total !== 0) acc.set('owner-adj', { name: 'Owner market-wage adjustment (management entry, not an account)', line: 'owner_adjustment', totalCents: total, latestCents: adj.find((m) => m.period === to)?.ownerAdj ?? 0, byMonth: Object.fromEntries(adj.map((m) => [m.period, m.ownerAdj])) }); }
  const accounts = [...acc.values()].sort((a, b) => Math.abs(b.totalCents) - Math.abs(a.totalCents));
  return { line, label: def.label, from: periods[0], to, monthsIncluded: periods.length, complete: periods.length === 12, periods, accounts, totalCents: accounts.reduce((x, a) => x + a.totalCents, 0) };
}

/** Figures the blended valuation rests on. Advisor inputs (equity adjustment, multiples, stake) are kept separately in a scenario. */
export function valuationBase(db: Db, tenantId: string, months: Month[], s: Settings): ValuationBase {
  const n = months.length; const used = months.slice(Math.max(0, n - 36)); const r = rolling12(months, n - 1, s)!; const bs = [...months].reverse().find((m) => m.bs)?.bs ?? null;
  const cc = coreCapital(months, n - 1, s);
  return { pretaxCents: used.reduce((a, m) => a + computePnl(m.pnl, m.ownerAdj, s).adjustedPretax, 0), monthsUsed: used.length, pretax12Cents: r.adjustedPretax, equityCents: bs ? bs.equity : null, debtCents: bs ? bs.line_of_credit + bs.notes_payable : 0,
    ebitda12Cents: r.adjustedPretax + r.lines.interest_expense + r.lines.depreciation, revenue12Cents: r.lines.revenue, coreCapitalSurplusCents: cc.surplus, ownerWageApplied: used.some((m) => m.ownerAdj !== 0) || !!db.get("SELECT 1 AS x FROM owner_wage_plans WHERE tenant_id = ? AND status = 'approved' LIMIT 1", tenantId), asOf: months[n - 1].period };
}

/** Has the client owner allowed SJATS staff to work with the client's bank information? Absent means not allowed. */
export function bankFeedConsent(db: Db, tenantId: string) {
  const r = db.get('SELECT c.allowed, c.decided_at, u.name FROM bank_feed_consent c JOIN users u ON u.id = c.decided_by WHERE c.tenant_id = ?', tenantId);
  return { allowed: !!r?.allowed, decidedBy: r?.name ?? null, decidedAt: r?.decided_at ?? null, feedConnected: false };
}

/** What-if forecast on the months this user may see (clients: approved only). Levers are the only input; every figure comes from stored data. */
export function whatIfForecast(db: Db, tenantId: string, approvedOnly: boolean, levers: Partial<Levers> = {}) {
  const months = loadMonths(db, tenantId, approvedOnly);
  if (!months.length) return { available: false as const, reason: approvedOnly ? 'Your advisor has not yet approved any financial periods.' : 'No financial data has been imported yet.' };
  return { ...whatIf(months, loadSettings(db, tenantId), levers), baseStatus: months[months.length - 1].status, basis: accountingBasis(db, tenantId).value };
}

/** Rolling-three direction for the month a scorecard covers, on the months this user may see. */
export function recentFor(db: Db, tenantId: string, approvedOnly: boolean, period: string | null | undefined) {
  if (!period) return null; const months = loadMonths(db, tenantId, approvedOnly); const idx = months.findIndex((m) => m.period === period);
  return idx < 0 ? null : rolling3(months, idx, loadSettings(db, tenantId));
}
