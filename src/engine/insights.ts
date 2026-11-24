// Transparent recommendation layer: Observation → Financial cause → Business impact → Recommended action.
// Rule-based and traceable. A financial impact is stated only when it is direct arithmetic on the client's own figures;
// otherwise impactCents is null. Advisors approve, edit, suppress or replace every item before a client sees it.
import { type CoreCapital, type Settings, type WindowResult, fmtDays, fmtMoney, fmtPct, fmtRatio, periodLabel } from './core.ts';
import { type Measure, type Scorecard } from './scorecard.ts';

export interface Insight {
  key: string; kpi: Measure['key']; severity: number; title: string;
  observation: string; cause: string; impact: string; action: string;
  impactCents: number | null; impactBasis: string | null;
  evidence: { label: string; value: string }[]; period: string; completeness: string;
}

export function generateInsights(sc: Scorecard, r12: WindowResult, prior: WindowResult | null, cc: CoreCapital, s: Settings): Insight[] {
  const out: Insight[] = [];
  const by = Object.fromEntries(sc.measures.map((m) => [m.key, m])) as Record<Measure['key'], Measure>;
  const sev = (m: Measure) => (m.grade === 'Caution' ? 3 : m.grade === 'OK' ? 2 : 0);
  const span = `Rolling 12 months ${periodLabel(r12.from)} – ${periodLabel(r12.to)}`;
  const completeness = r12.complete ? 'Complete: 12 of 12 months' : `Partial: ${r12.monthsIncluded} of 12 months`;
  const base = { period: span, completeness };

  const labor = by.labor;
  if (sev(labor) && s.dlerTarget && r12.dLER.value !== null) {
    const allowed = Math.round(r12.grossProfit / s.dlerTarget); const over = r12.lines.direct_labor - allowed;
    const gpNeeded = Math.round(r12.lines.direct_labor * s.dlerTarget) - r12.grossProfit;
    out.push({ ...base, key: 'labor_efficiency', kpi: 'labor', severity: sev(labor) + 0.3, title: 'Labor efficiency is below your target.',
      observation: `Direct LER is ${fmtRatio(r12.dLER.value)} against a target of ${fmtRatio(s.dlerTarget)}.`,
      cause: `Direct labor of ${fmtMoney(r12.lines.direct_labor)} produced ${fmtMoney(r12.grossProfit)} of gross profit. Labor cost has grown relative to the gross profit it produces.`,
      impact: `At the target, this gross profit supports ${fmtMoney(allowed)} of direct labor — ${fmtMoney(over)} less than was spent. Equivalently, the current team would need to produce ${fmtMoney(gpNeeded)} more gross profit.`,
      action: 'Review utilization and service pricing before increasing headcount.',
      impactCents: over, impactBasis: 'Direct labor − (gross profit ÷ target direct LER), rolling 12 months.',
      evidence: [{ label: 'Gross profit (R12)', value: fmtMoney(r12.grossProfit) }, { label: 'Direct labor (R12)', value: fmtMoney(r12.lines.direct_labor) }, { label: 'Target direct LER', value: fmtRatio(s.dlerTarget) }] });
  }
  const profit = by.profitability;
  if (sev(profit) && r12.adjustedPretaxPct.value !== null) {
    const gap = Math.round(r12.lines.revenue * s.pretaxTargetPct) - r12.adjustedPretax;
    const gm = r12.grossMarginPct.value;
    let cause = `Reported pretax profit is ${fmtMoney(r12.pretax)}; after a ${fmtMoney(r12.ownerAdj)} owner-pay normalization, true profit is ${fmtMoney(r12.adjustedPretax)}.`;
    if (prior && prior.complete) {
      const dRev = r12.lines.revenue - prior.lines.revenue, dPre = r12.adjustedPretax - prior.adjustedPretax;
      const dGp = r12.grossProfit - prior.grossProfit, dLabor = r12.totalLabor - prior.totalLabor, dOpex = (r12.totalOpex - r12.lines.mgmt_labor) - (prior.totalOpex - prior.lines.mgmt_labor);
      cause += ` Versus the prior 12 months: revenue ${dRev >= 0 ? '+' : '−'}${fmtMoney(Math.abs(dRev))}, gross profit ${dGp >= 0 ? '+' : '−'}${fmtMoney(Math.abs(dGp))}, labor ${dLabor >= 0 ? '+' : '−'}${fmtMoney(Math.abs(dLabor))}, other operating expenses ${dOpex >= 0 ? '+' : '−'}${fmtMoney(Math.abs(dOpex))}, true profit ${dPre >= 0 ? '+' : '−'}${fmtMoney(Math.abs(dPre))}.`;
    }
    out.push({ ...base, key: 'profitability', kpi: 'profitability', severity: sev(profit) + 0.2, title: 'True profit is below your target.',
      observation: `Pretax profit after market-rate owner pay is ${fmtPct(r12.adjustedPretaxPct.value)} of revenue against a ${fmtPct(s.pretaxTargetPct)} target.`,
      cause, impact: `Reaching the target on current revenue requires ${fmtMoney(gap)} more annual pretax profit${gm && gm > 0 ? ` — about ${fmtMoney(Math.round(gap / gm))} of additional sales at the current ${fmtPct(gm)} gross margin, or a ${fmtPct(gap / r12.lines.revenue)} price increase with no loss of volume` : ''}.`,
      action: 'Decide which lever to pull first — price, volume, or labor cost — and test it in the Decision Lab.',
      impactCents: gap, impactBasis: 'Revenue × target pretax % − adjusted pretax profit, rolling 12 months.',
      evidence: [{ label: 'Revenue (R12)', value: fmtMoney(r12.lines.revenue) }, { label: 'Adjusted pretax profit', value: fmtMoney(r12.adjustedPretax) }, { label: 'Owner-pay normalization', value: fmtMoney(r12.ownerAdj) }] });
  }
  const cap = by.salary_cap;
  if (sev(cap)) out.push({ ...base, key: 'salary_cap', kpi: 'salary_cap', severity: sev(cap), title: 'Labor cost is over the salary cap.',
    observation: `Total labor including the owner-pay adjustment is ${fmtMoney(r12.adjustedLabor)} against a cap of ${fmtMoney(r12.salaryCap)}.`,
    cause: `The cap is what labor can cost while still earning ${fmtPct(s.pretaxTargetPct)} pretax on ${fmtMoney(r12.lines.revenue)} of revenue, after non-labor costs.`,
    impact: `Labor is ${fmtMoney(-r12.salaryCapHeadroom)} over the cap for the 12 months. Adding payroll now would widen the gap unless gross profit grows with it.`,
    action: 'Hold new hires until a scenario shows the added gross profit that keeps labor under the cap.',
    impactCents: -r12.salaryCapHeadroom, impactBasis: 'Adjusted labor − salary cap, rolling 12 months.',
    evidence: [{ label: 'Salary cap', value: fmtMoney(r12.salaryCap) }, { label: 'Adjusted labor', value: fmtMoney(r12.adjustedLabor) }] });
  const core = by.core_capital;
  if (sev(core) && cc.available !== null) out.push({ ...base, key: 'core_capital', kpi: 'core_capital', severity: sev(core) + 0.1, title: 'Cash reserves are below the core capital target.',
    observation: `Available cash is ${fmtMoney(cc.available)} against a target of ${fmtMoney(cc.target)} (${fmtRatio(cc.monthsCovered.value, 1).replace('x', '')} months of expenses covered).`,
    cause: `The target is ${cc.basisLabel}.${cc.locBalance ? ` A line-of-credit balance of ${fmtMoney(cc.locBalance)} is deducted from cash.` : ''}`,
    impact: `The reserve is short by ${fmtMoney(-(cc.surplus ?? 0))}. Until it is funded, a slow collection month would have to be covered by debt or delayed payments.`,
    action: 'Hold owner distributions beyond tax needs until the reserve reaches target.',
    impactCents: -(cc.surplus ?? 0), impactBasis: 'Core capital target − (cash − line of credit).',
    evidence: [{ label: 'Cash', value: fmtMoney(cc.cash) }, { label: 'Line of credit', value: fmtMoney(cc.locBalance) }, { label: 'Target', value: fmtMoney(cc.target) }] });
  const d = by.dso;
  if (sev(d) && d.actual !== null && s.dsoTargetDays) {
    const daily = r12.lines.revenue / 365; const tied = Math.round((d.actual - s.dsoTargetDays) * daily);
    out.push({ ...base, key: 'dso', kpi: 'dso', severity: sev(d), title: 'Customers are taking longer to pay than your target.',
      observation: `A/R days sales outstanding is ${fmtDays(d.actual)} against a target of ${fmtDays(s.dsoTargetDays)}.`,
      cause: 'Receivables have grown faster than sales over the measurement window.',
      impact: `At average daily sales of ${fmtMoney(Math.round(daily))}, the extra ${Math.round(d.actual - s.dsoTargetDays)} days hold roughly ${fmtMoney(tied)} in receivables that would otherwise be cash.`,
      action: 'Work the oldest invoices first and consider deposits or earlier billing on new jobs.',
      impactCents: tied, impactBasis: '(DSO − target DSO) × rolling-12 revenue ÷ 365.', evidence: [{ label: 'DSO', value: fmtDays(d.actual) }, { label: 'Average daily sales', value: fmtMoney(Math.round(daily)) }] });
  }
  const ox = by.opex;
  if (sev(ox) && ox.actual !== null && s.opexPctTarget !== null) {
    const over = Math.round((ox.actual - s.opexPctTarget) * r12.lines.revenue);
    out.push({ ...base, key: 'opex', kpi: 'opex', severity: sev(ox), title: 'Operating expenses are above target.',
      observation: `Operating expenses are ${fmtPct(ox.actual)} of revenue against a ${fmtPct(s.opexPctTarget)} target.`,
      cause: `Operating expenses total ${fmtMoney(r12.totalOpex)}: facilities ${fmtMoney(r12.lines.facilities)}, marketing ${fmtMoney(r12.lines.marketing)}, management labor ${fmtMoney(r12.lines.mgmt_labor)}, payroll taxes and benefits ${fmtMoney(r12.lines.payroll_taxes_benefits)}, other ${fmtMoney(r12.lines.other_opex)}.`,
      impact: `Spending is ${fmtMoney(over)} above the target level for this revenue.`, action: 'Review the largest expense categories for items that have grown faster than sales.',
      impactCents: over, impactBasis: '(Opex % − target %) × rolling-12 revenue.', evidence: [{ label: 'Operating expenses (R12)', value: fmtMoney(r12.totalOpex) }] });
  }
  const sl = by.sales;
  if (sev(sl) && sl.actual !== null && sl.target !== null) out.push({ ...base, key: 'sales', kpi: 'sales', severity: sev(sl), title: 'Sales are behind target.',
    observation: `Rolling-12 revenue is ${fmtMoney(sl.actual)} against ${sl.targetLabel.toLowerCase()} of ${fmtMoney(sl.target)}.`,
    cause: 'Revenue over the last 12 months is below the comparison level.', impact: `The shortfall is ${fmtMoney(sl.target - sl.actual)}.`,
    action: 'Review pipeline, pricing and retention to identify where the shortfall arose.', impactCents: sl.target - sl.actual, impactBasis: 'Target − rolling-12 revenue.',
    evidence: [{ label: 'Revenue (R12)', value: fmtMoney(sl.actual) }] });
  return out.sort((a, b) => b.severity - a.severity);
}
