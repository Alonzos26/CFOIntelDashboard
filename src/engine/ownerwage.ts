// Owner / shareholder market-based wage plan.
// Source: "What is Reasonable Compensation? A Primer for S-Corp Owners" (RCReports, 2023): reasonable compensation is the value
// ordinarily paid for like services by like enterprises under like circumstances (Treas. Reg. §1.162-7(b)(3)); three approaches
// (cost, market, income); wages before distributions; re-run every year; document the data; use unbiased data sources.
// This is a PLANNING calculation that feeds the owner-pay adjustment. It is not a reasonable-compensation determination or tax advice.

export type WageApproach = 'cost' | 'market' | 'income';
export interface OwnerRole { title: string; hoursPerYear: number; hourlyWageCents: number; source: string; sourceDate: string | null }
export interface OwnerWageInput {
  name: string; ownershipPct: number; approach: WageApproach;
  roles: OwnerRole[];                                                                        // cost approach: the "many hats" the owner wears
  marketTitle: string; marketAnnualCents: number; marketSource: string; marketSourceDate: string | null; // market approach: one comparable position
  incomeAnnualCents: number; incomeBasis: string;                                            // income approach: figure and basis supplied by the advisor
  actualW2AnnualCents: number; plannedDistributionsAnnualCents: number;
}
export interface WagePlanInput { year: number; isSCorp: boolean; analysisDate: string; owners: OwnerWageInput[] }

export interface OwnerWageResult {
  name: string; approach: WageApproach; reasonableAnnualCents: number; reasonableMonthlyCents: number;
  totalHours: number | null; blendedHourlyCents: number | null;
  actualW2AnnualCents: number; gapAnnualCents: number; gapMonthlyCents: number; plannedDistributionsAnnualCents: number;
  wagePctOfTotalPay: number | null; documented: boolean; warnings: string[];
  /** With several owners: this owner's underpay minus their ownership share of all owners' underpay. Positive = contributed more sweat equity than their ownership share. */
  sweatDifferentialCents: number | null;
}
export interface WagePlanResult {
  owners: OwnerWageResult[]; totalReasonableAnnualCents: number; totalActualAnnualCents: number; totalGapAnnualCents: number;
  monthlyAdjustmentCents: number; flags: { severity: 'warn' | 'info'; text: string }[]; affordability: string | null; documentationComplete: boolean;
}
export interface WageContext { today: string; r12HeadroomCents: number | null; r12OwnerAdjCents: number | null; pretaxTargetPct: number }

export const blankOwner = (): OwnerWageInput => ({ name: '', ownershipPct: 1, approach: 'cost', roles: [{ title: '', hoursPerYear: 0, hourlyWageCents: 0, source: '', sourceDate: null }], marketTitle: '', marketAnnualCents: 0, marketSource: '', marketSourceDate: null, incomeAnnualCents: 0, incomeBasis: '', actualW2AnnualCents: 0, plannedDistributionsAnnualCents: 0 });

const BIASED = /glassdoor|payscale|indeed|ziprecruiter|salary\.com/i;
const $ = (c: number) => `$${Math.round(c / 100).toLocaleString('en-US')}`;

export function evaluateWagePlan(input: WagePlanInput, ctx: WageContext): WagePlanResult {
  const flags: WagePlanResult['flags'] = [];
  const owners = input.owners.map((o): OwnerWageResult => {
    const w: string[] = []; let reasonable = 0; let hours: number | null = null; let documented = true;
    if (o.approach === 'cost') {
      const roles = o.roles.filter((r) => r.hoursPerYear > 0 || r.hourlyWageCents > 0);
      hours = roles.reduce((a, r) => a + r.hoursPerYear, 0);
      reasonable = Math.round(roles.reduce((a, r) => a + r.hoursPerYear * r.hourlyWageCents, 0));
      if (!roles.length) { w.push('No roles entered. List each role the owner performs, the hours spent on it, and a market hourly wage for that role.'); documented = false; }
      for (const r of roles) {
        if (!r.title.trim()) w.push('A role has no title.');
        if (!r.source.trim() || !r.sourceDate) { w.push(`"${r.title || 'Untitled role'}": record the wage data source and its date.`); documented = false; }
        else if (BIASED.test(r.source)) w.push(`"${r.title}": the guide notes that sites such as Glassdoor and Payscale are often considered biased. Prefer sources built on Bureau of Labor Statistics or Census data.`);
      }
      if (hours > 3500) w.push(`${hours.toLocaleString('en-US')} hours a year is more than one person can plausibly work. Check the hours by role.`);
      else if (hours > 0 && hours < 500) w.push(`Only ${hours} hours a year are allocated. Confirm this owner works part-time in the business.`);
    } else if (o.approach === 'market') {
      reasonable = o.marketAnnualCents;
      if (!o.marketTitle.trim()) w.push('Name the comparable position.');
      if (!o.marketSource.trim() || !o.marketSourceDate) { w.push('Record the wage data source and its date for the comparable position.'); documented = false; }
      else if (BIASED.test(o.marketSource)) w.push('The guide notes that sites such as Glassdoor and Payscale are often considered biased. Prefer sources built on Bureau of Labor Statistics or Census data.');
    } else {
      reasonable = o.incomeAnnualCents;
      if (!o.incomeBasis.trim()) { w.push('Record how the income-approach figure was determined.'); documented = false; }
    }
    if (reasonable <= 0) w.push('No market wage has been determined yet.');
    const gap = reasonable - o.actualW2AnnualCents;
    if (input.isSCorp && o.plannedDistributionsAnnualCents > 0 && gap > 0)
      w.push(`Distributions of ${$(o.plannedDistributionsAnnualCents)} are planned while W-2 wages are ${$(gap)} below the market wage. For S-corporation shareholder-employees, reasonable wages are to be paid before distributions.`);
    if (o.actualW2AnnualCents === 0 && o.plannedDistributionsAnnualCents > 0) w.push('No W-2 wages are recorded but distributions are planned.');
    const totalPay = o.actualW2AnnualCents + o.plannedDistributionsAnnualCents;
    return {
      name: o.name, approach: o.approach, reasonableAnnualCents: reasonable, reasonableMonthlyCents: Math.round(reasonable / 12), totalHours: hours,
      blendedHourlyCents: hours && hours > 0 ? Math.round(reasonable / hours) : null, actualW2AnnualCents: o.actualW2AnnualCents, gapAnnualCents: gap, gapMonthlyCents: Math.round(gap / 12),
      plannedDistributionsAnnualCents: o.plannedDistributionsAnnualCents, wagePctOfTotalPay: totalPay > 0 ? o.actualW2AnnualCents / totalPay : null, documented, warnings: w, sweatDifferentialCents: null,
    };
  });
  const totalReasonable = owners.reduce((a, o) => a + o.reasonableAnnualCents, 0), totalActual = owners.reduce((a, o) => a + o.actualW2AnnualCents, 0), totalGap = totalReasonable - totalActual;
  if (owners.length > 1) {
    const ownTotal = input.owners.reduce((a, o) => a + o.ownershipPct, 0);
    if (Math.abs(ownTotal - 1) > 0.005) flags.push({ severity: 'warn', text: `Ownership adds up to ${(ownTotal * 100).toFixed(1)}%, not 100%, so the sweat equity difference between owners cannot be worked out.` });
    else {
      owners.forEach((o, k) => { o.sweatDifferentialCents = o.gapAnnualCents - Math.round(totalGap * input.owners[k].ownershipPct); });
      const uneven = owners.filter((o) => Math.abs(o.sweatDifferentialCents ?? 0) > 100);
      if (uneven.length) flags.push({ severity: 'warn', text: `The owners are not giving up pay in proportion to what they own: ${uneven.map((o) => `${o.name} ${(o.sweatDifferentialCents ?? 0) > 0 ? 'has put in' : 'has received'} ${$(Math.abs(o.sweatDifferentialCents ?? 0))} ${(o.sweatDifferentialCents ?? 0) > 0 ? 'more' : 'more in pay'} than their ownership share this year`).join('; ')}. Settle the difference at least once a year under a written agreement rather than letting it build.` });
    }
  }
  const ageDays = Math.round((Date.parse(ctx.today) - Date.parse(input.analysisDate)) / 86_400_000);
  if (Number.isFinite(ageDays) && ageDays > 365) flags.push({ severity: 'warn', text: `This analysis is dated ${input.analysisDate}, more than a year ago. The guide recommends re-running it every year because market wages change.` });
  if (input.year < Number(ctx.today.slice(0, 4))) flags.push({ severity: 'info', text: `This plan is for ${input.year}. Create a plan for the current year when its analysis is done.` });
  if (!owners.length) flags.push({ severity: 'warn', text: 'No shareholder-employees have been entered.' });
  if (!input.isSCorp) flags.push({ severity: 'info', text: 'Not marked as an S-corporation: the wages-before-distributions check is off. The market wage still drives true profit, the salary cap and sweat equity.' });
  const documentationComplete = owners.length > 0 && owners.every((o) => o.documented);
  if (owners.length && !documentationComplete) flags.push({ severity: 'warn', text: 'Documentation is incomplete. Keep the data source and date behind every wage figure with the plan.' });
  // Affordability: true profit and the salary cap already count the market wage (via the owner-pay adjustment),
  // so paying it for real does not change them. What matters is whether labor is under the cap once the plan's gap replaces the current adjustment.
  let affordability: string | null = null;
  if (ctx.r12HeadroomCents !== null && ctx.r12OwnerAdjCents !== null) {
    const headroom = ctx.r12HeadroomCents + ctx.r12OwnerAdjCents - totalGap; const pct = `${Math.round(ctx.pretaxTargetPct * 100)}%`;
    const room = totalReasonable + headroom; // owner wages the cap can carry once all other labor is paid
    affordability = headroom >= 0
      ? `With owners at the full market wage of ${$(totalReasonable)}, rolling-12 labor is ${$(headroom)} under the salary cap: the business supports the market wage and still earns its ${pct} profit target.`
      : room > 0
        ? `With owners at the full market wage of ${$(totalReasonable)}, rolling-12 labor is ${$(-headroom)} over the salary cap. At today's revenue and other costs the cap leaves room for about ${$(room)} of owner wages while still earning the ${pct} profit target.`
        : `With owners at the full market wage of ${$(totalReasonable)}, rolling-12 labor is ${$(-headroom)} over the salary cap. Labor other than the owners already uses the whole cap, so the ${pct} profit target has to come from more gross profit or better labor yield, not from holding owner pay down.`;
  }
  return { owners, totalReasonableAnnualCents: totalReasonable, totalActualAnnualCents: totalActual, totalGapAnnualCents: totalGap, monthlyAdjustmentCents: Math.round(totalGap / 12), flags, affordability, documentationComplete };
}
