// Simple forecast model, from Greg Crabtree, "Simple Numbers, Straight Talk, Big Profits!", ch. 10:
// a forecast instead of a budget; a thin P&L driven by a few inputs; then the road from profit to cash through
// receivables, payables, debt and owner equity; with labor yield, days to collect and operating reserve as the metrics to watch.
// Kept deliberately small: a model that takes more effort to update than it returns in insight does not get used.
import { type MonthData, type PnlLines, type Ratio, type Settings, addMonths, computePnl, dso, periodLabel, ratio, trailing, zeroPnl } from './core.ts';

// ---------- Profit-to-cash road map: one month at a time ----------
export interface StepInput {
  period: string; revenue: number; cogs: number; labor: number; marketing: number; facilities: number; payrollTaxesBenefits: number; otherOpex: number;
  /** Other income less depreciation and interest, signed: added to profit. */ otherNet?: number;
  /** Depreciation and other non-cash expense, added back on the way to cash. */ nonCash?: number;
  arEnd: number; apEnd: number; locEnd: number; notesEnd: number; capitalIn?: number; distributions?: number; purchases?: number;
}
export interface RoadState { cash: number; ar: number; ap: number; loc: number; notes: number; ytdGp: number; ytdLabor: number; priorRevenue: number[] }
export interface RoadRow extends StepInput {
  grossProfit: number; gpPct: Ratio; totalOpex: number; pretax: number; pretaxPct: Ratio;
  arChange: number; apChange: number; debtChange: number; equityChange: number; netChange: number; cashBegin: number; cashEnd: number;
  ler: Ratio; lerYtd: Ratio; dso: Ratio; coreCapital: number; targetWithoutCogs: number; targetWithCogs: number;
}
export interface RoadOptions { coreCapitalMonths: number; dsoWindowDays: number; fiscalYearStartMonth?: number }
/** Receivables implied by a days-to-collect figure: days × average daily sales over the measurement window. */
export function arForDso(dsoDays: number, windowRevenue: number[], windowDays: number): number { return Math.round((dsoDays * windowRevenue.reduce((a, b) => a + b, 0)) / windowDays); }

export function step(st: RoadState, i: StepInput, o: RoadOptions): { row: RoadRow; state: RoadState } {
  const gp = i.revenue - i.cogs; const opex = i.labor + i.marketing + i.facilities + i.payrollTaxesBenefits + i.otherOpex; const pretax = gp - opex + (i.otherNet ?? 0);
  // A rise in receivables uses cash; a rise in payables or debt supplies it; owners can put money in or take it out.
  const arChange = -(i.arEnd - st.ar); const apChange = i.apEnd - st.ap; const debtChange = i.locEnd + i.notesEnd - st.loc - st.notes; const equityChange = (i.capitalIn ?? 0) - (i.distributions ?? 0);
  const net = pretax + (i.nonCash ?? 0) + arChange + apChange + debtChange + equityChange - (i.purchases ?? 0); const cashEnd = st.cash + net;
  const reset = o.fiscalYearStartMonth !== undefined && Number(i.period.slice(5, 7)) === o.fiscalYearStartMonth; const ytdGp = (reset ? 0 : st.ytdGp) + gp, ytdLabor = (reset ? 0 : st.ytdLabor) + i.labor;
  const n = Math.max(1, Math.round(o.dsoWindowDays / 30)); const revs = [...st.priorRevenue, i.revenue].slice(-n); const sales = revs.reduce((a, b) => a + b, 0);
  const row: RoadRow = { ...i, grossProfit: gp, gpPct: ratio(gp, i.revenue, 'there is no revenue'), totalOpex: opex, pretax, pretaxPct: ratio(pretax, i.revenue, 'there is no revenue'),
    arChange, apChange, debtChange, equityChange, netChange: net, cashBegin: st.cash, cashEnd, ler: ratio(gp, i.labor, 'there is no labor cost'), lerYtd: ratio(ytdGp, ytdLabor, 'there is no labor cost'),
    dso: i.arEnd === 0 ? { value: null, reason: 'Not applicable: there are no receivables.' } : revs.length < n ? { value: null, reason: `Not available: needs ${n} months of sales.` } : ratio(i.arEnd * o.dsoWindowDays, sales, 'there were no sales'),
    coreCapital: cashEnd - i.locEnd, targetWithoutCogs: Math.round(opex * o.coreCapitalMonths), targetWithCogs: Math.round((opex + i.cogs) * o.coreCapitalMonths) };
  return { row, state: { cash: cashEnd, ar: i.arEnd, ap: i.apEnd, loc: i.locEnd, notes: i.notesEnd, ytdGp, ytdLabor, priorRevenue: revs } };
}
export function roadmap(start: RoadState, inputs: StepInput[], o: RoadOptions): RoadRow[] { const out: RoadRow[] = []; let st = start; for (const i of inputs) { const r = step(st, i, o); out.push(r.row); st = r.state; } return out; }

// ---------- What-if forecast built on the client's own history ----------
export interface Levers {
  /** Sales against the same month last year. */ salesChangePct: number;
  /** Gross profit before labor, as a share of sales. */ grossProfitPct: number;
  /** Payroll added (+) or cut (−) each month, before payroll taxes and benefits. */ payrollChangeMonthlyCents: number;
  /** Marketing, facilities and other operating expenses added (+) or cut (−) each month. */ overheadChangeMonthlyCents: number;
  /** Days customers take to pay. Null when sales are collected at the time of sale. */ dsoDays: number | null;
  debtPaydownMonthlyCents: number; purchasesMonthlyCents: number;
  distributionPolicy: 'tax_only' | 'tax_then_excess' | 'none';
}
export const TAX_MONTHS = [1, 4, 6, 9];
export interface WhatIfMonth extends RoadRow { truePretax: number; taxDistribution: number; profitDistribution: number; coreCapitalTarget: number }
export interface WhatIfSummary {
  fiscalYear: { from: string; to: string; actualMonths: number; forecastMonths: number; revenue: number; truePretax: number; pretaxPct: Ratio; targetPct: number };
  next12: { revenue: number; truePretax: number; pretaxPct: Ratio; ler: Ratio; startCash: number | null; endCash: number | null; minCash: number | null; minCashPeriod: string | null; endCoreCapital: number | null; endTarget: number; coreCapitalReached: string | null; taxDistributions: number; profitDistributions: number };
  vsBaseline: { pretax: number; endCash: number | null; minCash: number | null };
}
export interface WhatIfResult { available: boolean; reason?: string; basePeriod: string | null; cashAvailable: boolean; cashReason: string | null; levers: Levers; defaults: Levers; months: WhatIfMonth[]; baseline: { period: string; cashEnd: number; truePretax: number }[]; summary: WhatIfSummary | null; flags: { severity: 'good' | 'info' | 'warn'; text: string }[]; assumptions: string[] }
const $ = (c: number) => `${c < 0 ? '-' : ''}$${Math.round(Math.abs(c) / 100).toLocaleString('en-US')}`;
const pc = (x: number, d = 1) => `${(x * 100).toFixed(d)}%`;

/** Levers that reproduce "carry on as you are": last year's sales pattern, the last twelve months' margin, current staff and collection speed. */
export function defaultLevers(months: MonthData[], s: Settings): Levers {
  const n = months.length; const r = trailing(months, n - 1, Math.min(12, n), s)!; const d = dso(months, n - 1, s).value;
  return { salesChangePct: 0, grossProfitPct: Math.round((r.grossMarginPct.value ?? 0) * 1000) / 1000, payrollChangeMonthlyCents: 0, overheadChangeMonthlyCents: 0, dsoDays: d === null ? null : Math.round(d), debtPaydownMonthlyCents: 0, purchasesMonthlyCents: 0, distributionPolicy: 'tax_only' };
}

function run(months: MonthData[], s: Settings, lv: Levers, horizon: number) {
  const n = months.length; const last = months[n - 1]; const t = trailing(months, n - 1, Math.min(12, n), s)!; const k = t.monthsIncluded; const avg = (key: keyof PnlLines) => Math.round(t.lines[key] / k);
  const recent = months.slice(-3); const officePay = Math.round(recent.reduce((a, m) => a + m.pnl.mgmt_labor, 0) / recent.length);
  const dler = t.lines.direct_labor > 0 ? t.grossProfit / t.lines.direct_labor : null; const wagesR = t.lines.direct_labor + t.lines.mgmt_labor; const burden = wagesR > 0 ? t.lines.payroll_taxes_benefits / wagesR : 0;
  const overheadBase = avg('marketing') + avg('facilities') + avg('other_opex'); const share = (key: 'marketing' | 'facilities' | 'other_opex') => (overheadBase > 0 ? avg(key) / overheadBase : key === 'other_opex' ? 1 : 0);
  const ownerAdjMonthly = Math.round(months.slice(-k).reduce((a, m) => a + m.ownerAdj, 0) / k); const byPeriod = new Map(months.map((m) => [m.period, m.pnl]));
  const bs = last.bs; const nonLabor = (p: PnlLines) => p.cogs + p.marketing + p.facilities + p.other_opex; const startAp = bs ? bs.accounts_payable + bs.credit_cards : 0;
  const apBase = (nonLabor(last.pnl) + (n > 1 ? nonLabor(months[n - 2].pnl) : nonLabor(last.pnl))) / 2; const apRatio = apBase > 0 ? startAp / apBase : null;
  const win = Math.max(1, Math.round(s.dsoWindowDays / 30)); const fyActual = months.filter((m) => m.period >= fiscalStart(last.period, s.fiscalYearStartMonth));
  let st: RoadState = { cash: bs?.cash ?? 0, ar: bs?.accounts_receivable ?? 0, ap: startAp, loc: bs?.line_of_credit ?? 0, notes: bs?.notes_payable ?? 0, ytdGp: fyActual.reduce((a, m) => a + m.pnl.revenue - m.pnl.cogs, 0), ytdLabor: fyActual.reduce((a, m) => a + m.pnl.direct_labor + m.pnl.mgmt_labor, 0), priorRevenue: months.slice(-win).map((m) => m.pnl.revenue) };
  // Tax owed on profit earned since the last estimated-tax month and not yet distributed.
  let accrued = 0; for (let i = n - 1; i >= 0; i--) { accrued += computePnl(months[i].pnl, months[i].ownerAdj, s).pretax; if (TAX_MONTHS.includes(Number(months[i].period.slice(5, 7)))) break; }
  const spend = months.map((m) => { const p = computePnl(m.pnl, m.ownerAdj, s); return p.totalOpex + m.pnl.direct_labor + (s.coreCapitalExcludeCogs ? 0 : m.pnl.cogs); });
  const o: RoadOptions = { coreCapitalMonths: s.coreCapitalMonths, dsoWindowDays: s.dsoWindowDays, fiscalYearStartMonth: s.fiscalYearStartMonth };
  const out: WhatIfMonth[] = []; const made: PnlLines[] = []; let prevNonLabor = nonLabor(last.pnl);
  for (let i = 1; i <= horizon; i++) {
    const period = addMonths(last.period, i); const ly = byPeriod.get(addMonths(period, -12)) ?? made[i - 13]; const p = zeroPnl();
    p.revenue = Math.max(0, Math.round((ly ? ly.revenue : avg('revenue')) * (1 + lv.salesChangePct))); const gp = Math.round(p.revenue * lv.grossProfitPct); p.cogs = p.revenue - gp;
    p.direct_labor = dler ? Math.max(0, Math.round(gp / dler)) : avg('direct_labor'); p.mgmt_labor = Math.max(0, officePay + lv.payrollChangeMonthlyCents);
    p.payroll_taxes_benefits = Math.round((p.direct_labor + p.mgmt_labor) * burden);
    const overhead = Math.max(0, overheadBase + lv.overheadChangeMonthlyCents); p.marketing = Math.round(overhead * share('marketing')); p.facilities = Math.round(overhead * share('facilities')); p.other_opex = overhead - p.marketing - p.facilities;
    p.depreciation = avg('depreciation'); p.other_income_expense = avg('other_income_expense'); p.interest_expense = avg('interest_expense'); made.push(p);
    const c = computePnl(p, ownerAdjMonthly, s); const labor = p.direct_labor + p.mgmt_labor; const otherNet = c.pretax - (gp - labor - p.marketing - p.facilities - p.payroll_taxes_benefits - p.other_opex);
    const arEnd = lv.dsoDays === null || !bs ? st.ar : arForDso(lv.dsoDays, [...st.priorRevenue, p.revenue].slice(-win), s.dsoWindowDays);
    const nl = nonLabor(p); const apEnd = apRatio === null ? st.ap : Math.round(apRatio * ((nl + prevNonLabor) / 2)); prevNonLabor = nl;
    const payLoc = Math.min(st.loc, lv.debtPaydownMonthlyCents); const payNotes = Math.min(st.notes, lv.debtPaydownMonthlyCents - payLoc);
    const taxDist = lv.distributionPolicy !== 'none' && TAX_MONTHS.includes(Number(period.slice(5, 7))) ? Math.max(0, Math.round(accrued * s.taxReserveRate)) : 0;
    if (TAX_MONTHS.includes(Number(period.slice(5, 7)))) accrued = 0; accrued += c.pretax;
    spend.push(c.totalOpex + p.direct_labor + (s.coreCapitalExcludeCogs ? 0 : p.cogs)); const sp = spend.slice(-12); const target = Math.round((sp.reduce((a, b) => a + b, 0) / sp.length) * s.coreCapitalMonths);
    const input: StepInput = { period, revenue: p.revenue, cogs: p.cogs, labor, marketing: p.marketing, facilities: p.facilities, payrollTaxesBenefits: p.payroll_taxes_benefits, otherOpex: p.other_opex, otherNet, nonCash: p.depreciation, arEnd, apEnd, locEnd: st.loc - payLoc, notesEnd: st.notes - payNotes, distributions: taxDist, purchases: lv.purchasesMonthlyCents };
    let r = step(st, input, o); let profitDist = 0;
    if (lv.distributionPolicy === 'tax_then_excess' && bs) { const excess = r.row.coreCapital - target - Math.max(0, Math.round(accrued * s.taxReserveRate)); if (excess > 0) { profitDist = excess; r = step(st, { ...input, distributions: taxDist + excess }, o); } }
    st = r.state; out.push({ ...r.row, truePretax: c.adjustedPretax, taxDistribution: taxDist, profitDistribution: profitDist, coreCapitalTarget: target });
  }
  return out;
}
const fiscalStart = (period: string, startMonth: number) => { const y = Number(period.slice(0, 4)), m = Number(period.slice(5, 7)); return `${m >= startMonth ? y : y - 1}-${String(startMonth).padStart(2, '0')}`; };

export function whatIf(months: MonthData[], s: Settings, partial: Partial<Levers> = {}, horizon = 12): WhatIfResult {
  const none = (reason: string): WhatIfResult => ({ available: false, reason, basePeriod: months.at(-1)?.period ?? null, cashAvailable: false, cashReason: null, levers: partial as Levers, defaults: partial as Levers, months: [], baseline: [], summary: null, flags: [], assumptions: [] });
  if (months.length < 3) return none('A forecast needs at least three months of history.');
  const defaults = defaultLevers(months, s); const lv: Levers = { ...defaults, ...partial }; if (defaults.dsoDays === null) lv.dsoDays = null;
  const last = months[months.length - 1]; const cashAvailable = !!last.bs; const rows = run(months, s, lv, horizon); const base = run(months, s, defaults, horizon); const sum = (a: WhatIfMonth[], f: (r: WhatIfMonth) => number) => a.reduce((x, r) => x + f(r), 0);
  // Where the fiscal year lands: what has happened so far plus what is forecast for the rest of it.
  const first = rows[0].period; const fyFrom = fiscalStart(first, s.fiscalYearStartMonth); const fyTo = addMonths(fyFrom, 11); const act = months.filter((m) => m.period >= fyFrom); const fc = rows.filter((r) => r.period <= fyTo);
  const fyRev = act.reduce((a, m) => a + m.pnl.revenue, 0) + sum(fc, (r) => r.revenue); const fyPretax = act.reduce((a, m) => a + computePnl(m.pnl, m.ownerAdj, s).adjustedPretax, 0) + sum(fc, (r) => r.truePretax);
  const min = cashAvailable ? rows.reduce((a, r) => (r.cashEnd < a.cashEnd ? r : a)) : null; const bmin = cashAvailable ? base.reduce((a, r) => (r.cashEnd < a.cashEnd ? r : a)) : null; const end = rows[rows.length - 1]; const reached = cashAvailable ? rows.find((r) => r.coreCapital >= r.coreCapitalTarget) ?? null : null;
  const rev12 = sum(rows, (r) => r.revenue), pre12 = sum(rows, (r) => r.truePretax);
  const summary: WhatIfSummary = {
    fiscalYear: { from: fyFrom, to: fyTo, actualMonths: act.length, forecastMonths: fc.length, revenue: fyRev, truePretax: fyPretax, pretaxPct: ratio(fyPretax, fyRev, 'there is no revenue'), targetPct: s.pretaxTargetPct },
    next12: { revenue: rev12, truePretax: pre12, pretaxPct: ratio(pre12, rev12, 'there is no revenue'), ler: ratio(sum(rows, (r) => r.grossProfit), sum(rows, (r) => r.labor), 'there is no labor cost'), startCash: last.bs?.cash ?? null, endCash: cashAvailable ? end.cashEnd : null, minCash: min?.cashEnd ?? null, minCashPeriod: min?.period ?? null,
      endCoreCapital: cashAvailable ? end.coreCapital : null, endTarget: end.coreCapitalTarget, coreCapitalReached: reached?.period ?? null, taxDistributions: sum(rows, (r) => r.taxDistribution), profitDistributions: sum(rows, (r) => r.profitDistribution) },
    vsBaseline: { pretax: pre12 - sum(base, (r) => r.truePretax), endCash: cashAvailable ? end.cashEnd - base[base.length - 1].cashEnd : null, minCash: min && bmin ? min.cashEnd - bmin.cashEnd : null } };
  const flags: WhatIfResult['flags'] = []; const v = summary.vsBaseline; const changed = JSON.stringify(lv) !== JSON.stringify(defaults);
  if (min && min.cashEnd < 0) flags.push({ severity: 'warn', text: `Cash runs out in ${periodLabel(min.period)}: the forecast is ${$(-min.cashEnd)} short at its lowest point. Decide now what changes, or how the gap is funded, rather than in ${periodLabel(min.period)}.` });
  else if (min && s.cashFloorCents > 0 && min.cashEnd < s.cashFloorCents) flags.push({ severity: 'warn', text: `Cash dips to ${$(min.cashEnd)} in ${periodLabel(min.period)}, below the ${$(s.cashFloorCents)} minimum set for this business.` });
  if (changed && v.endCash !== null && v.pretax > 0 && v.endCash < 0) flags.push({ severity: 'warn', text: `Profit improves by ${$(v.pretax)} but cash ends ${$(-v.endCash)} lower than if nothing changed. Growth, slower collections, debt payments or purchases are using the cash. Profit is not cash.` });
  else if (changed && v.endCash !== null) flags.push({ severity: v.pretax >= 0 && v.endCash >= 0 ? 'good' : 'info', text: `Against changing nothing, over twelve months this ${v.pretax >= 0 ? 'adds' : 'costs'} ${$(Math.abs(v.pretax))} of true pretax profit and leaves cash ${$(Math.abs(v.endCash))} ${v.endCash >= 0 ? 'higher' : 'lower'}.` });
  else if (changed) flags.push({ severity: v.pretax >= 0 ? 'good' : 'info', text: `Against changing nothing, over twelve months this ${v.pretax >= 0 ? 'adds' : 'costs'} ${$(Math.abs(v.pretax))} of true pretax profit.` });
  const p12 = summary.next12.pretaxPct.value; if (p12 !== null) flags.push(p12 >= s.pretaxTargetPct ? { severity: 'good', text: `True pretax profit comes to ${pc(p12)} of sales over the twelve months, at or above the ${pc(s.pretaxTargetPct, 0)} target.` } : { severity: 'info', text: `True pretax profit comes to ${pc(p12)} of sales over the twelve months, short of the ${pc(s.pretaxTargetPct, 0)} target by ${$(Math.round(s.pretaxTargetPct * rev12) - pre12)}.` });
  if (cashAvailable) flags.push(reached ? { severity: 'good', text: end.coreCapital >= end.coreCapitalTarget ? `Operating reserve is at or above its target at the end of the twelve months (${$(end.coreCapital)} against ${$(end.coreCapitalTarget)}).` : `Operating reserve reaches its target in ${periodLabel(reached.period)} but ends the twelve months at ${$(end.coreCapital)} against ${$(end.coreCapitalTarget)}.` }
    : { severity: 'info', text: `Operating reserve does not reach its target within twelve months (${$(end.coreCapital)} against ${$(end.coreCapitalTarget)} at the end). Until it does, take distributions for taxes only.` });
  const assumptions = [
    `Sales follow last year's pattern month by month${lv.salesChangePct ? `, ${lv.salesChangePct > 0 ? 'up' : 'down'} ${pc(Math.abs(lv.salesChangePct), 0)}` : ''}.`,
    `Gross profit before labor is ${pc(lv.grossProfitPct)} of sales. Direct labor moves with gross profit at the last twelve months' rate; office and management payroll stays at the last three months' level${lv.payrollChangeMonthlyCents ? `, ${lv.payrollChangeMonthlyCents > 0 ? 'plus' : 'less'} ${$(Math.abs(lv.payrollChangeMonthlyCents))} a month` : ''}.`,
    `Marketing, facilities and other expenses stay at their twelve-month average${lv.overheadChangeMonthlyCents ? `, ${lv.overheadChangeMonthlyCents > 0 ? 'plus' : 'less'} ${$(Math.abs(lv.overheadChangeMonthlyCents))} a month` : ''}. Payroll taxes and benefits follow payroll.`,
    cashAvailable ? `Cash starts from the ${periodLabel(last.period)} balance sheet. ${lv.dsoDays === null ? 'Sales are collected when made.' : `Customers pay in ${lv.dsoDays} days.`} Bills are paid on the same terms as now.` : 'Cash is not forecast.',
    lv.distributionPolicy === 'none' ? 'No owner distributions.' : `Owner distributions for tax (${pc(s.taxReserveRate, 0)} of profit) go out in January, April, June and September${lv.distributionPolicy === 'tax_then_excess' ? ', and anything above the operating reserve target is distributed as profit' : '; no other distributions'}.`,
    'True pretax profit is after paying the owner a market wage. A forecast is an estimate, not a result, and is rebuilt every time new months are approved.' ];
  return { available: true, basePeriod: last.period, cashAvailable, cashReason: cashAvailable ? null : `No balance sheet has been imported for ${periodLabel(last.period)}, so cash is not forecast. Profit is.`, levers: lv, defaults, months: rows, baseline: base.map((r) => ({ period: r.period, cashEnd: r.cashEnd, truePretax: r.truePretax })), summary, flags, assumptions };
}
