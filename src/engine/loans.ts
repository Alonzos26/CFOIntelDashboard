// SBA loan readiness: debt service coverage (DSCR), program fit, equity injection, collateral and a readiness score.
// Pure functions only. Money is INTEGER CENTS; rates are fractions (0.10 = 10%). Runs on the server and in the browser.
//
// Rule values below follow SBA SOP 50 10 8 (effective June 1, 2025), SOP 50 10 8.1 with Appendix 15 on changes of
// ownership (loan numbers issued on or after October 1, 2026), and Procedural Notice 5000-876626 (100% U.S. citizen or
// national ownership, effective March 1, 2026; extended to Microloans April 1, 2026). Update LOAN_RULES when SBA changes them.
// This is a planning and pre-qualification tool: the SBA lender or CDC makes the credit decision.
import { computePnl, periodLabel, type MonthData, type Settings, sumPnl } from './core.ts';

export const LOAN_ENGINE_VERSION = '1.0.0';

export const LOAN_RULES = {
  asOf: 'November 2026',
  sources: [
    'SBA SOP 50 10 8 (effective June 1, 2025)',
    'SBA SOP 50 10 8.1 including Appendix 15, change of ownership (loan numbers issued on or after October 1, 2026)',
    'SBA Procedural Notice 5000-876626: 100% U.S. citizen or national ownership (effective March 1, 2026)',
  ],
  /** WSJ Prime used for the 7(a) maximum-rate ceilings. Update monthly. */
  primeRate: 0.07,
  smallLoanMaxCents: 35_000_000,
  dscr: {
    small: 1.15,       // 7(a) Small (≤ $350K): lender's own prudent underwriting; 1.15 used as the planning floor
    standard: 1.15,    // Standard 7(a) over $350K: EBITDA ÷ P&I on all business debt including the new loan
    acquisition: 1.25, // Change of ownership, initial acquisition (App. 15): historical earnings only
    buyout: 1.25,      // Change of ownership, owner buyout / ESOP (App. 15): historical earnings only
    expansion: 1.15,   // Change of ownership, business expansion (App. 15): historical earnings only
    cdc504: 1.15,      // 504: CDC and bank credit policy; planning floor
    micro: 1.20,       // Microloan: intermediary policy; planning floor
    comfort: 1.25,     // the coverage many lenders prefer, shown as a secondary marker
  },
  globalDscrTarget: 1.15,
  /** Not an SBA rule: a common lender floor, used only to raise a planning flag. */
  typicalCreditScore: 680,
  /** 7(a) maximum variable rate: Prime + spread by loan size (loan size ceiling in cents, spread). */
  variableSpread: [[5_000_000, 0.065], [25_000_000, 0.06], [35_000_000, 0.045], [Infinity, 0.03]] as [number, number][],
  /** 7(a) maximum fixed rate: Prime + spread by loan size. */
  fixedSpread: [[2_500_000, 0.08], [5_000_000, 0.07], [25_000_000, 0.06], [Infinity, 0.05]] as [number, number][],
  maxGuarantyCents: 375_000_000,
  cdc504DebentureMaxCents: 550_000_000,
} as const;

export const LOAN_PURPOSES = ['working', 'equipment', 'realestate', 'refi', 'expansion', 'acquisition', 'buyout', 'startup'] as const;
export type LoanPurpose = (typeof LOAN_PURPOSES)[number];
export const PURPOSE_LABELS: Record<LoanPurpose, string> = {
  working: 'Working capital / inventory', equipment: 'Equipment, machinery, vehicles', realestate: 'Buy, build or renovate real estate',
  refi: 'Refinance existing business debt', expansion: 'Acquire a business (expansion of this company)', acquisition: 'Buy a business (initial acquisition)',
  buyout: 'Partner / owner buyout', startup: 'Start a business',
};
const COO: LoanPurpose[] = ['acquisition', 'buyout', 'expansion'];
export const isChangeOfOwnership = (p: LoanPurpose) => COO.includes(p);

export const PROGRAM_KEYS = ['sba7a', 'express', 'cdc504', 'micro'] as const;
export type ProgramKey = (typeof PROGRAM_KEYS)[number];
export interface ProgramDef { name: string; maxCents: number; guaranty: (amountCents: number) => number | null; purposes: LoanPurpose[]; maxTermYears: (p: LoanPurpose) => number; note: string }
export const PROGRAMS: Record<ProgramKey, ProgramDef> = {
  sba7a: { name: 'SBA 7(a)', maxCents: 500_000_000, guaranty: (a) => (a <= 15_000_000 ? 0.85 : 0.75), purposes: [...LOAN_PURPOSES], maxTermYears: (p) => (p === 'realestate' ? 25 : 10),
    note: 'Most flexible: any eligible purpose. Up to 25 years with real estate, 10 years otherwise (longer when equipment life exceeds 10 years).' },
  express: { name: 'SBA Express', maxCents: 50_000_000, guaranty: () => 0.5, purposes: [...LOAN_PURPOSES], maxTermYears: (p) => (p === 'realestate' ? 25 : 10),
    note: 'Faster, lender-delegated decision; lines of credit allowed. The 50% guaranty makes lenders more selective.' },
  cdc504: { name: 'CDC/504', maxCents: Math.round(LOAN_RULES.cdc504DebentureMaxCents / 0.4), guaranty: () => null, purposes: ['realestate', 'equipment', 'refi', 'expansion'], maxTermYears: (p) => (p === 'equipment' ? 10 : 25),
    note: 'Fixed-rate financing of fixed assets: about 50% bank, 40% CDC debenture (SBA portion up to $5.5M), 10%+ borrower. Not for working capital.' },
  micro: { name: 'Microloan', maxCents: 5_000_000, guaranty: () => null, purposes: ['working', 'equipment', 'startup'], maxTermYears: () => 6,
    note: 'Up to $50K through nonprofit intermediaries; 6 years at most. Cannot buy real estate or refinance debt.' },
};

export interface CheckItem { key: string; label: string; detail: string; required?: boolean; purposes?: LoanPurpose[] }
export const ELIGIBILITY: CheckItem[] = [
  { key: 'forprofit', label: 'Operates for profit in the U.S.', detail: 'An operating, for-profit business located in the U.S. or its territories.', required: true },
  { key: 'size', label: 'Meets the SBA size standard for its NAICS code', detail: 'Revenue or employee limits at sba.gov/size-standards; affiliates count.', required: true },
  { key: 'citizen', label: '100% of owners are U.S. citizens or U.S. nationals living in the U.S.', detail: 'Direct and indirect owners and SBA-required guarantors. Green-card holders are no longer eligible (effective March 1, 2026).', required: true },
  { key: 'type', label: 'Not an ineligible business type', detail: 'Not passive real estate investment, lending, speculation, gambling, pyramid sales and similar.', required: true },
  { key: 'fedDebt', label: 'No delinquent federal debt; taxes current', detail: 'No CAIVRS hits, defaulted federal loans or unpaid payroll taxes; any past SBA loss resolved.', required: true },
  { key: 'character', label: 'Owners clear the character review', detail: 'No owner currently incarcerated, on probation or parole, or under indictment.', required: true },
  { key: 'creditElse', label: 'Credit is not available elsewhere on reasonable terms', detail: 'The lender documents why conventional financing without the SBA guaranty is not available (term, collateral, startup, etc.).', required: true },
  { key: 'guarantee', label: 'All 20%+ owners will sign unlimited personal guarantees', detail: 'Spouses who own together count toward 20%. The lender may require others.', required: true },
  { key: 'proceeds', label: 'Use of proceeds is eligible', detail: 'No paying owners for past compensation, no passive investments, no refinancing that only shifts lender risk to SBA.', required: true },
  { key: 'equity', label: 'Owner equity is available and can be verified', detail: 'Usually two months of bank statements showing the cash; gifts need a gift letter.', required: true },
  { key: 'collateral', label: 'Will pledge available collateral', detail: 'Lenders take available business assets, and personal real estate when the loan is not fully secured. SBA does not decline solely for a collateral shortfall.' },
  { key: 'insurance', label: 'Hazard and liability insurance in place', detail: 'Life insurance on key owners may be required when the business depends on them.' },
  { key: 'books', label: 'Books reconciled; financials agree to the tax returns', detail: 'The lender ties the P&L to filed returns. Unexplained differences slow or stop a deal.' },
];
export const LOAN_DOCS: CheckItem[] = [
  { key: 'f1919', label: 'SBA Form 1919, Borrower Information Form', detail: 'The business and each 20%+ owner or guarantor' },
  { key: 'f413', label: 'SBA Form 413, Personal Financial Statement', detail: 'Each 20%+ owner and guarantor' },
  { key: 'btax', label: 'Business federal tax returns, last 3 years', detail: 'All pages and schedules' },
  { key: 'ptax', label: 'Personal federal tax returns, last 3 years', detail: 'Each 20%+ owner' },
  { key: 'f4506', label: 'IRS Form 4506-C, signed', detail: 'The lender verifies returns against IRS transcripts' },
  { key: 'fye', label: 'Year-end P&L and balance sheet, last 3 fiscal years', detail: 'Accountant-prepared preferred' },
  { key: 'interim', label: 'Interim P&L and balance sheet (within 90 days)', detail: 'With the same period a year earlier' },
  { key: 'aging', label: 'A/R and A/P agings', detail: 'Same date as the interim balance sheet' },
  { key: 'debt', label: 'Business debt schedule', detail: 'Lender, balance, payment, rate, maturity, collateral. Feeds the DSCR.' },
  { key: 'proj', label: 'Financial projections with assumptions', detail: 'Monthly for year 1, annual for years 2–3; required for startups and for projected-basis coverage' },
  { key: 'plan', label: 'Business plan', detail: 'Built on the Business Plan tab' },
  { key: 'resume', label: 'Owner and management résumés', detail: 'Industry experience matters, especially for acquisitions and startups' },
  { key: 'entity', label: 'Entity documents', detail: 'Articles, operating agreement or bylaws, EIN letter, licenses, ownership chart' },
  { key: 'cit', label: 'Proof of U.S. citizenship for every owner', detail: 'Passport or birth certificate' },
  { key: 'uses', label: 'Use-of-proceeds detail', detail: 'Quotes, invoices, contractor bids or purchase agreements' },
  { key: 'inject', label: 'Equity injection verification', detail: 'Two months of bank statements, gift letters, seller-note standby agreement' },
  { key: 'coll', label: 'Collateral list', detail: 'Equipment with serial numbers; property addresses' },
  { key: 'lease', label: 'Lease or deed for the business premises', detail: 'The lease term should generally cover the loan term' },
  { key: 'purch', label: 'Purchase agreement or LOI, and seller financials', detail: "Seller's 3 years of tax returns and financials; business valuation", purposes: ['acquisition', 'buyout', 'expansion'] },
  { key: 'qoe', label: 'Quality-of-earnings report (larger acquisitions)', detail: 'Required for larger change-of-ownership deals under SOP 50 10 8.1; confirm the threshold with the lender', purposes: ['acquisition', 'buyout', 'expansion'] },
  { key: 're', label: 'Real estate purchase contract, appraisal, environmental review', detail: 'Phase I or questionnaire under the SOP environmental rules', purposes: ['realestate'] },
  { key: 'refi', label: 'Notes and 12–24 months of statements on debt being refinanced', detail: 'Shows payment history and the benefit of refinancing', purposes: ['refi'] },
  { key: 'franchise', label: 'Franchise agreement and FDD (if a franchise)', detail: 'The brand must be on the SBA Franchise Directory' },
];
export const PLAN_SECTIONS: CheckItem[] = [
  { key: 'exec', label: 'Executive summary', detail: 'What the business does, how long it has operated, how much you are asking for, what it pays for and how the loan is repaid. Write it last.' },
  { key: 'company', label: 'Company description and history', detail: 'Legal entity, ownership percentages, location, years in business, milestones, licenses and bonding.' },
  { key: 'products', label: 'Products and services', detail: 'What you sell, pricing, margins by line, backlog or recurring revenue.' },
  { key: 'market', label: 'Market and competition', detail: 'Target customers, local market size and trend, main competitors and how you win.' },
  { key: 'mgmt', label: 'Management and ownership', detail: "Each owner's role, ownership percentage, experience and citizenship; key employees; succession." },
  { key: 'ops', label: 'Operations', detail: 'Facilities, equipment, suppliers, staffing, systems, capacity.' },
  { key: 'sales', label: 'Marketing and sales', detail: 'How you win work: channels, bid process, repeat-customer rate, pipeline.' },
  { key: 'uses', label: 'Loan request and use of proceeds', detail: 'Amount, program, term, sources and uses, and what each dollar buys.' },
  { key: 'fin', label: 'Financial summary and projections', detail: 'Historical results, projection assumptions, debt service coverage, and why the numbers are achievable.' },
  { key: 'risk', label: 'Risks and repayment contingency', detail: 'Main risks (customer concentration, seasonality, cost swings) and how the loan is still repaid.' },
];
export const PLAN_MIN_CHARS = 80;

/** Typical lender advance rates on collateral (haircuts), not SBA rules. */
export const COLLATERAL_TYPES: Record<string, number> = {
  'Real estate': 0.8, 'Equipment / vehicles': 0.5, 'Accounts receivable': 0.6, Inventory: 0.3, 'Cash / CDs': 0.9, 'Personal residence (equity)': 0.8, Other: 0.25,
};

// ---------------------------------------------------------------- history from imported months
export type HistKey = 'fy_prev' | 'fy_last' | 'ttm';
export type BasisKey = HistKey | 'avg2' | 'proj';
export interface LoanHistColumn {
  key: HistKey; label: string; from: string | null; to: string | null; months: number; complete: boolean;
  revenueCents: number; pretaxCents: number; interestCents: number; depreciationCents: number;
}
export interface LoanHistory { columns: LoanHistColumn[]; monthsOnFile: number; asOf: string | null; status: string | null; debtBalanceCents: number | null; debtBalanceAsOf: string | null }

/**
 * Last two complete fiscal years and the trailing twelve months from the months this user may see.
 * Pretax profit is as reported (before the owner-pay normalization), because lenders underwrite the books and tax returns.
 */
export function loanHistory(months: MonthData[], s: Settings): LoanHistory {
  const empty = (key: HistKey, label: string): LoanHistColumn => ({ key, label, from: null, to: null, months: 0, complete: false, revenueCents: 0, pretaxCents: 0, interestCents: 0, depreciationCents: 0 });
  if (!months.length) return { columns: [empty('fy_prev', 'Prior fiscal year'), empty('fy_last', 'Last fiscal year'), empty('ttm', 'Trailing 12 months')], monthsOnFile: 0, asOf: null, status: null, debtBalanceCents: null, debtBalanceAsOf: null };
  const last = months[months.length - 1].period;
  const endMonth = s.fiscalYearStartMonth === 1 ? 12 : s.fiscalYearStartMonth - 1;
  const [ly, lm] = last.split('-').map(Number);
  const fyEndYear = lm >= endMonth ? ly : ly - 1;
  const p = (y: number, m: number) => `${y}-${String(m).padStart(2, '0')}`;
  const window = (key: HistKey, to: string, label: string): LoanHistColumn => {
    const [ty, tm] = to.split('-').map(Number); const t = ty * 12 + tm - 1 - 11; const from = p(Math.floor(t / 12), (t % 12) + 1);
    const slice = months.filter((m) => m.period >= from && m.period <= to);
    if (!slice.length) return { ...empty(key, label), from, to };
    const { lines } = sumPnl(slice); const r = computePnl(lines, 0, s);
    return { key, label, from, to, months: slice.length, complete: slice.length === 12, revenueCents: lines.revenue, pretaxCents: r.pretax, interestCents: lines.interest_expense, depreciationCents: lines.depreciation };
  };
  const fyLabel = (y: number) => (endMonth === 12 ? `FY${y}` : `FY ending ${periodLabel(p(y, endMonth))}`);
  const bsMonth = [...months].reverse().find((m) => m.bs);
  return {
    columns: [window('fy_prev', p(fyEndYear - 1, endMonth), fyLabel(fyEndYear - 1)), window('fy_last', p(fyEndYear, endMonth), fyLabel(fyEndYear)), window('ttm', last, `TTM ${periodLabel(last)}`)],
    monthsOnFile: months.length, asOf: last, status: months[months.length - 1].status,
    debtBalanceCents: bsMonth ? bsMonth.bs!.line_of_credit + bsMonth.bs!.notes_payable : null, debtBalanceAsOf: bsMonth?.period ?? null,
  };
}

// ---------------------------------------------------------------- inputs
export interface LoanDebt { name: string; balanceCents: number; monthlyCents: number; refinanced: boolean }
export interface LoanUse { description: string; amountCents: number }
export interface LoanCollateral { type: string; description: string; valueCents: number }
export interface LoanInput {
  program: ProgramKey; purpose: LoanPurpose; amountCents: number; rateType: 'variable' | 'fixed'; rate: number; termYears: number;
  yearsInBusiness: number; specialPurposeProperty: boolean;
  basis: BasisKey;
  /** One-time, non-recurring items added back to EBITDA, by column. */
  addbacks: Record<HistKey, number>; addbackNote: string;
  /** Used only when no months were imported for that column. */
  manual: Record<HistKey, { revenueCents: number; ebitdaCents: number }>;
  projection: { label: string; revenueCents: number; ebitdaCents: number };
  debts: LoanDebt[];
  guarantor: { incomeCents: number; livingCents: number; debtMonthlyCents: number; creditScore: number | null; liquidCents: number };
  uses: LoanUse[];
  sources: { equityCents: number; sellerStandbyCents: number; otherCents: number };
  collateral: LoanCollateral[];
  eligibility: Record<string, boolean>; docs: Record<string, boolean>; plan: Record<string, string>;
}

export function defaultLoanInput(): LoanInput {
  const zero = { revenueCents: 0, ebitdaCents: 0 };
  return {
    program: 'sba7a', purpose: 'working', amountCents: 25_000_000, rateType: 'variable', rate: 0.10, termYears: 10, yearsInBusiness: 0, specialPurposeProperty: false,
    basis: 'fy_last', addbacks: { fy_prev: 0, fy_last: 0, ttm: 0 }, addbackNote: '', manual: { fy_prev: { ...zero }, fy_last: { ...zero }, ttm: { ...zero } },
    projection: { label: 'Projected year 1', revenueCents: 0, ebitdaCents: 0 }, debts: [],
    guarantor: { incomeCents: 0, livingCents: 0, debtMonthlyCents: 0, creditScore: null, liquidCents: 0 },
    uses: [{ description: 'Working capital', amountCents: 25_000_000 }], sources: { equityCents: 0, sellerStandbyCents: 0, otherCents: 0 }, collateral: [],
    eligibility: {}, docs: {}, plan: {},
  };
}

// ---------------------------------------------------------------- math
/** Level monthly principal-and-interest payment, in cents. */
export function monthlyPayment(principalCents: number, annualRate: number, years: number): number {
  const n = Math.max(1, Math.round(years * 12)); const r = annualRate / 12;
  if (principalCents <= 0) return 0;
  return Math.round(r ? (principalCents * r) / (1 - Math.pow(1 + r, -n)) : principalCents / n);
}
/** Loan amount a monthly payment supports, in cents. */
export function principalFor(monthlyCents: number, annualRate: number, years: number): number {
  const n = Math.max(1, Math.round(years * 12)); const r = annualRate / 12;
  if (monthlyCents <= 0) return 0;
  return Math.round(r ? (monthlyCents * (1 - Math.pow(1 + r, -n))) / r : monthlyCents * n);
}
/** SBA 7(a) maximum allowed rate for a loan size (Prime + spread). */
export function sbaMaxRate(amountCents: number, type: 'variable' | 'fixed', prime: number = LOAN_RULES.primeRate): number {
  const tbl = type === 'fixed' ? LOAN_RULES.fixedSpread : LOAN_RULES.variableSpread;
  return prime + tbl.find(([lim]) => amountCents <= lim)![1];
}

export interface DscrRule { target: number; historicalOnly: boolean; why: string }
export function dscrRule(i: Pick<LoanInput, 'program' | 'purpose' | 'amountCents'>): DscrRule {
  const D = LOAN_RULES.dscr;
  if (i.purpose === 'acquisition') return { target: D.acquisition, historicalOnly: true, why: 'Change of ownership, initial acquisition (SOP 50 10 8.1, Appendix 15). Must be met on the last fiscal year or a two-year average; projections are not allowed.' };
  if (i.purpose === 'buyout') return { target: D.buyout, historicalOnly: true, why: 'Change of ownership, owner buyout (SOP 50 10 8.1, Appendix 15). Historical earnings only.' };
  if (i.purpose === 'expansion') return { target: D.expansion, historicalOnly: true, why: 'Change of ownership, business expansion (SOP 50 10 8.1, Appendix 15). Historical earnings only.' };
  if (i.program === 'cdc504') return { target: D.cdc504, historicalOnly: false, why: 'CDC/504: CDC and bank credit policy; 1.15x used as the planning floor.' };
  if (i.program === 'micro') return { target: D.micro, historicalOnly: false, why: 'Microloan: intermediary policy; 1.20x used as the planning floor.' };
  if (i.amountCents > LOAN_RULES.smallLoanMaxCents) return { target: D.standard, historicalOnly: false, why: 'Standard 7(a) over $350K: at least 1.15x on a historical or projected basis (SOP 50 10 8).' };
  return { target: D.small, historicalOnly: false, why: "7(a) Small (≤ $350K): the lender's own prudent underwriting; 1.15x used as the planning floor." };
}

/** A startup is underwritten on projections. Years in business under one counts only when no history is on file or entered. */
export function isStartup(i: LoanInput, hasHistory: boolean): boolean { return i.purpose === 'startup' || (i.yearsInBusiness < 1 && !hasHistory); }

export function equityRequirement(i: LoanInput, startup = i.purpose === 'startup' || i.yearsInBusiness < 1): { pct: number; why: string } {
  if (i.program === 'cdc504') {
    const pct = 0.10 + (startup || i.yearsInBusiness < 2 ? 0.05 : 0) + (i.specialPurposeProperty ? 0.05 : 0);
    return { pct, why: '504: 10% minimum, plus 5% for a business two years old or less and 5% for special-purpose property.' };
  }
  if (i.program === 'micro') return { pct: 0, why: 'Microloan: set by the intermediary.' };
  if (i.purpose === 'acquisition') return { pct: 0.10, why: 'Initial acquisition: 10% of project costs, not reducible. Seller debt on standby, standby debt and minority equity may supply at most half.' };
  if (i.purpose === 'expansion') return { pct: 0.10, why: 'Business-expansion acquisition: starts at 10% under SOP 50 10 8.1.' };
  if (i.purpose === 'buyout') return { pct: 0.10, why: 'Owner buyout: equity and post-closing debt-to-worth tests apply (Appendix 15). 10% is used for planning; confirm with the lender.' };
  if (startup) return { pct: 0.10, why: 'Startup (operating one year or less): at least 10% of total project costs.' };
  return { pct: 0, why: 'Existing business, not an acquisition: SBA sets no minimum injection; lender policy applies.' };
}

// ---------------------------------------------------------------- evaluation
export type Tone = 'good' | 'warn' | 'bad';
export interface LoanColumnResult { key: HistKey | 'proj'; label: string; source: 'imported' | 'entered' | 'none'; months: number; complete: boolean; revenueCents: number; ebitdaCents: number; addbackCents: number; dscr: number | null }
export interface ProgramFit { key: ProgramKey; name: string; fit: boolean; issues: string[]; guaranty: number | null; guaranteedCents: number | null; maxRate: number | null; maxTermYears: number; monthlyCents: number; note: string }

export function evaluateLoan(i: LoanInput, hist: LoanHistory) {
  const rule = dscrRule(i);

  // Earnings columns: imported where available, otherwise entered by hand.
  const cols: LoanColumnResult[] = hist.columns.map((c) => {
    const add = i.addbacks[c.key] ?? 0;
    if (c.months > 0) return { key: c.key, label: c.label, source: 'imported', months: c.months, complete: c.complete, revenueCents: c.revenueCents, ebitdaCents: c.pretaxCents + c.interestCents + c.depreciationCents + add, addbackCents: add, dscr: null };
    const m = i.manual[c.key]; const has = !!m && (m.revenueCents !== 0 || m.ebitdaCents !== 0);
    return { key: c.key, label: c.label, source: has ? 'entered' : 'none', months: has ? 12 : 0, complete: has, revenueCents: m?.revenueCents ?? 0, ebitdaCents: (m?.ebitdaCents ?? 0) + (has ? add : 0), addbackCents: has ? add : 0, dscr: null };
  });
  const proj = i.projection; const hasProj = proj.revenueCents !== 0 || proj.ebitdaCents !== 0;
  cols.push({ key: 'proj', label: proj.label || 'Projected', source: hasProj ? 'entered' : 'none', months: hasProj ? 12 : 0, complete: hasProj, revenueCents: proj.revenueCents, ebitdaCents: proj.ebitdaCents, addbackCents: 0, dscr: null });
  const col = (k: string) => cols.find((c) => c.key === k)!;
  const startup = isStartup(i, cols.some((c) => c.key !== 'proj' && c.source !== 'none'));

  // Underwriting basis. Changes of ownership must use history; startups are underwritten on projections.
  let basisKey: BasisKey = i.basis; let basisNote: string | null = null;
  if (rule.historicalOnly && (basisKey === 'ttm' || basisKey === 'proj')) { basisKey = 'fy_last'; basisNote = 'This loan type must be underwritten on the last fiscal year or a two-year average.'; }
  if (startup && !rule.historicalOnly) { if (basisKey !== 'proj') basisNote = 'A startup is underwritten on projections.'; basisKey = 'proj'; }
  if (basisKey === 'fy_last' && col('fy_last').source === 'none' && col('ttm').source !== 'none' && !rule.historicalOnly) { basisKey = 'ttm'; basisNote = 'No complete fiscal year is on file, so the trailing twelve months are used.'; }
  const basisEbitda = basisKey === 'avg2' ? Math.round((col('fy_prev').ebitdaCents + col('fy_last').ebitdaCents) / 2) : col(basisKey).ebitdaCents;
  const basisLabel = basisKey === 'avg2' ? `Two-year average (${col('fy_prev').label} and ${col('fy_last').label})` : col(basisKey).label;
  const basisAvailable = basisKey === 'avg2' ? col('fy_prev').source !== 'none' && col('fy_last').source !== 'none' : col(basisKey).source !== 'none';
  const basisPartial = basisKey === 'avg2' ? !col('fy_prev').complete || !col('fy_last').complete : !col(basisKey).complete;

  // Debt service: the new loan plus every business debt that is not being refinanced by it.
  const newMonthlyCents = monthlyPayment(i.amountCents, i.rate, i.termYears);
  const newAnnualCents = newMonthlyCents * 12;
  const existingAnnualCents = i.debts.filter((d) => !d.refinanced).reduce((a, d) => a + d.monthlyCents * 12, 0);
  const debtServiceCents = newAnnualCents + existingAnnualCents;
  const cover = (e: number) => (debtServiceCents > 0 ? e / debtServiceCents : null);
  for (const c of cols) c.dscr = c.source === 'none' ? null : cover(c.ebitdaCents);
  const dscr = basisAvailable ? cover(basisEbitda) : null;

  const room = basisEbitda / rule.target - existingAnnualCents;
  const prog = PROGRAMS[i.program];
  const maxLoanCents = basisAvailable ? Math.max(0, Math.min(principalFor(Math.floor(room / 12), i.rate, i.termYears), i.program === 'cdc504' ? Infinity : prog.maxCents)) : null;
  const cushion = dscr !== null && dscr > 0 ? 1 - rule.target / dscr : null;

  const g = i.guarantor;
  const globalCashCents = basisEbitda + g.incomeCents - g.livingCents;
  const globalDebtServiceCents = debtServiceCents + g.debtMonthlyCents * 12;
  const guarantorEntered = g.incomeCents !== 0 || g.livingCents !== 0 || g.debtMonthlyCents !== 0;
  const globalDscr = basisAvailable && guarantorEntered && globalDebtServiceCents > 0 ? globalCashCents / globalDebtServiceCents : null;

  // Sources, uses and equity.
  const totalUsesCents = i.uses.reduce((a, u) => a + u.amountCents, 0);
  const totalSourcesCents = i.amountCents + i.sources.equityCents + i.sources.sellerStandbyCents + i.sources.otherCents;
  const eq = equityRequirement(i, startup);
  const requiredCents = Math.round(eq.pct * totalUsesCents);
  const sellerCountedCents = isChangeOfOwnership(i.purpose) ? Math.min(i.sources.sellerStandbyCents, Math.floor(requiredCents / 2)) : 0;
  const countedCents = i.sources.equityCents + sellerCountedCents;
  const equityMet = eq.pct === 0 || countedCents >= requiredCents;

  // Collateral at typical lender advance rates.
  const collateral = i.collateral.map((c) => { const adv = COLLATERAL_TYPES[c.type] ?? COLLATERAL_TYPES.Other; return { ...c, advanceRate: adv, lendableCents: Math.round(c.valueCents * adv) }; });
  const lendableCents = collateral.reduce((a, c) => a + c.lendableCents, 0);
  const collateralCoverage = i.amountCents > 0 ? lendableCents / i.amountCents : null;

  // Program fit.
  const usesWorkingCapital = i.uses.some((u) => /working capital|inventory|payroll/i.test(u.description));
  const programs: ProgramFit[] = PROGRAM_KEYS.map((k) => {
    const p = PROGRAMS[k]; const issues: string[] = [];
    if (!p.purposes.includes(i.purpose)) issues.push('This purpose is not eligible for the program');
    if (k === 'cdc504') {
      if (i.amountCents * 0.4 > LOAN_RULES.cdc504DebentureMaxCents) issues.push('The SBA debenture would exceed $5.5M');
      if (usesWorkingCapital) issues.push('Uses include working capital; 504 funds fixed assets only (pair it with a 7(a) or a line of credit)');
    } else if (i.amountCents > p.maxCents) issues.push(`Over the ${fmtUsd(p.maxCents)} program maximum`);
    const maxTerm = p.maxTermYears(i.purpose);
    if (i.termYears > maxTerm) issues.push(`Term is over the ${maxTerm}-year maximum for this purpose`);
    const maxRate = k === 'sba7a' || k === 'express' ? sbaMaxRate(i.amountCents, i.rateType) : null;
    const gty = p.guaranty(i.amountCents);
    return { key: k, name: p.name, fit: issues.length === 0, issues, guaranty: gty, guaranteedCents: gty === null ? null : Math.min(Math.round(i.amountCents * gty), LOAN_RULES.maxGuarantyCents),
      maxRate, maxTermYears: maxTerm, monthlyCents: monthlyPayment(i.amountCents, maxRate === null ? i.rate : Math.min(i.rate, maxRate), Math.min(i.termYears, maxTerm)), note: p.note };
  });
  const fit = (k: ProgramKey) => programs.find((p) => p.key === k)!;
  let recommended: ProgramKey | null = null;
  if ((i.purpose === 'realestate' || (i.purpose === 'equipment' && i.amountCents > 50_000_000)) && fit('cdc504').fit) recommended = 'cdc504';
  else if (i.amountCents <= 5_000_000 && fit('micro').fit) recommended = 'micro';
  else recommended = (['sba7a', 'express', 'cdc504', 'micro'] as ProgramKey[]).find((k) => fit(k).fit) ?? null;
  const rateCap = i.program === 'sba7a' || i.program === 'express' ? sbaMaxRate(i.amountCents, i.rateType) : null;

  // Checklists.
  const required = ELIGIBILITY.filter((e) => e.required); const optional = ELIGIBILITY.filter((e) => !e.required);
  const blockers = required.filter((e) => !i.eligibility[e.key]);
  const docsApplicable = LOAN_DOCS.filter((d) => !d.purposes || d.purposes.includes(i.purpose));
  const docsDone = docsApplicable.filter((d) => i.docs[d.key]).length;
  const planDone = PLAN_SECTIONS.filter((s) => (i.plan[s.key] ?? '').trim().length >= PLAN_MIN_CHARS).length;

  // Readiness score, out of 100. Any unmet SBA eligibility requirement caps it at 49.
  const sD = dscr === null ? 0 : dscr >= rule.target ? 30 : dscr >= 1 ? 10 + 15 * ((dscr - 1) / (rule.target - 1)) : 0;
  const sG = globalDscr === null ? 0 : globalDscr >= 1.25 ? 10 : globalDscr >= LOAN_RULES.globalDscrTarget ? 8 : globalDscr >= 1 ? 5 : 0;
  const sE = equityMet ? 10 : requiredCents ? 6 * Math.max(0, countedCents / requiredCents) : 0;
  const sEl = 17 * ((required.length - blockers.length) / required.length) + 3 * (optional.filter((e) => i.eligibility[e.key]).length / optional.length);
  const sC = collateralCoverage === null ? 0 : collateralCoverage >= 1 ? 5 : collateralCoverage >= 0.75 ? 3 : 1;
  const sDoc = 15 * (docsDone / docsApplicable.length);
  const sP = 10 * (planDone / PLAN_SECTIONS.length);
  const parts: [string, number, number][] = [['Debt service coverage', sD, 30], ['Global cash flow', sG, 10], ['Equity injection', sE, 10], ['Eligibility', sEl, 20], ['Collateral', sC, 5], ['Documents', sDoc, 15], ['Business plan', sP, 10]];
  let score = Math.round(parts.reduce((a, p) => a + p[1], 0));
  if (blockers.length) score = Math.min(score, 49);
  const status: { label: string; tone: Tone } = blockers.length ? { label: 'Not eligible yet', tone: 'bad' } : score >= 85 ? { label: 'Lender-ready', tone: 'good' } : score >= 70 ? { label: 'Nearly ready', tone: 'good' } : score >= 50 ? { label: 'Needs work', tone: 'warn' } : { label: 'Not yet', tone: 'bad' };

  // Open items, most serious first.
  const gaps: { tone: Tone; text: string }[] = [];
  for (const b of blockers) gaps.push({ tone: 'bad', text: `Eligibility: ${b.label}` });
  if (!fit(i.program).fit) gaps.push({ tone: 'bad', text: `${prog.name}: ${fit(i.program).issues.join('; ')}.` });
  if (!basisAvailable) gaps.push({ tone: 'bad', text: `No earnings on file for ${basisLabel}. Import or enter the financials to measure coverage.` });
  else if (dscr !== null && dscr < rule.target) gaps.push({ tone: 'bad', text: `Coverage of ${dscr.toFixed(2)}x is below the ${rule.target.toFixed(2)}x requirement. Current cash flow supports about ${fmtUsd(maxLoanCents ?? 0)} at this rate and term.` });
  else if (dscr !== null && dscr < LOAN_RULES.dscr.comfort) gaps.push({ tone: 'warn', text: `Coverage of ${dscr.toFixed(2)}x clears the ${rule.target.toFixed(2)}x floor but is under the 1.25x many lenders prefer.` });
  if (basisNote) gaps.push({ tone: 'warn', text: `Underwriting basis: ${basisNote}` });
  if (basisAvailable && basisPartial) gaps.push({ tone: 'warn', text: `${basisLabel} has fewer than 12 months on file.` });
  if (!guarantorEntered) gaps.push({ tone: 'warn', text: "Enter the guarantors' income, living expenses and personal debt payments so global cash flow can be measured." });
  if (globalDscr !== null && globalDscr < LOAN_RULES.globalDscrTarget) gaps.push({ tone: 'warn', text: `Global coverage of ${globalDscr.toFixed(2)}x is below ${LOAN_RULES.globalDscrTarget.toFixed(2)}x: personal obligations are heavy relative to income.` });
  if (!equityMet) gaps.push({ tone: 'bad', text: `Equity injection is short: ${fmtUsd(requiredCents)} needed (${Math.round(eq.pct * 100)}% of the project), ${fmtUsd(countedCents)} counts.` });
  if (rateCap !== null && i.rate > rateCap + 1e-9) gaps.push({ tone: 'bad', text: `The quoted rate of ${(i.rate * 100).toFixed(2)}% is above the SBA maximum of ${(rateCap * 100).toFixed(2)}% for this loan size.` });
  if (totalSourcesCents !== totalUsesCents) gaps.push({ tone: 'warn', text: `Sources (${fmtUsd(totalSourcesCents)}) do not equal uses (${fmtUsd(totalUsesCents)}).` });
  if (collateralCoverage !== null && collateralCoverage < 1) gaps.push({ tone: 'warn', text: `Collateral covers ${Math.round(collateralCoverage * 100)}% of the loan at lender advance rates; expect a lien on personal real estate if available.` });
  if (g.creditScore !== null && g.creditScore < LOAN_RULES.typicalCreditScore) gaps.push({ tone: 'warn', text: `A personal credit score of ${g.creditScore} is under the ~${LOAN_RULES.typicalCreditScore} many SBA lenders look for.` });
  const missingDocs = docsApplicable.filter((d) => !i.docs[d.key]);
  if (missingDocs.length) gaps.push({ tone: 'warn', text: `${missingDocs.length} document${missingDocs.length > 1 ? 's' : ''} still needed.` });
  if (planDone < PLAN_SECTIONS.length) gaps.push({ tone: 'warn', text: `Business plan: ${PLAN_SECTIONS.length - planDone} section${PLAN_SECTIONS.length - planDone > 1 ? 's' : ''} incomplete.` });
  for (const e of optional) if (!i.eligibility[e.key]) gaps.push({ tone: 'warn', text: e.label });

  return {
    engineVersion: LOAN_ENGINE_VERSION, rule, columns: cols,
    basis: { key: basisKey, label: basisLabel, ebitdaCents: basisEbitda, available: basisAvailable, partial: basisPartial, note: basisNote },
    newMonthlyCents, newAnnualCents, existingAnnualCents, debtServiceCents, dscr, maxLoanCents, cushion,
    global: { cashCents: globalCashCents, debtServiceCents: globalDebtServiceCents, dscr: globalDscr },
    totalUsesCents, totalSourcesCents,
    equity: { pct: eq.pct, why: eq.why, requiredCents, countedCents, sellerCountedCents, met: equityMet },
    collateral: { rows: collateral, lendableCents, coverage: collateralCoverage },
    programs, recommended, rateCap,
    eligibility: { requiredCount: required.length, blockers: blockers.map((b) => b.key) },
    docs: { applicable: docsApplicable.map((d) => d.key), done: docsDone, missing: missingDocs.map((d) => d.key) },
    plan: { done: planDone, total: PLAN_SECTIONS.length },
    score, parts, status, gaps,
  };
}
export type LoanResult = ReturnType<typeof evaluateLoan>;

const fmtUsd = (cents: number) => `$${Math.round(cents / 100).toLocaleString('en-US')}`;

/** Starter text for plan sections, from the figures. The client edits it. */
export function draftPlanSection(key: 'company' | 'uses' | 'fin', i: LoanInput, r: LoanResult, tenantName: string): string {
  if (key === 'company') return `${tenantName} has operated for ${i.yearsInBusiness} year${i.yearsInBusiness === 1 ? '' : 's'}. Entity and ownership: [legal entity, each owner and percentage; all owners are U.S. citizens or nationals living in the U.S.]. Location: [city, state]. Licenses and bonding: [list]. Key milestones: [list].`;
  if (key === 'uses') {
    const src = [['owner equity', i.sources.equityCents], ['seller note on full standby', i.sources.sellerStandbyCents], ['other sources', i.sources.otherCents]].filter(([, v]) => (v as number) > 0).map(([l, v]) => `${l} ${fmtUsd(v as number)}`);
    return `${tenantName} requests a ${fmtUsd(i.amountCents)} ${PROGRAMS[i.program].name} loan over ${i.termYears} years at a ${i.rateType} rate, for ${PURPOSE_LABELS[i.purpose].toLowerCase()}. Total project cost is ${fmtUsd(r.totalUsesCents)}:\n` +
      i.uses.map((u) => `• ${u.description}: ${fmtUsd(u.amountCents)}`).join('\n') +
      `\nSources: SBA loan ${fmtUsd(i.amountCents)}${src.length ? ', ' + src.join(', ') : ''}.` +
      (i.collateral.length ? `\nCollateral offered: ${i.collateral.map((c) => `${c.description || c.type} (${fmtUsd(c.valueCents)})`).join('; ')}.` : '') +
      ' Every owner of 20% or more will sign a personal guarantee.';
  }
  const h = r.columns.filter((c) => c.source !== 'none');
  return (h.length ? `Results: ${h.map((c) => `${c.label} revenue ${fmtUsd(c.revenueCents)} and EBITDA ${fmtUsd(c.ebitdaCents)}`).join('; ')}.` : 'Results: [historical revenue and EBITDA].') +
    (i.addbackNote ? ` Add-backs: ${i.addbackNote}.` : '') +
    `\nAnnual debt service including the proposed loan is ${fmtUsd(r.debtServiceCents)} (new loan ${fmtUsd(r.newAnnualCents)}, existing debt ${fmtUsd(r.existingAnnualCents)}).` +
    (r.dscr !== null ? ` On ${r.basis.label}, debt service coverage is ${r.dscr.toFixed(2)}x against a ${r.rule.target.toFixed(2)}x requirement${r.cushion !== null && r.cushion > 0 ? `, and EBITDA could fall ${Math.round(r.cushion * 100)}% before coverage drops below that level` : ''}.` : '') +
    (r.global.dscr !== null ? ` Global coverage including the guarantors' personal obligations is ${r.global.dscr.toFixed(2)}x.` : '') +
    '\nProjection assumptions: [pricing, backlog and contracts, margin and staffing assumptions behind the projected year].';
}
