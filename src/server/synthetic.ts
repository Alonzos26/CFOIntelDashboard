// SYNTHETIC demo data generator. Every number produced here is invented by a seeded random generator.
// No real client data is used anywhere in this repository.
import { addMonths } from '../engine/core.ts';

function rng(seed: number) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

export interface Profile {
  seed: number; months: number; endPeriod: string;
  revenue: number; growth: number; seasonality: number[]; cogsPct: number; dler: number; dlerDrift: number;
  rent: number; marketingPct: number; mgmtLabor: number; burdenPct: number; otherPct: number; depreciation: number; interest: number;
  arDays: number; startCash: number; notes: number; notePayment: number; distributions: number; fixedAssets: number;
  accounts: { revenue: [string, number][]; cogs: [string, number][]; directLabor: string; rent: string; utilities: string; marketing: string; mgmt: [string, number][]; burden: [string, number][]; other: [string, number][] };
}
export interface Generated { pnlCsv: string; bsCsv: string; periods: string[]; pnlMap: Record<string, [string, number]>; bsMap: Record<string, [string, number]> }

const csv = (rows: (string | number)[][]) => rows.map((r) => r.map((x) => (typeof x === 'string' && /[",]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x)).join(',')).join('\n') + '\n';
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const head = (p: string) => `${MON[Number(p.slice(5)) - 1]} ${p.slice(0, 4)}`;

export function generate(p: Profile): Generated {
  const r = rng(p.seed); const jitter = (pct: number) => 1 + (r() - 0.5) * 2 * pct; const d2 = (n: number) => Math.round(n * 100) / 100;
  const periods = Array.from({ length: p.months }, (_, i) => addMonths(p.endPeriod, i - p.months + 1));
  const pnlRows = new Map<string, number[]>(); const pnlMap: Generated['pnlMap'] = {}; const bsRows = new Map<string, number[]>(); const bsMap: Generated['bsMap'] = {};
  const put = (name: string, line: string, v: number, sign = 1) => { if (!pnlRows.has(name)) { pnlRows.set(name, []); pnlMap[name] = [line, sign]; } pnlRows.get(name)!.push(d2(v)); };
  const bput = (name: string, line: string, v: number, sign = 1) => { if (!bsRows.has(name)) { bsRows.set(name, []); bsMap[name] = [line, sign]; } bsRows.get(name)!.push(d2(v)); };
  let cash = p.startCash, ar = 0, ap = 0, cc = 9000, fixed = p.fixedAssets, accDep = p.fixedAssets * 0.3, notes = p.notes, equity = 0, prevRev = p.revenue;
  periods.forEach((period, i) => {
    const m = Number(period.slice(5)) - 1;
    const rev = p.revenue * Math.pow(1 + p.growth, i / 12) * p.seasonality[m] * jitter(0.06);
    const cogs = rev * p.cogsPct * jitter(0.05); const gp = rev - cogs;
    const dl = gp / (p.dler + p.dlerDrift * (i / p.months)) * jitter(0.04);
    const mgmt = p.mgmtLabor * Math.pow(1.04, i / 12); const burden = (dl + mgmt) * p.burdenPct * jitter(0.03);
    const rent = p.rent * (i >= 12 ? 1.04 : 1); const util = p.rent * 0.14 * jitter(0.2); const mkt = rev * p.marketingPct * jitter(0.3); const other = rev * p.otherPct * jitter(0.15);
    const interest = notes * 0.075 / 12; const otherInc = r() < 0.2 ? 400 + r() * 900 : 0;
    let tr = 0; for (const [n, w] of p.accounts.revenue) { const v = rev * w; tr += d2(v); put(n, 'revenue', v); }
    put('Total Income', 'ignore', tr);
    let tc = 0; for (const [n, w] of p.accounts.cogs) { const v = cogs * w; tc += d2(v); put(n, 'cogs', v); }
    put(p.accounts.directLabor, 'direct_labor', dl); put('Gross Profit', 'ignore', tr - tc);
    put(p.accounts.rent, 'facilities', rent); put(p.accounts.utilities, 'facilities', util); put(p.accounts.marketing, 'marketing', mkt);
    let tm = 0; for (const [n, w] of p.accounts.mgmt) { const v = mgmt * w; tm += d2(v); put(n, 'mgmt_labor', v); }
    let tb = 0; for (const [n, w] of p.accounts.burden) { const v = burden * w; tb += d2(v); put(n, 'payroll_taxes_benefits', v); }
    let to = 0; for (const [n, w] of p.accounts.other) { const v = other * w; to += d2(v); put(n, 'other_opex', v); }
    put('Depreciation Expense', 'depreciation', p.depreciation); put('Interest Expense', 'interest_expense', interest); put('Other Income', 'other_income_expense', otherInc);
    const net = d2(tr - tc - d2(dl) - d2(rent) - d2(util) - d2(mkt) - tm - tb - to - d2(p.depreciation) - d2(interest) + d2(otherInc));
    put('Net Income', 'control_pretax', net);
    // Balance sheet: every balance moves by a cash-flow identity, so the sheet balances by construction.
    const newAr = (rev + prevRev) / 60 * p.arDays * jitter(0.08); const newAp = cogs * 0.55 * jitter(0.1); const newCc = 7000 + r() * 6000;
    const capex = i % 9 === 4 ? 18000 + r() * 12000 : 0; const pay = Math.min(notes, p.notePayment); const dist = p.distributions;
    if (i === 0) { ar = newAr; ap = newAp; cc = newCc; equity = cash + ar + fixed - accDep - ap - cc - notes; }
    else { cash += net + p.depreciation - (newAr - ar) + (newAp - ap) + (newCc - cc) - capex - pay - dist; ar = newAr; ap = newAp; cc = newCc; fixed += capex; accDep += p.depreciation; notes -= pay; equity += net - dist; }
    prevRev = rev;
    bput('1000 Operating Checking', 'cash', cash * 0.8); bput('1010 Savings Reserve', 'cash', cash * 0.2); bput('1200 Accounts Receivable', 'accounts_receivable', ar);
    bput('1500 Vehicles & Equipment', 'fixed_assets', fixed); bput('1590 Accumulated Depreciation', 'accumulated_depreciation', -accDep);
    bput('2000 Accounts Payable', 'accounts_payable', ap); bput('2100 Credit Card Payable', 'credit_cards', cc); bput('2500 Equipment Note Payable', 'notes_payable', notes);
    const le = d2(ap) + d2(cc) + d2(notes); const assets = d2(cash * 0.8) + d2(cash * 0.2) + d2(ar) + d2(fixed) + d2(-accDep);
    bput("3000 Owner's Equity", 'equity', assets - le); // equity carries sub-cent rounding so the exported sheet balances exactly
  });
  const table = (rows: Map<string, number[]>) => csv([['Account', ...periods.map(head)], ...[...rows].map(([n, v]) => [n, ...v])]);
  return { pnlCsv: table(pnlRows), bsCsv: table(bsRows), periods, pnlMap, bsMap };
}

const flat = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
export const PROFILES = {
  cedar: (end: string): Profile => ({ seed: 11, months: 34, endPeriod: end, revenue: 205_000, growth: 0.09, seasonality: [0.82, 0.85, 0.95, 1.02, 1.1, 1.14, 1.12, 1.1, 1.05, 1.0, 0.93, 0.86], cogsPct: 0.37, dler: 2.05, dlerDrift: -0.3,
    rent: 7_500, marketingPct: 0.018, mgmtLabor: 19_000, burdenPct: 0.105, otherPct: 0.04, depreciation: 2_600, interest: 0, arDays: 44, startCash: 148_000, notes: 132_000, notePayment: 2_600, distributions: 2_500, fixedAssets: 210_000,
    accounts: { revenue: [['4000 Construction Income', 0.82], ['4100 Service & Repair Income', 0.18]], cogs: [['5000 Materials', 0.52], ['5100 Subcontractors', 0.4], ['5200 Equipment Rental', 0.08]], directLabor: '5500 Field Wages', rent: '6000 Rent', utilities: '6010 Utilities', marketing: '6100 Advertising & Marketing',
      mgmt: [['6200 Office & Management Salaries', 0.6], ['6210 Officer Salary', 0.4]], burden: [['6300 Payroll Taxes', 0.6], ['6310 Health Insurance', 0.3], ['6320 Workers Compensation', 0.1]], other: [['6400 Insurance - General Liability', 0.3], ['6410 Software & Technology', 0.15], ['6420 Professional Fees', 0.2], ['6430 Vehicle Expense', 0.25], ['6440 Office Expense', 0.1]] } }),
  harbor: (end: string): Profile => ({ seed: 23, months: 24, endPeriod: end, revenue: 96_000, growth: 0.06, seasonality: flat, cogsPct: 0.16, dler: 2.6, dlerDrift: 0.1,
    rent: 6_200, marketingPct: 0.03, mgmtLabor: 9_500, burdenPct: 0.12, otherPct: 0.05, depreciation: 1_900, interest: 0, arDays: 28, startCash: 92_000, notes: 60_000, notePayment: 1_500, distributions: 7_000, fixedAssets: 160_000,
    accounts: { revenue: [['4000 Patient Services Income', 0.9], ['4100 Product Sales', 0.1]], cogs: [['5000 Dental Supplies', 0.6], ['5100 Lab Fees', 0.4]], directLabor: '5500 Hygienist & Assistant Wages', rent: '6000 Rent', utilities: '6010 Utilities', marketing: '6100 Advertising & Marketing',
      mgmt: [['6200 Office Salaries', 1]], burden: [['6300 Payroll Taxes', 0.65], ['6310 Health Insurance', 0.35]], other: [['6400 Insurance - Malpractice', 0.4], ['6410 Software & Technology', 0.3], ['6420 Professional Fees', 0.3]] } }),
  lakeside: (end: string): Profile => ({ seed: 37, months: 22, endPeriod: end, revenue: 58_000, growth: 0.12, seasonality: flat, cogsPct: 0.31, dler: 2.3, dlerDrift: -0.1,
    rent: 4_600, marketingPct: 0.035, mgmtLabor: 4_200, burdenPct: 0.1, otherPct: 0.045, depreciation: 900, interest: 0, arDays: 6, startCash: 31_000, notes: 38_000, notePayment: 900, distributions: 2_500, fixedAssets: 85_000,
    accounts: { revenue: [['4000 Labor Sales', 0.55], ['4100 Parts Sales', 0.45]], cogs: [['5000 Parts Purchases', 0.9], ['5100 Shop Supplies - Job', 0.1]], directLabor: '5500 Technician Wages', rent: '6000 Rent', utilities: '6010 Utilities', marketing: '6100 Advertising & Marketing',
      mgmt: [['6200 Office Salaries', 1]], burden: [['6300 Payroll Taxes', 0.8], ['6320 Workers Compensation', 0.2]], other: [['6400 Insurance - Garage Liability', 0.4], ['6410 Software & Technology', 0.25], ['6420 Professional Fees', 0.35]] } }),
};

/** A deliberately flawed copy of a P&L file, used to demonstrate import validation. */
export function withErrors(pnlCsv: string): string {
  const lines = pnlCsv.trim().split('\n').map((l) => l.split(','));
  const drop = lines[0].length - 5; // remove one month from the middle of the file
  const out = lines.map((l) => l.filter((_, i) => i !== drop));
  const rent = out.find((l) => l[0].includes('Rent'))!; rent[rent.length - 2] = '#REF!';
  const util = out.findIndex((l) => l[0].includes('Utilities')); out.splice(util, 1); // omitted account: net income no longer reconciles
  return out.map((l) => l.join(',')).join('\n') + '\n';
}
