// Cash Flow Waterfall (concept from Greg Crabtree, "Simple Numbers, Straight Talk, Big Profits!", ch. 4–5):
// cash is committed in a fixed order — 1. taxes, 2. debt, 3. operating reserve target, 4. profit distributions —
// and distributions come only from what is left. Also the "where did the cash go?" walk from beginning cash to ending cash.
import { type MonthData, cashFlowMonth } from './core.ts';

export interface FourForcesInput {
  cashCents: number; locCents: number;
  pretaxYtdCents: number; taxRate: number; taxesPaidYtdCents: number;
  projectedTaxCents?: number | null; // full-year projection from tax planning; when present it replaces rate × profit
  scheduledDebtCents: number;        // term-debt payments falling due in the planning window
  coreCapitalTargetCents: number;    // target cash with nothing drawn on the line of credit
  avgMonthlyPretaxCents: number;     // recent average, used to estimate how long retained profit takes to fund a shortfall
  distributionsYtdCents: number | null;
}
export interface ForceStep { force: 1 | 2 | 3 | 4; key: string; label: string; needCents: number; fundedCents: number; shortCents: number; remainingCents: number; note: string }
export interface FourForces {
  cashCents: number; steps: ForceStep[]; taxReserveNeededCents: number;
  availableForDistributionCents: number; shortfallCents: number; monthsOfProfitToFund: number | null;
  flags: { severity: 'warn' | 'good'; text: string }[];
}
const $ = (c: number) => `$${Math.round(c / 100).toLocaleString('en-US')}`;

export function fourForces(i: FourForcesInput): FourForces {
  const projected = i.projectedTaxCents ?? null;
  const taxNeed = Math.max(0, (projected !== null ? projected : Math.round(Math.max(0, i.pretaxYtdCents) * i.taxRate)) - i.taxesPaidYtdCents);
  const needs: Omit<ForceStep, 'fundedCents' | 'shortCents' | 'remainingCents'>[] = [
    { force: 1, key: 'taxes', label: 'Taxes set aside', needCents: taxNeed, note: projected !== null
      ? `Projected tax for the year from tax planning of ${$(projected)}, less ${$(i.taxesPaidYtdCents)} already paid or distributed for tax. The full projection is reserved, not just the share earned so far.`
      : `${Math.round(i.taxRate * 100)}% of year-to-date pretax profit of ${$(i.pretaxYtdCents)}, less ${$(i.taxesPaidYtdCents)} already paid or distributed for tax.` },
    { force: 2, key: 'loc', label: 'Pay the line of credit to zero', needCents: Math.max(0, i.locCents), note: 'Operating reserve means cash in the bank with nothing drawn on the line.' },
    { force: 2, key: 'debt', label: 'Scheduled loan payments', needCents: Math.max(0, i.scheduledDebtCents), note: 'Term-debt payments due in the next 13 weeks, from the cash plan.' },
    { force: 3, key: 'core', label: 'Operating reserve target', needCents: Math.max(0, i.coreCapitalTargetCents), note: 'The cash cushion that stays in the business.' },
  ];
  let remaining = i.cashCents; let short = 0;
  const steps: ForceStep[] = needs.map((n) => { const funded = Math.min(Math.max(remaining, 0), n.needCents); remaining -= n.needCents; short += n.needCents - funded; return { ...n, fundedCents: funded, shortCents: n.needCents - funded, remainingCents: remaining }; });
  const available = Math.max(0, remaining);
  steps.push({ force: 4, key: 'distributions', label: 'Available for profit distributions', needCents: 0, fundedCents: available, shortCents: 0, remainingCents: remaining, note: 'What is left after the first three steps. Zero until they are funded.' });
  const retained = i.avgMonthlyPretaxCents * (1 - i.taxRate);
  const flags: FourForces['flags'] = [];
  if (steps[0].shortCents > 0) flags.push({ severity: 'warn', text: `Cash on hand does not cover the tax set-aside: ${$(steps[0].shortCents)} short. Taxes are the first claim on cash.` });
  if (i.locCents > 0) flags.push({ severity: 'warn', text: `${$(i.locCents)} is drawn on the line of credit. The operating reserve target is not met until the line is at zero.` });
  if (short > 0 && i.distributionsYtdCents !== null && i.distributionsYtdCents > 0) flags.push({ severity: 'warn', text: `${$(i.distributionsYtdCents)} of distributions have been taken this year while taxes, debt and operating reserve are ${$(short)} short of being funded. Beyond what is needed for the owners' taxes, distributions come last.` });
  if (short === 0) flags.push({ severity: 'good', text: `Taxes, debt and operating reserve are funded. ${$(available)} is available for profit distributions.` });
  return { cashCents: i.cashCents, steps, taxReserveNeededCents: taxNeed, availableForDistributionCents: available, shortfallCents: short, monthsOfProfitToFund: short > 0 && retained > 0 ? short / retained : null, flags };
}

export interface CashWalk { from: string; to: string; beginningCashCents: number; pretaxCents: number; timingCents: number; assetPurchasesCents: number; debtCents: number; distributionsCents: number; endingCashCents: number; reportedEndingCashCents: number; differenceCents: number }
/** "Where did the cash go?" — beginning cash plus profit, less what was spent, repaid or taken out. Needs a balance sheet for the month before `fromIdx`. */
export function cashWalk(months: MonthData[], fromIdx: number, toIdx: number): CashWalk | null {
  if (fromIdx < 1 || toIdx >= months.length || fromIdx > toIdx) return null;
  for (let i = fromIdx - 1; i <= toIdx; i++) if (!months[i].bs) return null;
  const w: CashWalk = { from: months[fromIdx].period, to: months[toIdx].period, beginningCashCents: months[fromIdx - 1].bs!.cash, pretaxCents: 0, timingCents: 0, assetPurchasesCents: 0, debtCents: 0, distributionsCents: 0, endingCashCents: 0, reportedEndingCashCents: months[toIdx].bs!.cash, differenceCents: 0 };
  for (let i = fromIdx; i <= toIdx; i++) {
    const cf = cashFlowMonth(months[i - 1].bs!, months[i].bs!, months[i].pnl);
    w.pretaxCents += cf.netIncome; w.timingCents += cf.operations - cf.netIncome; w.assetPurchasesCents += cf.investing; w.debtCents += cf.loc + cf.notes; w.distributionsCents += cf.equityOther; w.differenceCents += cf.difference;
  }
  w.endingCashCents = w.beginningCashCents + w.pretaxCents + w.timingCents + w.assetPurchasesCents + w.debtCents + w.distributionsCents;
  return w;
}

/** Typical federal estimated-tax due dates for individuals (Apr 15, Jun 15, Sep 15, Jan 15). A reminder only — confirm dates and amounts with the tax preparer. */
export function nextEstimatedTaxDate(today: string): string {
  const y = Number(today.slice(0, 4));
  return [`${y}-01-15`, `${y}-04-15`, `${y}-06-15`, `${y}-09-15`, `${y + 1}-01-15`].find((d) => d >= today)!;
}
