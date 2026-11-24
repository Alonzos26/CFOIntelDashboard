// Capital concepts from Greg Crabtree, "Simple Numbers, Straight Talk, Big Profits!", ch. 7:
// capital is equity (what you own less what you owe) — debt is not capital; return on investment = pretax profit ÷ equity;
// sweat equity is a source of capital; an employee can buy in with an after-tax bonus at a formula value.
import { type Ratio, ratio } from './core.ts';

export interface CapitalView { equityCents: number; debtCents: number; locCents: number; sweatEquityCents: number; pretaxCents: number; returnOnEquity: Ratio; debtToEquity: Ratio; notes: string[] }
/** Return on the owners' investment for a 12-month profit figure. Debt is shown beside capital, never inside it. */
export function capitalView(i: { equityCents: number; locCents: number; notesCents: number; sweatEquityCents: number; pretax12Cents: number; complete: boolean }): CapitalView {
  const debt = i.locCents + i.notesCents; const notes: string[] = [];
  const roe: Ratio = !i.complete ? { value: null, reason: 'Not available: needs a full 12 months of profit.' } : i.equityCents <= 0 ? { value: null, reason: 'Not available: equity is zero or negative, so a return on it cannot be stated.' } : ratio(i.pretax12Cents, i.equityCents);
  if (i.equityCents > 0 && debt > i.equityCents) notes.push('The business owes more than the owners have invested. Borrowing can make the return percentage look higher while making the business less able to survive a bad year.');
  if (i.locCents > 0) notes.push('A line of credit balance is outstanding. Debt is not capital: it has to be repaid from profit.');
  return { equityCents: i.equityCents, debtCents: debt, locCents: i.locCents, sweatEquityCents: i.sweatEquityCents, pretaxCents: i.pretax12Cents, returnOnEquity: roe, debtToEquity: i.equityCents > 0 ? ratio(debt, i.equityCents) : { value: null, reason: 'Not available: equity is zero or negative.' }, notes };
}

export interface BuyInInput {
  grossBonusCents: number; bonusTaxRate: number;      // the after-tax bonus is what buys shares
  avgPretaxCents: number; equityCents: number;
  profitMultiple: number;                              // formula value = average pretax profit × multiple + equity
  discountPct: number;                                 // minority / marketability discount offered to the buyer
  sharesOutstanding: number; ownerTaxRate: number;     // tax rate applied to each owner's share of profit
}
export interface BuyInResult {
  businessValueCents: number; pricePerShareCents: number; discountedPriceCents: number; netInvestmentCents: number;
  sharesPurchased: number; totalShares: number; buyerOwnership: number;
  buyer: { profitCents: number; taxDistributionCents: number; profitDistributionCents: number; roi: Ratio };
  original: { ownership: number; profitCents: number; taxDistributionCents: number; profitDistributionCents: number; investmentCents: number; roi: Ratio };
  cautions: string[];
}
export const defaultBuyIn = (avgPretaxCents: number, equityCents: number): BuyInInput => ({ grossBonusCents: 5_000_000, bonusTaxRate: 0.4, avgPretaxCents, equityCents, profitMultiple: 3, discountPct: 0.4, sharesOutstanding: 100_000, ownerTaxRate: 0.4 });

export function buyIn(i: BuyInInput): BuyInResult {
  const value = Math.round(i.avgPretaxCents * i.profitMultiple) + i.equityCents;
  const price = i.sharesOutstanding > 0 ? value / i.sharesOutstanding : 0; const discounted = price * (1 - i.discountPct);
  const net = Math.round(i.grossBonusCents * (1 - i.bonusTaxRate)); const shares = discounted > 0 ? net / discounted : 0; const total = i.sharesOutstanding + shares;
  const own = total > 0 ? shares / total : 0; const split = (profit: number) => { const tax = Math.round(profit * i.ownerTaxRate); return { profitCents: profit, taxDistributionCents: tax, profitDistributionCents: profit - tax }; };
  const bp = Math.round(i.avgPretaxCents * own); const op = i.avgPretaxCents - bp;
  const cautions = ['Illustration only. The value formula and the discount are rules of thumb from the book, not an appraisal.', 'An actual sale of ownership needs a qualified valuation, tax advice on the discount, and a shareholder agreement drafted by an attorney.', 'The buy-in should not change the buyer\'s salary: pay is for the work, the return is on the investment.', 'Ownership should change hands for money, through a bonus or cash, not as a gift. If the new owner leaves before the whole business is sold, the buy-back is at the discounted value, paid over time.'];
  if (value <= 0) cautions.unshift('The formula value is zero or negative, so a buy-in price cannot be worked out.');
  return { businessValueCents: value, pricePerShareCents: price, discountedPriceCents: discounted, netInvestmentCents: net, sharesPurchased: shares, totalShares: total, buyerOwnership: own,
    buyer: { ...split(bp), roi: ratio(bp, net, 'no investment was entered') }, original: { ownership: 1 - own, ...split(op), investmentCents: i.equityCents, roi: i.equityCents > 0 ? ratio(op, i.equityCents) : { value: null, reason: 'Not available: equity is zero or negative.' } }, cautions };
}
