// CFO Intelligence — calculation engine core.
// Pure functions only: no I/O, no DOM, no database. Runs unchanged on server and in the browser.
// Money is held as INTEGER CENTS (number). Ratios are floats and are null when undefined (shown as N/A).

export const ENGINE_VERSION = '1.0.0';

export const PNL_LINES = [
  'revenue', 'cogs', 'direct_labor', 'facilities', 'marketing', 'mgmt_labor',
  'payroll_taxes_benefits', 'other_opex', 'depreciation', 'other_income_expense', 'interest_expense',
] as const;
export type PnlLine = (typeof PNL_LINES)[number];
export type PnlLines = Record<PnlLine, number>;

export const BS_LINES = [
  'cash', 'accounts_receivable', 'other_current_assets', 'fixed_assets', 'accumulated_depreciation', 'other_assets',
  'accounts_payable', 'credit_cards', 'other_current_liabilities', 'line_of_credit', 'notes_payable', 'equity',
] as const;
export type BsLine = (typeof BS_LINES)[number];
export type BsLines = Record<BsLine, number>;

export const LINE_LABELS: Record<string, string> = {
  revenue: 'Revenue', cogs: 'Cost of goods sold (non-labor)', direct_labor: 'Direct labor',
  facilities: 'Facilities', marketing: 'Marketing', mgmt_labor: 'Management & admin labor',
  payroll_taxes_benefits: 'Payroll taxes & benefits', other_opex: 'Other operating expenses',
  depreciation: 'Depreciation', other_income_expense: 'Other income (expense)', interest_expense: 'Interest expense',
  cash: 'Cash', accounts_receivable: 'Accounts receivable', other_current_assets: 'Other current assets',
  fixed_assets: 'Fixed assets', accumulated_depreciation: 'Accumulated depreciation', other_assets: 'Other assets',
  accounts_payable: 'Accounts payable', credit_cards: 'Credit cards payable',
  other_current_liabilities: 'Other current liabilities', line_of_credit: 'Line of credit',
  notes_payable: 'Notes payable', equity: 'Equity',
};
export const BS_ASSET_LINES: BsLine[] = ['cash', 'accounts_receivable', 'other_current_assets', 'fixed_assets', 'accumulated_depreciation', 'other_assets'];
export const BS_LIAB_EQUITY_LINES: BsLine[] = ['accounts_payable', 'credit_cards', 'other_current_liabilities', 'line_of_credit', 'notes_payable', 'equity'];

export type Grade = 'Great' | 'Good' | 'OK' | 'Caution' | 'N/A';
export type PeriodStatus = 'preliminary' | 'reconciled' | 'approved';

/** A ratio that may be undefined. `reason` explains every N/A in plain language. */
export interface Ratio { value: number | null; reason?: string }

export function ratio(num: number, den: number, why = 'the denominator is zero for this period'): Ratio {
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return { value: null, reason: `Not available: ${why}.` };
  return { value: num / den };
}

export interface Thresholds { great: number; good: number; ok: number }
export interface Settings {
  pretaxTargetPct: number;
  dlerTarget: number | null;
  mlerTarget: number | null;
  salesTargetR12Cents: number | null;
  opexPctTarget: number | null;
  dsoTargetDays: number | null;
  dsoWindowDays: number;
  coreCapitalMonths: number;
  coreCapitalBasis: 'r12_avg' | 't3m_avg' | 'latest_month';
  coreCapitalExcludeCogs: boolean;
  /** 'opex' = payroll taxes & benefits stay in operating expenses (source workbooks). 'labor' = treated as labor cost. Never both. */
  burdenTreatment: 'opex' | 'labor';
  weeklyGpTargetCents: number | null;
  cashFloorCents: number;
  weekStartDay: number; // 0=Sunday … 6=Saturday
  fiscalYearStartMonth: number; // 1-12
  clientCanRunScenarios: boolean;
  /** Planning rate for setting cash aside for income taxes on pretax profit. An assumption, not a tax calculation. */
  taxReserveRate: number;
  /** Taxes already paid or distributed for tax, by fiscal year (the year the fiscal year starts in). */
  taxesPaid: Record<string, number>;
  /** Projected income tax for the fiscal year from tax planning, when the advisor has one. Overrides rate × profit for that year. */
  taxProjected: Record<string, number>;
  /** Total line of credit available from the bank, so the weekly cash report can show what is left to draw. */
  locLimitCents: number | null;
  /** Stretch pretax profit target shown on the rolling-twelve view (the level to reach before pushing growth). */
  stretchPretaxPct: number;
  /** Day of the month by which last month's reports should be ready. */
  reportDueDay: number;
  /** Day of the week bills are paid (0=Sunday … 6=Saturday), or null to pay each bill on its due date. */
  billPayWeekday: number | null;
  /** Grade cut-offs, each expressed as attainment (actual relative to target; 1.0 = on target). Adjustable per client. */
  grades: Record<'profitability' | 'sales' | 'opex' | 'salary_cap' | 'dso' | 'core_capital' | 'labor', Thresholds>;
}

export const DEFAULT_SETTINGS: Settings = {
  pretaxTargetPct: 0.10,
  dlerTarget: null, mlerTarget: null, salesTargetR12Cents: null, opexPctTarget: null, dsoTargetDays: null,
  dsoWindowDays: 60,
  coreCapitalMonths: 2, coreCapitalBasis: 'r12_avg', coreCapitalExcludeCogs: true, // two months of operating expenses and labor; non-labor COGS excluded by default
  burdenTreatment: 'opex',
  weeklyGpTargetCents: null, cashFloorCents: 0, weekStartDay: 1, fiscalYearStartMonth: 1,
  clientCanRunScenarios: true, taxReserveRate: 0.40, taxesPaid: {}, taxProjected: {}, locLimitCents: null, stretchPretaxPct: 0.15, reportDueDay: 5, billPayWeekday: null,
  grades: {
    profitability: { great: 1.5, good: 1.0, ok: 0.5 },
    sales: { great: 1.05, good: 1.0, ok: 0.9 },
    opex: { great: 1.05, good: 1.0, ok: 0.9 },
    salary_cap: { great: 1.05, good: 1.0, ok: 0.95 },
    dso: { great: 1.15, good: 1.0, ok: 0.8 },
    core_capital: { great: 1.0, good: 0.75, ok: 0.5 },
    labor: { great: 1.1, good: 1.0, ok: 0.9 },
  },
};

export function mergeSettings(partial: Partial<Settings> | null | undefined): Settings {
  const p = partial ?? {};
  return { ...DEFAULT_SETTINGS, ...p, grades: { ...DEFAULT_SETTINGS.grades, ...(p.grades ?? {}) } };
}

export const zeroPnl = (): PnlLines => Object.fromEntries(PNL_LINES.map((k) => [k, 0])) as PnlLines;
export const zeroBs = (): BsLines => Object.fromEntries(BS_LINES.map((k) => [k, 0])) as BsLines;

export interface MonthData {
  period: string; // YYYY-MM
  pnl: PnlLines;
  bs: BsLines | null;
  /** Owner compensation normalization for the month, in cents. Positive = owner underpaid vs. market (reduces true profit). */
  ownerAdj: number;
  status: PeriodStatus;
}

// ---------- periods ----------
export function addMonths(period: string, n: number): string {
  const [y, m] = period.split('-').map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
}
export function monthsBetween(a: string, b: string): number {
  const [ay, am] = a.split('-').map(Number); const [by, bm] = b.split('-').map(Number);
  return (by - ay) * 12 + (bm - am);
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function periodLabel(period: string): string {
  const [y, m] = period.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}
export const isPeriod = (s: string) => /^\d{4}-(0[1-9]|1[0-2])$/.test(s);

// ---------- management P&L ----------
export interface PnlResult {
  lines: PnlLines;
  grossProfit: number; grossMarginPct: Ratio;
  contributionMargin: number; contributionPct: Ratio;
  totalOpex: number; opexPct: Ratio;
  operatingIncome: number;
  otherTotal: number;
  pretax: number; pretaxPct: Ratio;
  ownerAdj: number;
  adjustedPretax: number; adjustedPretaxPct: Ratio;
  directLaborCost: number; mgmtLaborCost: number; totalLabor: number; adjustedLabor: number;
  dLER: Ratio; mLER: Ratio; tLER: Ratio; adjustedLER: Ratio;
  salaryCap: number; salaryCapHeadroom: number;
}

/**
 * Simplified management P&L (Financial-Reporting-Formats.xlsx; Deluxe / Prime "PL by Month").
 * Sign convention: revenue and every expense line are positive; other_income_expense is signed (+ income, − expense).
 */
export function computePnl(l: PnlLines, ownerAdj: number, s: Settings): PnlResult {
  const grossProfit = l.revenue - l.cogs;
  const contributionMargin = grossProfit - l.direct_labor;
  const totalOpex = l.facilities + l.marketing + l.mgmt_labor + l.payroll_taxes_benefits + l.other_opex;
  const operatingIncome = contributionMargin - totalOpex;
  const otherTotal = l.other_income_expense - l.depreciation - l.interest_expense;
  const pretax = operatingIncome + otherTotal;
  const adjustedPretax = pretax - ownerAdj;
  // Burden treatment decides whether payroll taxes & benefits count as labor. They are counted exactly once either way.
  const burden = s.burdenTreatment === 'labor' ? l.payroll_taxes_benefits : 0;
  const wages = l.direct_labor + l.mgmt_labor;
  const totalLabor = wages + burden;
  const adjustedLabor = totalLabor + ownerAdj;
  // Salary cap: the labor spend at which pretax profit equals the target %, holding every non-labor line constant.
  const nonLaborOpex = l.facilities + l.marketing + l.other_opex + (s.burdenTreatment === 'labor' ? 0 : l.payroll_taxes_benefits);
  const salaryCap = Math.round((1 - s.pretaxTargetPct) * l.revenue) - l.cogs - nonLaborOpex + otherTotal;
  return {
    lines: l, grossProfit, grossMarginPct: ratio(grossProfit, l.revenue, 'there is no revenue'),
    contributionMargin, contributionPct: ratio(contributionMargin, l.revenue, 'there is no revenue'),
    totalOpex, opexPct: ratio(totalOpex, l.revenue, 'there is no revenue'),
    operatingIncome, otherTotal, pretax, pretaxPct: ratio(pretax, l.revenue, 'there is no revenue'),
    ownerAdj, adjustedPretax, adjustedPretaxPct: ratio(adjustedPretax, l.revenue, 'there is no revenue'),
    directLaborCost: l.direct_labor, mgmtLaborCost: l.mgmt_labor, totalLabor, adjustedLabor,
    dLER: ratio(grossProfit, l.direct_labor, 'no direct labor was recorded'),
    mLER: ratio(contributionMargin, l.mgmt_labor, 'no management labor was recorded'),
    tLER: ratio(grossProfit, totalLabor, 'no labor cost was recorded'),
    adjustedLER: ratio(grossProfit, adjustedLabor, 'no labor cost was recorded'),
    salaryCap, salaryCapHeadroom: salaryCap - adjustedLabor,
  };
}

export function sumPnl(months: MonthData[]): { lines: PnlLines; ownerAdj: number } {
  const lines = zeroPnl(); let ownerAdj = 0;
  for (const m of months) { for (const k of PNL_LINES) lines[k] += m.pnl[k]; ownerAdj += m.ownerAdj; }
  return { lines, ownerAdj };
}

export interface WindowResult extends PnlResult { from: string; to: string; monthsIncluded: number; complete: boolean }

/** Trailing window ending at index `idx`. `complete` is false when fewer than `n` months exist (never silently labelled R12). */
export function trailing(months: MonthData[], idx: number, n: number, s: Settings): WindowResult | null {
  if (idx < 0 || idx >= months.length) return null;
  const slice = months.slice(Math.max(0, idx - n + 1), idx + 1);
  const { lines, ownerAdj } = sumPnl(slice);
  return { ...computePnl(lines, ownerAdj, s), from: slice[0].period, to: slice[slice.length - 1].period, monthsIncluded: slice.length, complete: slice.length === n };
}
export const rolling12 = (months: MonthData[], idx: number, s: Settings) => trailing(months, idx, 12, s);

/** Fiscal year-to-date window ending at idx. */
export function ytd(months: MonthData[], idx: number, s: Settings): WindowResult | null {
  if (idx < 0 || idx >= months.length) return null;
  const [y, m] = months[idx].period.split('-').map(Number);
  const startYear = m >= s.fiscalYearStartMonth ? y : y - 1;
  const start = `${startYear}-${String(s.fiscalYearStartMonth).padStart(2, '0')}`;
  const slice = months.slice(0, idx + 1).filter((x) => x.period >= start);
  const { lines, ownerAdj } = sumPnl(slice);
  const expected = monthsBetween(start, months[idx].period) + 1;
  return { ...computePnl(lines, ownerAdj, s), from: start, to: months[idx].period, monthsIncluded: slice.length, complete: slice.length === expected };
}

// ---------- balance-sheet metrics ----------
/** A/R days sales outstanding on the trailing window of sales (source: BS!55, AR ÷ (last two months sales ÷ 60)). */
export function dso(months: MonthData[], idx: number, s: Settings): Ratio {
  const cur = months[idx];
  if (!cur?.bs) return { value: null, reason: 'Not available: no balance sheet has been imported for this period.' };
  const nMonths = Math.max(1, Math.round(s.dsoWindowDays / 30));
  if (idx - nMonths + 1 < 0) return { value: null, reason: `Not available: needs ${nMonths} months of sales history.` };
  let sales = 0;
  for (let i = idx - nMonths + 1; i <= idx; i++) sales += months[i].pnl.revenue;
  if (cur.bs.accounts_receivable === 0) return { value: null, reason: 'Not applicable: there are no receivables (sales are collected at the time of sale).' };
  return ratio(cur.bs.accounts_receivable * s.dsoWindowDays, sales, 'there were no sales in the measurement window');
}

export interface CoreCapital {
  available: number | null; cash: number | null; locBalance: number | null;
  monthlyBasis: number; target: number; surplus: number | null;
  attainment: Ratio; monthsCovered: Ratio; basisLabel: string;
}
/**
 * Core capital (Simple Numbers-inspired): cash net of line-of-credit usage, compared with N months of
 * operating expenses + direct labor (+ non-labor COGS unless vendor terms cover it).
 */
export function coreCapital(months: MonthData[], idx: number, s: Settings): CoreCapital {
  const n = s.coreCapitalBasis === 'latest_month' ? 1 : s.coreCapitalBasis === 't3m_avg' ? 3 : 12;
  const w = trailing(months, idx, n, s)!;
  const spend = w.totalOpex + w.lines.direct_labor + (s.coreCapitalExcludeCogs ? 0 : w.lines.cogs);
  const monthlyBasis = Math.round(spend / w.monthsIncluded);
  const target = Math.round(monthlyBasis * s.coreCapitalMonths);
  const bs = months[idx].bs;
  const basisLabel = `${s.coreCapitalMonths} × average monthly operating expenses and direct labor${s.coreCapitalExcludeCogs ? '' : ', plus non-labor COGS'} (${w.monthsIncluded}-month average)`;
  if (!bs) {
    const na = { value: null, reason: 'Not available: no balance sheet has been imported for this period.' };
    return { available: null, cash: null, locBalance: null, monthlyBasis, target, surplus: null, attainment: na, monthsCovered: na, basisLabel };
  }
  const available = bs.cash - bs.line_of_credit;
  return {
    available, cash: bs.cash, locBalance: bs.line_of_credit, monthlyBasis, target, surplus: available - target,
    attainment: ratio(available, target, 'no operating spend was recorded'),
    monthsCovered: ratio(available, monthlyBasis, 'no operating spend was recorded'), basisLabel,
  };
}

/** Balance check: assets − (liabilities + equity). Differences are reported, never forced to zero. */
export function bsImbalance(bs: BsLines): number {
  const assets = BS_ASSET_LINES.reduce((a, k) => a + bs[k], 0);
  const le = BS_LIAB_EQUITY_LINES.reduce((a, k) => a + bs[k], 0);
  return assets - le;
}

/** Indirect cash flow for one month from two balance sheets; `difference` reconciles to the reported cash balance. */
export function cashFlowMonth(prev: BsLines, cur: BsLines, pnl: PnlLines, ownerAdjIgnored = 0) {
  void ownerAdjIgnored;
  const p = computePnl(pnl, 0, DEFAULT_SETTINGS);
  const d = (k: BsLine) => cur[k] - prev[k];
  const operations = p.pretax + pnl.depreciation - d('accounts_receivable') - d('other_current_assets') - d('other_assets')
    + d('accounts_payable') + d('credit_cards') + d('other_current_liabilities');
  // Fixed asset purchases: change in gross fixed assets (accumulated depreciation is stored as a negative asset).
  const investing = -d('fixed_assets');
  const accDepChange = d('accumulated_depreciation') + pnl.depreciation; // should be 0 when depreciation is the only movement
  const loc = d('line_of_credit'); const notes = d('notes_payable');
  const equityOther = d('equity') - p.pretax; // distributions (−) / contributions (+) and anything not in pretax profit
  const financing = loc + notes + equityOther;
  const net = operations + investing + financing - accDepChange;
  const endingCashCalc = prev.cash + net;
  return { netIncome: p.pretax, operations, investing, financing, loc, notes, equityOther, net, beginningCash: prev.cash, endingCashCalc, endingCashReported: cur.cash, difference: endingCashCalc - cur.cash };
}

// ---------- sweat equity ----------
export interface SweatRow {
  period: string;
  underpay: number;                 // owner pay below market for the month (negative = paid above market)
  distributions: number | null;     // shareholder distributions taken in the month
  distributionSource: 'entered' | 'balance_sheet' | 'unavailable';
  balanceBefore: number; change: number; balance: number;
  excessDistributions: number;      // distributions beyond the sweat-equity balance (a return of profit, not of unpaid wages)
}
/**
 * Sweat equity ledger (Prime dashboard commentary: "track sweat equity if under market base").
 * Each month the owner's underpayment vs. a market wage ADDS to sweat equity; shareholder distributions taken REDUCE it,
 * because a distribution is the owner being paid in another form. The balance never goes below zero.
 * Distributions are advisor-entered when available; otherwise derived from the balance sheet as
 * (prior equity + pretax profit − current equity), which also captures anything else posted directly to equity.
 */
export function sweatEquity(months: MonthData[], entered: Record<string, number> = {}): SweatRow[] {
  let balance = 0;
  return months.map((m, i) => {
    let distributions: number | null = null; let source: SweatRow['distributionSource'] = 'unavailable';
    if (Object.hasOwn(entered, m.period)) { distributions = entered[m.period]; source = 'entered'; }
    else if (i > 0 && m.bs && months[i - 1].bs) { distributions = Math.max(0, months[i - 1].bs!.equity + computePnl(m.pnl, 0, DEFAULT_SETTINGS).pretax - m.bs.equity); source = 'balance_sheet'; }
    const before = balance; const raw = before + m.ownerAdj - (distributions ?? 0);
    balance = Math.max(0, raw);
    return { period: m.period, underpay: m.ownerAdj, distributions, distributionSource: source, balanceBefore: before, change: balance - before, balance, excessDistributions: Math.max(0, -raw) };
  });
}

// ---------- formatting helpers shared by UI and reports ----------
export function fmtMoney(cents: number | null | undefined, opts: { compact?: boolean } = {}): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return 'N/A';
  const v = cents / 100; const neg = v < 0; const a = Math.abs(v);
  let body: string;
  if (opts.compact && a >= 1_000_000) body = `$${(a / 1_000_000).toFixed(2)}M`;
  else if (opts.compact && a >= 10_000) body = `$${(a / 1000).toFixed(a >= 100_000 ? 0 : 1)}K`;
  else body = `$${Math.round(a).toLocaleString('en-US')}`;
  return neg ? `(${body})` : body;
}
export const fmtPct = (r: number | null | undefined, digits = 1) => (r === null || r === undefined || !Number.isFinite(r) ? 'N/A' : `${(r * 100).toFixed(digits)}%`);
export const fmtRatio = (r: number | null | undefined, digits = 2) => (r === null || r === undefined || !Number.isFinite(r) ? 'N/A' : `${r.toFixed(digits)}x`);
export const fmtDays = (r: number | null | undefined) => (r === null || r === undefined || !Number.isFinite(r) ? 'N/A' : `${Math.round(r)} days`);
