// SBA loan readiness engine: payment math, DSCR against the SBA rules, program fit, equity and the readiness score.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, type MonthData, addMonths, zeroPnl } from '../src/engine/core.ts';
import { ELIGIBILITY, LOAN_DOCS, PLAN_SECTIONS, type LoanHistory, type LoanInput, defaultLoanInput, dscrRule, evaluateLoan, loanHistory, monthlyPayment, principalFor, sbaMaxRate } from '../src/engine/loans.ts';

const c = (dollars: number) => Math.round(dollars * 100);
const near = (a: number | null, b: number, tol = 1e-3) => assert.ok(a !== null && Math.abs(a - b) <= tol, `${a} ≉ ${b}`);

// Two fiscal years plus ten months; every month identical so annual totals are easy to check.
function months(from: string, n: number): MonthData[] {
  return Array.from({ length: n }, (_, k) => ({ period: addMonths(from, k), ownerAdj: c(1000), status: 'approved' as const, bs: null,
    pnl: { ...zeroPnl(), revenue: c(400000), cogs: c(200000), direct_labor: c(100000), mgmt_labor: c(50000), other_opex: c(30000), depreciation: c(9000), interest_expense: c(3500) } }));
}
const hist = (): LoanHistory => loanHistory(months('2024-01', 34), DEFAULT_SETTINGS);
const allChecked = (items: { key: string }[]) => Object.fromEntries(items.map((x) => [x.key, true]));
const input = (p: Partial<LoanInput> = {}): LoanInput => ({ ...defaultLoanInput(), program: 'sba7a', purpose: 'equipment', amountCents: c(950000), rate: 0.10, termYears: 10, yearsInBusiness: 8,
  debts: [{ name: 'Truck loans', balanceCents: c(142000), monthlyCents: c(3800), refinanced: false }, { name: 'Equipment note', balanceCents: c(88000), monthlyCents: c(2200), refinanced: false }],
  uses: [{ description: 'Excavator', amountCents: c(950000) }], ...p });

test('loan payment and the loan a payment supports are inverses', () => {
  assert.equal(monthlyPayment(c(950000), 0.10, 10), c(12554.32));
  assert.equal(monthlyPayment(c(120000), 0, 10), c(1000));
  near(principalFor(c(12554.32), 0.10, 10) / 100, 950000, 1);
});

test('SBA 7(a) maximum rates by loan size, Prime 7%', () => {
  near(sbaMaxRate(c(50000), 'variable'), 0.135, 1e-9); near(sbaMaxRate(c(200000), 'variable'), 0.13, 1e-9);
  near(sbaMaxRate(c(300000), 'variable'), 0.115, 1e-9); near(sbaMaxRate(c(950000), 'variable'), 0.10, 1e-9);
  near(sbaMaxRate(c(20000), 'fixed'), 0.15, 1e-9); near(sbaMaxRate(c(950000), 'fixed'), 0.12, 1e-9);
});

test('history: last two complete fiscal years and the trailing twelve months, pretax as reported', () => {
  const h = hist();
  assert.deepEqual(h.columns.map((x) => [x.label, x.months, x.complete]), [['FY2024', 12, true], ['FY2025', 12, true], ['TTM Oct 2026', 12, true]]);
  // pretax per month 400k−200k−100k−50k−30k−9k−3.5k = 7.5k; owner adjustment is NOT deducted
  assert.equal(h.columns[1].pretaxCents, c(90000)); assert.equal(h.columns[1].interestCents, c(42000)); assert.equal(h.columns[1].depreciationCents, c(108000));
  const fy = loanHistory(months('2024-01', 34), { ...DEFAULT_SETTINGS, fiscalYearStartMonth: 7 });
  assert.equal(fy.columns[1].label, 'FY ending Jun 2026'); assert.equal(fy.columns[1].to, '2026-06');
});

test('DSCR uses EBITDA over P&I on all business debt including the new loan', () => {
  const r = evaluateLoan(input(), hist());
  // EBITDA FY2025 = 90k + 42k + 108k = 240k; debt service = 12,554.32×12 + 6,000×12 = 222,651.84
  assert.equal(r.basis.ebitdaCents, c(240000)); assert.equal(r.debtServiceCents, c(150651.84) + c(72000));
  near(r.dscr, 240000 / 222651.84); assert.equal(r.rule.target, 1.15);
  assert.ok(r.dscr! < 1.15 && r.gaps.some((g) => /below the 1.15x/.test(g.text)));
  // the largest supportable loan brings coverage back to the floor
  const at = evaluateLoan(input({ amountCents: r.maxLoanCents! }), hist()); near(at.dscr, 1.15, 0.002);
  // refinancing a debt removes it from debt service
  const refi = evaluateLoan(input({ debts: input().debts.map((d) => ({ ...d, refinanced: true })) }), hist()); assert.equal(refi.existingAnnualCents, 0);
});

test('change-of-ownership rules: 1.25x on history only, 10% equity with seller debt capped at half', () => {
  assert.equal(dscrRule({ program: 'sba7a', purpose: 'acquisition', amountCents: c(900000) }).target, 1.25);
  assert.equal(dscrRule({ program: 'sba7a', purpose: 'expansion', amountCents: c(900000) }).target, 1.15);
  assert.equal(dscrRule({ program: 'sba7a', purpose: 'working', amountCents: c(200000) }).target, 1.15);
  const r = evaluateLoan(input({ purpose: 'acquisition', basis: 'proj', projection: { label: 'Y1', revenueCents: c(5e6), ebitdaCents: c(900000) }, sources: { equityCents: c(20000), sellerStandbyCents: c(80000), otherCents: 0 } }), hist());
  assert.equal(r.basis.key, 'fy_last', 'projections cannot be used for an acquisition');
  assert.equal(r.equity.requiredCents, c(95000)); assert.equal(r.equity.sellerCountedCents, c(47500)); assert.equal(r.equity.countedCents, c(67500)); assert.equal(r.equity.met, false);
  assert.equal(evaluateLoan(input(), hist()).equity.pct, 0, 'an existing business buying equipment has no SBA-mandated injection');
});

test('program fit: 504 refuses working capital, Express and Microloan limits, quoted rate over the SBA cap', () => {
  const r = evaluateLoan(input({ uses: [{ description: 'Excavator', amountCents: c(750000) }, { description: 'Working capital', amountCents: c(200000) }] }), hist());
  const p = (k: string) => r.programs.find((x) => x.key === k)!;
  assert.equal(p('cdc504').fit, false); assert.equal(p('express').fit, false); assert.equal(p('micro').fit, false); assert.equal(p('sba7a').fit, true);
  assert.equal(r.recommended, 'sba7a'); assert.equal(p('sba7a').guaranty, 0.75);
  const fixedOnly = evaluateLoan(input(), hist()); assert.equal(fixedOnly.recommended, 'cdc504', 'large equipment-only request fits 504 best');
  const high = evaluateLoan(input({ rate: 0.115 }), hist()); assert.ok(high.gaps.some((g) => /above the SBA maximum/.test(g.text)));
});

test('readiness score: a missing SBA eligibility requirement caps the score; a complete file scores high', () => {
  const full = input({ amountCents: c(600000), uses: [{ description: 'Excavator', amountCents: c(600000) }], eligibility: allChecked(ELIGIBILITY), docs: allChecked(LOAN_DOCS),
    plan: Object.fromEntries(PLAN_SECTIONS.map((s) => [s.key, 'x'.repeat(100)])), collateral: [{ type: 'Equipment / vehicles', description: 'Excavator', valueCents: c(1400000) }],
    guarantor: { incomeCents: c(120000), livingCents: c(60000), debtMonthlyCents: c(2000), creditScore: 720, liquidCents: c(100000) } });
  const r = evaluateLoan(full, hist());
  assert.ok(r.dscr! >= 1.25, `dscr ${r.dscr}`); assert.ok(r.score >= 85, `score ${r.score}`); assert.equal(r.status.label, 'Lender-ready');
  const blocked = evaluateLoan({ ...full, eligibility: { ...full.eligibility, citizen: false } }, hist());
  assert.ok(blocked.score <= 49); assert.equal(blocked.status.label, 'Not eligible yet'); assert.match(blocked.gaps[0].text, /citizens/);
});

test('no imported data: hand-entered columns are used, and nothing is invented', () => {
  const empty = loanHistory([], DEFAULT_SETTINGS);
  const none = evaluateLoan(input(), empty); assert.equal(none.dscr, null); assert.equal(none.maxLoanCents, null); assert.ok(none.gaps.some((g) => /No earnings on file/.test(g.text)));
  const manual = evaluateLoan(input({ manual: { fy_prev: { revenueCents: 0, ebitdaCents: 0 }, fy_last: { revenueCents: c(4e6), ebitdaCents: c(300000) }, ttm: { revenueCents: 0, ebitdaCents: 0 } }, addbacks: { fy_prev: 0, fy_last: c(25000), ttm: 0 } }), empty);
  assert.equal(manual.basis.ebitdaCents, c(325000)); assert.equal(manual.columns[1].source, 'entered');
});

test('an existing business with history on file is not treated as a startup', () => {
  const r = evaluateLoan(input({ yearsInBusiness: 0, purpose: 'working', uses: [{ description: 'Working capital', amountCents: c(950000) }] }), hist());
  assert.equal(r.basis.key, 'fy_last'); assert.ok(r.dscr !== null); assert.equal(r.equity.pct, 0);
  const s = evaluateLoan(input({ purpose: 'startup', projection: { label: 'Y1', revenueCents: c(1e6), ebitdaCents: c(250000) } }), hist());
  assert.equal(s.basis.key, 'proj'); assert.equal(s.equity.pct, 0.10);
});
