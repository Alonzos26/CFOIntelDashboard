// Profit Planner. Source: Profit Planning Worksheet ("Profit Needs"), Profit Planning Workshop.
// Debt principal, asset purchases, savings and distributions are CASH USES funded from after-tax profit — they are not P&L expenses.
import { type Ratio, type WindowResult, ratio } from './core.ts';

export interface ProfitNeedsInput {
  debtPrincipalCents: number; assetPurchasesCents: number; savingsGoalCents: number; ownerDistributionsCents: number;
  estimatedTaxRate: number; // on pretax profit; an assumption supplied by the advisor
  marketOwnerPayCents: number; // annual market-rate pay for owner roles, already in (or added to) labor
}
export interface ProfitPlan {
  cashUsesCents: number; taxReserveCents: number; requiredPretaxCents: number; monthlyRequiredPretaxCents: number;
  currentPretaxCents: number; gapCents: number;
  contributionRate: Ratio; fixedCostsCents: number; requiredRevenueCents: number | null; requiredContributionCents: number;
  additionalGrossProfitCents: number; priceIncreasePct: Ratio; volumeIncreasePct: Ratio; expenseReductionCents: number; requiredDirectLER: Ratio;
  notes: string[];
}

export function profitPlan(i: ProfitNeedsInput, r12: WindowResult): ProfitPlan {
  const cashUses = i.debtPrincipalCents + i.assetPurchasesCents + i.savingsGoalCents + i.ownerDistributionsCents;
  const rate = Math.min(Math.max(i.estimatedTaxRate, 0), 0.9);
  const required = Math.round(cashUses / (1 - rate));
  const current = r12.adjustedPretax;
  const gap = Math.max(0, required - current);
  // Cost behavior: COGS, direct labor, marketing and payroll burden move with sales (variable); the rest are fixed for the year.
  const rev = r12.lines.revenue;
  const variable = r12.lines.cogs + r12.lines.direct_labor + r12.lines.marketing + r12.lines.payroll_taxes_benefits;
  const fixed = r12.lines.facilities + r12.lines.mgmt_labor + r12.lines.other_opex + r12.ownerAdj - r12.otherTotal;
  const cr = ratio(rev - variable, rev, 'there is no revenue history');
  const reqRev = cr.value && cr.value > 0 ? Math.round((required + fixed) / cr.value) : null;
  return {
    cashUsesCents: cashUses, taxReserveCents: required - cashUses, requiredPretaxCents: required, monthlyRequiredPretaxCents: Math.round(required / 12),
    currentPretaxCents: current, gapCents: gap, contributionRate: cr, fixedCostsCents: fixed, requiredRevenueCents: reqRev, requiredContributionCents: required + fixed,
    additionalGrossProfitCents: gap, priceIncreasePct: ratio(gap, rev, 'there is no revenue history'),
    volumeIncreasePct: reqRev === null ? { value: null, reason: 'Not available: sales do not cover variable costs.' } : ratio(Math.max(0, reqRev - rev), rev, 'there is no revenue history'),
    expenseReductionCents: gap, requiredDirectLER: ratio(r12.grossProfit, r12.lines.direct_labor - gap, 'direct labor would need to fall to zero'),
    notes: [
      'Required pretax profit = cash uses ÷ (1 − estimated tax rate). The tax rate is a planning assumption, not a tax calculation.',
      'Debt principal, asset purchases, savings and distributions are cash uses funded from after-tax profit; they are not expenses on the P&L.',
      'Depreciation add-backs and working-capital changes are not included in this simplified plan.',
      'Current profit is the rolling-12 pretax profit after normalizing owner pay to market rate.',
    ],
  };
}
