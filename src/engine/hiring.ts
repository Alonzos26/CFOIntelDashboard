// Hiring scenario engine. Sources: New Employee or Contractor.xlsx (four calculators), Hiring Workshop,
// Cash Rhythms "Scenario 1 - new hire". Corrects the workbook's wage-base and summary-total errors (see docs/SOURCE_MAPPING.md).
import { type PnlLines, type Settings, addMonths, computePnl, periodLabel, ratio, type Ratio, zeroPnl, PNL_LINES } from './core.ts';

export interface PayrollTax { name: string; rate: number; wageBaseCents: number | null }

/** Editable ASSUMPTIONS, not tax advice. Rates and wage bases change yearly and vary by state — confirm with the payroll provider. */
export const DEFAULT_PAYROLL_TAXES: PayrollTax[] = [
  { name: 'Social Security (employer)', rate: 0.062, wageBaseCents: 18_450_000 },
  { name: 'Medicare (employer)', rate: 0.0145, wageBaseCents: null },
  { name: 'Federal unemployment (FUTA)', rate: 0.006, wageBaseCents: 700_000 },
  { name: 'State unemployment (SUTA)', rate: 0.02, wageBaseCents: 1_000_000 },
];

export type WorkerType = 'salaried' | 'hourly' | 'contractor_fixed' | 'contractor_hourly';
export interface HiringInputs {
  title: string;
  startPeriod: string;
  workerType: WorkerType;
  roleType: 'direct' | 'management';
  annualSalaryCents: number;       // salaried
  hourlyRateCents: number;         // hourly employee / hourly contractor
  hoursPerWeek: number;
  overtimeHoursPerWeek: number; overtimeMultiplier: number;
  contractMonthlyFeeCents: number; // fixed-fee contractor
  taxes: PayrollTax[];
  workersCompPct: number;
  healthMonthlyCents: number; retirementMatchPct: number; otherBenefitsMonthlyCents: number;
  ptoDays: number; paidHolidays: number;
  softwareMonthlyCents: number;
  equipmentOneTimeCents: number; recruitingOneTimeCents: number; onboardingOneTimeCents: number;
  trainingMonths: number; rampMonths: number;
  expectedMonthlyRevenueCents: number; // at full productivity
  grossMarginPct: number | null;       // null = use baseline margin
  billRateCents: number | null;
  replacing: boolean; replacedMonthlyCostCents: number;
  guardrailMinCashCents: number | null; // null = use operating reserve target
}

export function defaultHiringInputs(startPeriod: string): HiringInputs {
  return {
    title: 'New team member', startPeriod, workerType: 'salaried', roleType: 'direct',
    annualSalaryCents: 6_000_000, hourlyRateCents: 2_800, hoursPerWeek: 40, overtimeHoursPerWeek: 0, overtimeMultiplier: 1.5,
    contractMonthlyFeeCents: 600_000, taxes: DEFAULT_PAYROLL_TAXES.map((t) => ({ ...t })),
    workersCompPct: 0.01, healthMonthlyCents: 50_000, retirementMatchPct: 0.03, otherBenefitsMonthlyCents: 0,
    ptoDays: 10, paidHolidays: 7, softwareMonthlyCents: 10_000,
    equipmentOneTimeCents: 200_000, recruitingOneTimeCents: 150_000, onboardingOneTimeCents: 50_000,
    trainingMonths: 1, rampMonths: 2, expectedMonthlyRevenueCents: 1_500_000, grossMarginPct: null, billRateCents: null,
    replacing: false, replacedMonthlyCostCents: 0, guardrailMinCashCents: null,
  };
}

export interface HiringBaseline {
  asOf: string;
  months: { period: string; pnl: PnlLines }[]; // baseline forecast, first month = asOf + 1
  ownerAdjMonthlyCents: number;
  startingCashCents: number | null;
  nonPnlCashOutMonthlyCents: number; // debt principal, distributions, tax payments, capex from the cash plan
  collectionLagMonths: number;
  coreCapitalTargetCents: number;
}

export interface CostBreakdown {
  isEmployee: boolean;
  annualWagesCents: number; annualTaxesCents: number; taxLines: { name: string; annualCents: number }[];
  annualWorkersCompCents: number; annualBenefitsCents: number; annualSoftwareCents: number;
  monthlyLoadedCents: number; annualLoadedCents: number; oneTimeCents: number; firstMonthCents: number; firstYearCents: number;
  loadFactor: Ratio; productiveHoursPerYear: number | null; costPerProductiveHourCents: number | null;
}

/** Fully loaded cost. Wage-base caps are applied to ANNUAL wages (the source hourly sheet compared monthly pay with annual caps). */
export function costOfHire(i: HiringInputs): CostBreakdown {
  const isEmployee = i.workerType === 'salaried' || i.workerType === 'hourly';
  const annualHours = i.hoursPerWeek * 52;
  let wages = 0;
  if (i.workerType === 'salaried') wages = i.annualSalaryCents;
  else if (i.workerType === 'hourly') wages = Math.round(i.hourlyRateCents * (annualHours + i.overtimeHoursPerWeek * 52 * i.overtimeMultiplier));
  else if (i.workerType === 'contractor_hourly') wages = Math.round(i.hourlyRateCents * annualHours);
  else wages = i.contractMonthlyFeeCents * 12;
  const taxLines = isEmployee ? i.taxes.map((t) => ({ name: t.name, annualCents: Math.round(t.rate * (t.wageBaseCents === null ? wages : Math.min(wages, t.wageBaseCents))) })) : [];
  const taxes = taxLines.reduce((a, t) => a + t.annualCents, 0);
  const wc = isEmployee ? Math.round(wages * i.workersCompPct) : 0;
  const benefits = isEmployee ? i.healthMonthlyCents * 12 + Math.round(wages * i.retirementMatchPct) + i.otherBenefitsMonthlyCents * 12 : 0;
  const software = i.softwareMonthlyCents * 12;
  const annualLoaded = wages + taxes + wc + benefits + software;
  const oneTime = i.equipmentOneTimeCents + i.recruitingOneTimeCents + i.onboardingOneTimeCents;
  const monthly = Math.round(annualLoaded / 12);
  const paidDaysOff = isEmployee ? i.ptoDays + i.paidHolidays : 0;
  const productiveHours = i.hoursPerWeek > 0 ? Math.max(0, annualHours - paidDaysOff * (i.hoursPerWeek / 5)) : null;
  return {
    isEmployee, annualWagesCents: wages, annualTaxesCents: taxes, taxLines, annualWorkersCompCents: wc, annualBenefitsCents: benefits, annualSoftwareCents: software,
    monthlyLoadedCents: monthly, annualLoadedCents: annualLoaded, oneTimeCents: oneTime, firstMonthCents: monthly + oneTime, firstYearCents: annualLoaded + oneTime,
    loadFactor: ratio(annualLoaded, wages, 'no pay was entered'),
    productiveHoursPerYear: productiveHours, costPerProductiveHourCents: productiveHours ? Math.round(annualLoaded / productiveHours) : null,
  };
}

export function productivity(monthIndex: number, i: Pick<HiringInputs, 'trainingMonths' | 'rampMonths'>): number {
  if (monthIndex < i.trainingMonths) return 0;
  return Math.min(1, (monthIndex - i.trainingMonths + 1) / (i.rampMonths + 1));
}

export interface HiringMonth {
  period: string; active: boolean; productivity: number;
  costCents: number; addedRevenueCents: number; addedGrossProfitCents: number; profitImpactCents: number; cumulativeImpactCents: number;
  baselinePretaxCents: number; scenarioPretaxCents: number;
  baselineCashCents: number | null; scenarioCashCents: number | null;
}
export interface Summary { revenue: number; grossProfit: number; pretax: number; adjustedPretaxPct: Ratio; dLER: Ratio; tLER: Ratio; minCash: number | null; endCash: number | null }
export interface HiringResult {
  cost: CostBreakdown;
  netMonthlyCostCents: number; marginUsed: number;
  breakEvenGrossProfitCents: number; breakEvenRevenueCents: number | null; breakEvenBillableHours: number | null;
  gpToHoldTargetCents: number | null; revenueToHoldTargetCents: number | null;
  firstPositiveMonth: string | null; paybackMonth: string | null;
  timeline: HiringMonth[];
  baseline: Summary; scenario: Summary;
  profitImpact12Cents: number;
  guardrailCents: number | null; guardrailBreached: boolean | null; baselineBelowGuardrail: boolean | null;
  earliestSupportableStart: string | null; earliestNote: string;
  decisionSummary: string; assumptions: string[];
}

function project(i: HiringInputs, b: HiringBaseline, s: Settings, start: string) {
  const cost = costOfHire(i);
  const g = i.grossMarginPct ?? baselineMargin(b);
  const net = cost.monthlyLoadedCents - (i.replacing ? i.replacedMonthlyCostCents : 0);
  const timeline: HiringMonth[] = [];
  const scenarioPnl: PnlLines[] = [];
  const revAdded: number[] = [];
  let cum = 0; let baseCash = b.startingCashCents; let scenCash = b.startingCashCents;
  b.months.forEach((m, idx) => {
    const active = m.period >= start;
    const k = active ? b.months.findIndex((x) => x.period >= start) : -1;
    const sinceStart = active ? idx - k : -1;
    const prod = active ? productivity(sinceStart, i) : 0;
    const first = active && sinceStart === 0;
    const addedRev = active ? Math.round(i.expectedMonthlyRevenueCents * prod) : 0;
    const addedGP = Math.round(addedRev * g);
    const costM = active ? net + (first ? cost.oneTimeCents : 0) : 0;
    revAdded.push(addedRev);
    const impact = addedGP - costM; cum += impact;
    // Scenario P&L: wages to the role's labor line, burden to payroll taxes & benefits, software and one-time costs to other opex.
    const p = { ...m.pnl };
    if (active) {
      const wagesM = Math.round(cost.annualWagesCents / 12);
      const burdenM = Math.round((cost.annualTaxesCents + cost.annualWorkersCompCents + cost.annualBenefitsCents) / 12);
      const offset = i.replacing ? i.replacedMonthlyCostCents : 0;
      p.revenue += addedRev; p.cogs += addedRev - addedGP;
      if (i.roleType === 'direct') p.direct_labor += wagesM - offset; else p.mgmt_labor += wagesM - offset;
      p.payroll_taxes_benefits += burdenM;
      p.other_opex += costM + offset - wagesM - burdenM; // software + one-time + rounding remainder
    }
    scenarioPnl.push(p);
    const basePre = computePnl(m.pnl, 0, s).pretax;
    const scenPre = computePnl(p, 0, s).pretax;
    // Cash: costs and added COGS are paid in the month; added revenue is collected after the collection lag.
    const collected = idx - b.collectionLagMonths >= 0 ? revAdded[idx - b.collectionLagMonths] : 0;
    const baseNet = basePre + m.pnl.depreciation - b.nonPnlCashOutMonthlyCents;
    if (baseCash !== null && scenCash !== null) { baseCash += baseNet; scenCash += baseNet + collected - (addedRev - addedGP) - costM; }
    timeline.push({ period: m.period, active, productivity: prod, costCents: costM, addedRevenueCents: addedRev, addedGrossProfitCents: addedGP, profitImpactCents: impact, cumulativeImpactCents: cum, baselinePretaxCents: basePre, scenarioPretaxCents: scenPre, baselineCashCents: baseCash, scenarioCashCents: scenCash });
  });
  return { cost, g, net, timeline, scenarioPnl };
}

function baselineMargin(b: HiringBaseline): number {
  const rev = b.months.reduce((a, m) => a + m.pnl.revenue, 0); const cogs = b.months.reduce((a, m) => a + m.pnl.cogs, 0);
  return rev > 0 ? (rev - cogs) / rev : 0;
}
function summarize(pnls: PnlLines[], ownerAdj: number, cash: (number | null)[], s: Settings): Summary {
  const t = zeroPnl(); for (const p of pnls) for (const k of PNL_LINES) t[k] += p[k];
  const r = computePnl(t, ownerAdj * pnls.length, s);
  const c = cash.filter((x): x is number => x !== null);
  return { revenue: t.revenue, grossProfit: r.grossProfit, pretax: r.pretax, adjustedPretaxPct: r.adjustedPretaxPct, dLER: r.dLER, tLER: r.tLER, minCash: c.length ? Math.min(...c) : null, endCash: c.length ? c[c.length - 1] : null };
}

export function evaluateHire(i: HiringInputs, b: HiringBaseline, s: Settings): HiringResult {
  const start = i.startPeriod < b.months[0].period ? b.months[0].period : i.startPeriod;
  const { cost, g, net, timeline, scenarioPnl } = project(i, b, s, start);
  const p = s.pretaxTargetPct;
  const breakEvenRevenue = g > 0 ? Math.round(net / g) : null;
  const revToHold = g > p ? Math.round(net / (g - p)) : null;
  const guardrail = i.guardrailMinCashCents ?? (b.startingCashCents === null ? null : b.coreCapitalTargetCents);
  const horizon = timeline.slice(0, 12);
  const scen = summarize(scenarioPnl.slice(0, 12), b.ownerAdjMonthlyCents, horizon.map((t) => t.scenarioCashCents), s);
  const base = summarize(b.months.slice(0, 12).map((m) => m.pnl), b.ownerAdjMonthlyCents, horizon.map((t) => t.baselineCashCents), s);
  const activeMonths = timeline.filter((t) => t.active);
  const firstPositive = activeMonths.find((t) => t.profitImpactCents > 0)?.period ?? null;
  const payback = activeMonths.find((t) => t.cumulativeImpactCents >= 0 && t.profitImpactCents > 0)?.period ?? null;

  // Earliest start (within the forecast window) at which projected cash never falls below the guardrail.
  let earliest: string | null = null; let earliestNote: string;
  if (guardrail === null) earliestNote = 'Cannot be determined: no cash balance is on file. Import a balance sheet or enter a bank balance.';
  else {
    const last = Math.max(0, b.months.length - 12);
    for (let k = 0; k <= last; k++) {
      const cand = b.months[k].period;
      const run = project(i, b, s, cand).timeline.slice(k, k + 12);
      if (run.every((t) => t.scenarioCashCents !== null && t.scenarioCashCents >= guardrail)) { earliest = cand; break; }
    }
    earliestNote = earliest ? `Projected cash stays at or above the guardrail for 12 months after a ${periodLabel(earliest)} start.`
      : base.minCash !== null && base.minCash < guardrail ? 'Projected cash is already below this guardrail without the hire, so no start date satisfies it. Build reserves first, or set a guardrail that reflects the minimum you are willing to operate with.'
      : `No start date within ${last + 1} months keeps projected cash above the guardrail under these assumptions.`;
  }
  const breached = guardrail === null || scen.minCash === null ? null : scen.minCash < guardrail;
  const dollars = (c: number) => `$${Math.round(c / 100).toLocaleString('en-US')}`;
  const decisionSummary = revToHold === null
    ? `At a ${(g * 100).toFixed(0)}% gross margin, added sales cannot cover this hire while holding a ${(p * 100).toFixed(0)}% profit target. The role costs ${dollars(net)} per month fully loaded.`
    : `The proposed hire requires an additional ${dollars(Math.round(revToHold * g))} in monthly gross profit (about ${dollars(revToHold)} in sales at a ${(g * 100).toFixed(0)}% margin) to maintain your ${(p * 100).toFixed(0)}% target profitability. Break-even is ${dollars(net)} of gross profit per month.`;
  return {
    cost, netMonthlyCostCents: net, marginUsed: g,
    breakEvenGrossProfitCents: net, breakEvenRevenueCents: breakEvenRevenue,
    breakEvenBillableHours: i.billRateCents && breakEvenRevenue !== null ? breakEvenRevenue / i.billRateCents : null,
    gpToHoldTargetCents: revToHold === null ? null : Math.round(revToHold * g), revenueToHoldTargetCents: revToHold,
    firstPositiveMonth: firstPositive, paybackMonth: payback, timeline,
    baseline: base, scenario: scen, profitImpact12Cents: scen.pretax - base.pretax,
    guardrailCents: guardrail, guardrailBreached: breached, baselineBelowGuardrail: guardrail === null || base.minCash === null ? null : base.minCash < guardrail, earliestSupportableStart: earliest, earliestNote, decisionSummary,
    assumptions: [
      `Baseline is the driver-based forecast from actuals through ${periodLabel(b.asOf)}.`,
      `Gross margin on added sales: ${(g * 100).toFixed(1)}%${i.grossMarginPct === null ? ' (baseline forecast margin)' : ' (entered)'}.`,
      `Added sales are collected ${b.collectionLagMonths} month(s) after they are earned; costs are paid in the month incurred.`,
      'Payroll tax rates and wage bases are editable assumptions, averaged evenly across the year. Confirm current rates with your payroll provider.',
      'One-time costs are expensed in the first month.',
      b.startingCashCents === null ? 'No cash balance on file, so cash results are not available.' : `Projected cash deducts ${dollars(b.nonPnlCashOutMonthlyCents)} per month of planned non-P&L payments (debt principal, distributions, taxes, equipment).`,
    ],
  };
}

export const nextPeriods = (asOf: string, n: number) => Array.from({ length: n }, (_, k) => addMonths(asOf, k + 1));
