// Economic value, from Greg Crabtree, "Simple Numbers, Straight Talk, Big Profits!", ch. 9.
// Blended method: the last three years of pretax profit plus equity (assets minus liabilities). It blends earning capacity with
// how well the business is capitalized. Rules of thumb (multiples of EBITDA or sales) are shown only for comparison.
// This is a management estimate, never an appraisal.
import { type Ratio, ratio } from './core.ts';

export interface ValuationBase {
  /** True pretax profit (after owner pay at market wage) summed over `monthsUsed` months, most recent first. */
  pretaxCents: number; monthsUsed: number; pretax12Cents: number;
  equityCents: number | null; debtCents: number; ebitda12Cents: number; revenue12Cents: number;
  coreCapitalSurplusCents: number | null; ownerWageApplied: boolean; asOf: string;
}
export type ElementKey = 'customers' | 'employees' | 'processes' | 'core_capital' | 'intellectual_property';
export const VALUE_ELEMENTS: [ElementKey, string, string][] = [
  ['customers', 'Customers', 'How loyal customers are to the business rather than to one person in it.'],
  ['employees', 'Employees', 'Whether the team and culture would stay and perform after the owner leaves. Labor efficiency is the main evidence.'],
  ['processes', 'Processes and know-how', 'Documented ways of doing the work faster, better or cheaper that are not protected by a patent, copyright or trademark.'],
  ['core_capital', 'Core capital', 'Cash, receivables, inventory and equipment net of what is owed. A business stripped of capital needs new money straight after a sale.'],
  ['intellectual_property', 'Intellectual property', 'Anything patented, copyrighted or trademarked. Development cost carried as an asset is worth nothing unless someone outside would pay for it.'],
];
export interface ValuationInput {
  /** Advisor's adjustment to book equity for assets or liabilities that are materially over- or under-stated. Signed. */
  equityAdjustmentCents: number; equityAdjustmentNote: string;
  stakePct: number; taxRate: number; ebitdaMultiple: number; revenueMultiple: number;
  /** Discounts applied in sequence when the interest is under half the business: lack of marketability, then lack of control. */
  marketabilityDiscount: number; controlDiscount: number;
  /** Terms of the note a buyer would pay the price over. */
  noteRate: number; noteYears: number;
  elements: Partial<Record<ElementKey, { rating: 'strong' | 'adequate' | 'weak' | null; note: string }>>;
}
export const defaultValuation = (taxRate: number): ValuationInput => ({ equityAdjustmentCents: 0, equityAdjustmentNote: '', stakePct: 0.5, taxRate, ebitdaMultiple: 5, revenueMultiple: 1, marketabilityDiscount: 0.2, controlDiscount: 0.2, noteRate: 0.07, noteYears: 5, elements: {} });

export interface ValuationResult {
  available: boolean; reason?: string;
  method: 'blended' | 'net_assets';
  threeYearPretaxCents: number; estimated: boolean; avgAnnualPretaxCents: number;
  adjustedEquityCents: number; valueCents: number;
  /** Value after the marketability and control discounts: what a minority owner who leaves early is paid on. */
  marketabilityDiscountCents: number; controlDiscountCents: number; discountedValueCents: number;
  /** Which value the interest is priced on: half or more uses the undiscounted value, less than half the discounted value. */
  stakeBasis: 'undiscounted' | 'discounted'; stakePriceCents: number; stakeIfWholeBusinessSoldCents: number;
  afterTaxAnnualCents: number;
  /** Paying the price over a note from the business's after-tax profit. Variance = excess ÷ available; within ±10% is a balanced deal. */
  note: { annualPaymentCents: number; totalPaymentsCents: number; availableCents: number; excessCents: number; variance: Ratio; status: 'balanced' | 'shortfall' | 'excess' | null };
  /** Years to pay for the whole business at the note rate using all after-tax profit. */
  yearsToRepayWhole: Ratio;
  impliedEbitdaMultiple: Ratio; impliedRevenueMultiple: Ratio;
  comparisons: { label: string; valueCents: number; caution: string }[];
  flags: { severity: 'info' | 'warn'; text: string }[];
}
const $ = (c: number) => `${c < 0 ? '-' : ''}$${Math.round(Math.abs(c) / 100).toLocaleString('en-US')}`;

/** Level annual payment on a note (ordinary annuity). */
export function annualPayment(principalCents: number, rate: number, years: number): number {
  if (years <= 0) return principalCents; return Math.round(rate === 0 ? principalCents / years : (principalCents * rate) / (1 - Math.pow(1 + rate, -years)));
}
/** Years to repay a principal at `rate` with a level annual payment. Not available when the payment does not cover the interest. */
export function yearsToRepay(principalCents: number, rate: number, paymentCents: number): Ratio {
  if (principalCents <= 0) return { value: null, reason: 'Not available: the formula value is zero or negative.' };
  if (paymentCents <= 0 || paymentCents <= principalCents * rate) return { value: null, reason: 'Not available: after-tax profit would not cover the interest, so the price could never be repaid from the business.' };
  return { value: rate === 0 ? principalCents / paymentCents : -Math.log(1 - (principalCents * rate) / paymentCents) / Math.log(1 + rate) };
}

export function valuation(b: ValuationBase, i: ValuationInput): ValuationResult {
  const none = (reason: string): ValuationResult => ({ available: false, reason, method: 'blended', threeYearPretaxCents: 0, estimated: false, avgAnnualPretaxCents: 0, adjustedEquityCents: 0, valueCents: 0, marketabilityDiscountCents: 0, controlDiscountCents: 0, discountedValueCents: 0, stakeBasis: 'undiscounted', stakePriceCents: 0, stakeIfWholeBusinessSoldCents: 0, afterTaxAnnualCents: 0, note: { annualPaymentCents: 0, totalPaymentsCents: 0, availableCents: 0, excessCents: 0, variance: { value: null, reason }, status: null }, yearsToRepayWhole: { value: null, reason }, impliedEbitdaMultiple: { value: null, reason }, impliedRevenueMultiple: { value: null, reason }, comparisons: [], flags: [] });
  if (b.equityCents === null) return none('Not available: a balance sheet is needed for equity.');
  if (b.monthsUsed < 12) return none('Not available: at least twelve months of profit history are needed.');
  const estimated = b.monthsUsed < 36; const three = estimated ? Math.round((b.pretaxCents / b.monthsUsed) * 36) : b.pretaxCents; const avg = Math.round(three / 3);
  const equity = b.equityCents + i.equityAdjustmentCents; const flags: ValuationResult['flags'] = [];
  // No stream of profit: the buyer pays for the net assets only (book or liquidation value).
  const method = three > 0 ? 'blended' : 'net_assets'; const value = method === 'blended' ? three + equity : equity;
  const mAmt = Math.round(Math.max(0, value) * i.marketabilityDiscount); const cAmt = Math.round((Math.max(0, value) - mAmt) * i.controlDiscount); const discounted = value - mAmt - cAmt;
  const basis = i.stakePct < 0.5 ? 'discounted' : 'undiscounted'; const stake = Math.round((basis === 'discounted' ? discounted : value) * i.stakePct); const afterTax = Math.round(avg * (1 - i.taxRate));
  const pmt = stake > 0 ? annualPayment(stake, i.noteRate, i.noteYears) : 0; const excess = afterTax - pmt;
  const variance: Ratio = stake <= 0 ? { value: null, reason: 'Not available: the formula value is zero or negative.' } : afterTax <= 0 ? { value: null, reason: 'Not available: there is no after-tax profit to make payments from.' } : ratio(excess, afterTax);
  const status = variance.value === null ? null : variance.value < -0.1 - 1e-9 ? 'shortfall' : variance.value > 0.1 + 1e-9 ? 'excess' : 'balanced';
  const yearsWhole = yearsToRepay(value, i.noteRate, afterTax);
  if (estimated) flags.push({ severity: 'warn', text: `Only ${b.monthsUsed} months of history are imported, so three years of profit is estimated from the monthly average. Import three full years before relying on this.` });
  if (method === 'net_assets') flags.push({ severity: 'warn', text: `The business has not produced pretax profit over the period, so profit adds nothing to value. What is left is net assets of ${$(equity)}${equity < 0 ? ' — negative, meaning an owner would be paying someone to take the business over' : ''}. Selling as a going concern usually returns more than liquidating.` });
  if (!b.ownerWageApplied) flags.push({ severity: 'warn', text: 'No owner market-wage adjustment is applied to these months. If the owner is paid under or over market, profit and this value are distorted. Complete the owner wage plan first.' });
  if (b.coreCapitalSurplusCents !== null && b.coreCapitalSurplusCents < 0) flags.push({ severity: 'warn', text: `Core capital is ${$(-b.coreCapitalSurplusCents)} short of its target. The method assumes a fully capitalized business; a buyer would need to put that money in, and a seller who strips cash and receivables before closing leaves a damaged business.` });
  if (b.debtCents > 0) flags.push({ severity: 'info', text: `Debt of ${$(b.debtCents)} is already reflected through lower equity. Interest on it drags on profit, and a half-interest sale works best when the business is debt free.` });
  if (i.equityAdjustmentCents !== 0 && !i.equityAdjustmentNote.trim()) flags.push({ severity: 'warn', text: 'Equity has been adjusted without a reason recorded. State which asset or liability is over- or under-valued.' });
  const pct = `${(i.stakePct * 100).toFixed(0)}%`;
  if (basis === 'discounted' && value > 0) flags.push({ severity: 'info', text: `A ${pct} interest is under half the business, so it is priced on the discounted value: ${$(stake)} if this owner sells back early, against ${$(Math.round(value * i.stakePct))} as their share if the whole business is sold. Never promise a minority owner a price that only a sale of the whole business could pay.` });
  if (status === 'shortfall') flags.push({ severity: 'warn', text: `Paying ${$(stake)} over ${i.noteYears} years at ${(i.noteRate * 100).toFixed(1)}% takes ${$(pmt)} a year, ${$(-excess)} more than the ${$(afterTax)} of after-tax profit available (${(variance.value! * 100).toFixed(1)}%). A gap beyond 10% has to come from new capital, debt or growth. At this price a partner offered a buy-sell would rather be the seller.` });
  else if (status === 'balanced') flags.push({ severity: 'info', text: `Paying ${$(stake)} over ${i.noteYears} years at ${(i.noteRate * 100).toFixed(1)}% takes ${$(pmt)} a year against ${$(afterTax)} of after-tax profit available: ${excess >= 0 ? `${$(excess)} to spare` : `${$(-excess)} short`} (${(variance.value! * 100).toFixed(1)}%), inside the ±10% that marks a balanced deal. The buyer takes no profit distributions until the note is paid.` });
  else if (status === 'excess') flags.push({ severity: 'info', text: `Paying ${$(stake)} over ${i.noteYears} years at ${(i.noteRate * 100).toFixed(1)}% takes ${$(pmt)} a year, leaving ${$(excess)} of after-tax profit unused (${(variance.value! * 100).toFixed(1)}%). At this price a partner offered a buy-sell would want to be the buyer.` });
  if (yearsWhole.value !== null && yearsWhole.value > 10) flags.push({ severity: 'info', text: `Buying the whole business at ${$(value)} with all after-tax profit would take about ${yearsWhole.value.toFixed(1)} years at ${(i.noteRate * 100).toFixed(1)}% interest, longer than the ten years or so a buyer of a whole business is usually willing to wait. A buyer paying this needs a reason beyond the cash the business produces.` });
  const comparisons = [
    { label: `${i.ebitdaMultiple}× EBITDA`, valueCents: Math.round(b.ebitda12Cents * i.ebitdaMultiple), caution: 'Ignores how well the business is capitalized, and is distorted when owner pay is not at market.' },
    { label: `${i.revenueMultiple}× revenue`, valueCents: Math.round(b.revenue12Cents * i.revenueMultiple), caution: 'The weakest measure: it assumes every dollar of sales earns the same margin.' },
    { label: 'Net assets (book value)', valueCents: equity, caution: 'What a buyer pays when there is no profit stream. Liquidating usually yields less.' },
  ];
  return { available: true, method, threeYearPretaxCents: three, estimated, avgAnnualPretaxCents: avg, adjustedEquityCents: equity, valueCents: value, marketabilityDiscountCents: mAmt, controlDiscountCents: cAmt, discountedValueCents: discounted, stakeBasis: basis, stakePriceCents: stake, stakeIfWholeBusinessSoldCents: Math.round(value * i.stakePct), afterTaxAnnualCents: afterTax, note: { annualPaymentCents: pmt, totalPaymentsCents: pmt * i.noteYears, availableCents: afterTax, excessCents: excess, variance, status }, yearsToRepayWhole: yearsWhole, impliedEbitdaMultiple: value > 0 ? ratio(value, b.ebitda12Cents) : { value: null, reason: 'Not available.' }, impliedRevenueMultiple: value > 0 ? ratio(value, b.revenue12Cents) : { value: null, reason: 'Not available.' }, comparisons, flags };
}

// ---------- Value and distributions at different profit levels (the book's Company A / Company B comparison) ----------
export interface ProfitLevelsInput {
  startEquityCents: number; revenueCents: number[]; levels: number[]; taxRate: number; coreCapitalMonths: number;
  /** Profit distributions begin in this year; before it, profit stays in to build core capital. */
  firstProfitDistributionYear: number; marketabilityDiscount: number; controlDiscount: number;
}
export interface ProfitLevelYear { year: number; revenueCents: number; pretaxCents: number; taxDistributionCents: number; profitDistributionCents: number; totalDistributionsCents: number; equityCents: number; coreCapitalTargetCents: number; returnOnInvestment: Ratio; valueCents: number; discountedValueCents: number }
export interface ProfitLevelResult { level: number; years: ProfitLevelYear[]; totalProfitDistributionsCents: number; totalTaxDistributionsCents: number; endingValueCents: number; yearCoreCapitalReached: number | null }
/**
 * Rules, as in the book's illustration: tax distributions are the tax rate times the previous year's pretax profit; profit distributions
 * are whatever equity stood above the core capital target at the end of the previous year; the core capital target is N months of
 * total costs (revenue less pretax profit); value each year is three times the average of up to the last three years' profit, plus equity.
 * Owners are assumed to draw a market wage throughout, so profit here is true profit.
 */
export function profitLevels(i: ProfitLevelsInput): ProfitLevelResult[] {
  return i.levels.map((level) => {
    const years: ProfitLevelYear[] = []; let equity = i.startEquityCents; let prevPretax = 0, prevTarget = 0, prevEquity = 0; const hist: number[] = []; let reached: number | null = null;
    i.revenueCents.forEach((rev, k) => {
      const year = k + 1; const pretax = Math.round(rev * level); const tax = k === 0 ? 0 : Math.max(0, Math.round(prevPretax * i.taxRate));
      const profitDist = k === 0 || year < i.firstProfitDistributionYear ? 0 : Math.max(0, prevEquity - prevTarget);
      equity = equity + pretax - tax - profitDist; const target = Math.round(((rev - pretax) * i.coreCapitalMonths) / 12); hist.push(pretax);
      const last = hist.slice(-3); const value = Math.round((last.reduce((a, b) => a + b, 0) / last.length) * 3) + equity; const m = Math.round(Math.max(0, value) * i.marketabilityDiscount); const c = Math.round((Math.max(0, value) - m) * i.controlDiscount);
      if (reached === null && equity >= target) reached = year;
      years.push({ year, revenueCents: rev, pretaxCents: pretax, taxDistributionCents: tax, profitDistributionCents: profitDist, totalDistributionsCents: tax + profitDist, equityCents: equity, coreCapitalTargetCents: target, returnOnInvestment: equity > 0 ? ratio(pretax, equity) : { value: null, reason: 'Not available: equity is zero or negative.' }, valueCents: value, discountedValueCents: value - m - c });
      prevPretax = pretax; prevTarget = target; prevEquity = equity;
    });
    return { level, years, totalProfitDistributionsCents: years.reduce((a, y) => a + y.profitDistributionCents, 0), totalTaxDistributionsCents: years.reduce((a, y) => a + y.taxDistributionCents, 0), endingValueCents: years.length ? years[years.length - 1].valueCents : 0, yearCoreCapitalReached: reached };
  });
}
