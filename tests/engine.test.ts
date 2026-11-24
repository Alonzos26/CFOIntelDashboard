// Calculation tests. Expected values are the cached results in the source workbooks, so the engine is
// verified against the spreadsheets it replaces (figures typed here are from the generic templates, not client data).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sweatEquity, DEFAULT_SETTINGS, type MonthData, addMonths, bsImbalance, cashFlowMonth, computePnl, coreCapital, dso, mergeSettings, rolling12, ytd, zeroBs, zeroPnl } from '../src/engine/core.ts';
import { buildScorecard, gradeAttainment } from '../src/engine/scorecard.ts';
import { costOfHire, defaultHiringInputs, evaluateHire, productivity, type HiringBaseline } from '../src/engine/hiring.ts';
import { forecast13, occurrences, weekStart, type CashItem } from '../src/engine/cash.ts';
import { weeklyRows } from '../src/engine/weekly.ts';
import { evaluateFormula, formulaVariables, parseFormula, FormulaError } from '../src/engine/kpi.ts';
import { profitPlan } from '../src/engine/profitplan.ts';

const c = (dollars: number) => Math.round(dollars * 100);
const near = (a: number | null, b: number, tol = 1e-4) => assert.ok(a !== null && Math.abs(a - b) <= tol, `${a} ≉ ${b}`);
const template = () => ({ ...zeroPnl(), revenue: c(121229.96), cogs: c(58069.52), direct_labor: c(34736.03), facilities: c(880.9), mgmt_labor: c(7612.5), payroll_taxes_benefits: c(3497.38), other_income_expense: c(-1940.31) });

test('management P&L matches Financial-Reporting-Formats.xlsx', () => {
  const p = computePnl(template(), 0, DEFAULT_SETTINGS);
  assert.equal(p.grossProfit, c(63160.44)); near(p.grossMarginPct.value, 0.5209969548781507);
  assert.equal(p.contributionMargin, c(28424.41)); near(p.dLER.value, 1.8182976005029938); near(p.mLER.value, 3.7339126436781624);
  assert.equal(p.totalOpex, c(11990.78)); assert.equal(p.operatingIncome, c(16433.63)); assert.equal(p.pretax, c(14493.32)); near(p.pretaxPct.value, 0.11955229548867302);
});

test('salary cap, true profit and adjusted LER match the CF model (PL by Month rows 43–56)', () => {
  const p = computePnl(template(), c(17387.5), DEFAULT_SETTINGS);
  assert.ok(Math.abs(p.salaryCap - c(44718.854)) <= 1); assert.ok(Math.abs(p.salaryCapHeadroom - c(-15017.176)) <= 1);
  assert.equal(p.adjustedPretax, c(-2894.18)); near(p.tLER.value, 1.491443504650575); near(p.adjustedLER.value, 63160.44 / 59736.03);
});

test('at the salary cap, pretax profit equals the target exactly', () => {
  const l = template(); const p = computePnl(l, 0, DEFAULT_SETTINGS);
  const atCap = computePnl({ ...l, direct_labor: p.salaryCap - l.mgmt_labor }, 0, DEFAULT_SETTINGS);
  assert.ok(Math.abs(atCap.pretax - Math.round(l.revenue * 0.1)) <= 1);
});

test('payroll burden is counted once under either treatment', () => {
  const l = template(); const asLabor = mergeSettings({ burdenTreatment: 'labor' });
  const a = computePnl(l, 0, DEFAULT_SETTINGS), b = computePnl(l, 0, asLabor);
  assert.equal(a.pretax, b.pretax); assert.equal(b.totalLabor - a.totalLabor, l.payroll_taxes_benefits);
  assert.equal(a.salaryCapHeadroom, b.salaryCapHeadroom); // moving burden between buckets never changes headroom
});

test('undefined ratios are N/A with a reason, never infinity or zero', () => {
  const p = computePnl({ ...template(), mgmt_labor: 0, revenue: 0, cogs: 0 }, 0, DEFAULT_SETTINGS);
  assert.equal(p.mLER.value, null); assert.match(p.mLER.reason!, /no management labor/); assert.equal(p.grossMarginPct.value, null);
});

const series = (n: number, withBs = true): MonthData[] => Array.from({ length: n }, (_, i) => ({ period: addMonths('2024-01', i), pnl: { ...zeroPnl(), revenue: c(100000), cogs: c(40000), direct_labor: c(30000), facilities: c(5000), mgmt_labor: c(8000) }, bs: withBs ? { ...zeroBs(), cash: c(90000), accounts_receivable: c(150000), line_of_credit: c(10000), equity: c(230000) } : null, ownerAdj: c(2000), status: 'approved' as const }));

test('rolling 12 flags incomplete windows and sums complete ones', () => {
  const m = series(14);
  assert.equal(rolling12(m, 5, DEFAULT_SETTINGS)!.complete, false); assert.equal(rolling12(m, 5, DEFAULT_SETTINGS)!.monthsIncluded, 6);
  const r = rolling12(m, 13, DEFAULT_SETTINGS)!; assert.equal(r.complete, true); assert.equal(r.lines.revenue, c(1_200_000)); assert.equal(r.ownerAdj, c(24000));
  assert.equal(ytd(m, 13, DEFAULT_SETTINGS)!.monthsIncluded, 2);
});

test('DSO uses the last two months of sales (BS!55) and is N/A without receivables', () => {
  const m = series(3); near(dso(m, 2, DEFAULT_SETTINGS).value, 150000 / (200000 / 60));
  m[2].bs!.accounts_receivable = 0; assert.equal(dso(m, 2, DEFAULT_SETTINGS).value, null);
  assert.equal(dso(series(3, false), 2, DEFAULT_SETTINGS).value, null);
});

test('core capital nets the line of credit and uses the configured basis', () => {
  const cc = coreCapital(series(12), 11, DEFAULT_SETTINGS);
  // Default: two months of operating expenses and direct labor (13,000 + 30,000 a month); non-labor COGS excluded.
  assert.equal(cc.available, c(80000)); assert.equal(cc.monthlyBasis, c(43000)); assert.equal(cc.target, c(86000)); assert.equal(cc.surplus, c(-6000));
  assert.equal(coreCapital(series(12), 11, mergeSettings({ coreCapitalExcludeCogs: false })).target, c(166000));
});

test('cash flow reconciles to the balance sheet and reports (not hides) a difference', () => {
  const prev = { ...zeroBs(), cash: c(50000), accounts_receivable: c(20000), equity: c(70000) };
  const pnl = { ...zeroPnl(), revenue: c(30000), cogs: c(10000) };
  const cur = { ...zeroBs(), cash: c(65000), accounts_receivable: c(25000), equity: c(90000) };
  const cf = cashFlowMonth(prev, cur, pnl); assert.equal(cf.operations, c(15000)); assert.equal(cf.difference, 0); assert.equal(bsImbalance(cur), 0);
  const bad = cashFlowMonth(prev, { ...cur, cash: c(66000) }, pnl); assert.equal(bad.difference, c(-1000));
});

test('scorecard grades follow configurable thresholds', () => {
  assert.equal(gradeAttainment(1.6, { great: 1.5, good: 1, ok: 0.5 }), 'Great'); assert.equal(gradeAttainment(0.49, { great: 1.5, good: 1, ok: 0.5 }), 'Caution'); assert.equal(gradeAttainment(null, { great: 1.5, good: 1, ok: 0.5 }), 'N/A');
  const sc = buildScorecard(series(15), 14, mergeSettings({ dlerTarget: 2.0 }))!;
  const by = Object.fromEntries(sc.measures.map((x) => [x.key, x]));
  near(by.profitability.actual, 0.15); assert.equal(by.profitability.grade, 'Great'); assert.equal(by.labor.grade, 'Good'); assert.equal(by.opex.grade, 'N/A'); assert.match(by.opex.note!, /No operating expense target/);
});

test('hire cost applies wage bases to ANNUAL wages (corrects the hourly worksheet)', () => {
  const i = { ...defaultHiringInputs('2026-01'), annualSalaryCents: c(250000), taxes: [{ name: 'SS', rate: 0.062, wageBaseCents: c(184500) }, { name: 'Medicare', rate: 0.0145, wageBaseCents: null }, { name: 'FUTA', rate: 0.006, wageBaseCents: c(7000) }], workersCompPct: 0, healthMonthlyCents: 0, retirementMatchPct: 0, softwareMonthlyCents: 0 };
  const k = costOfHire(i); assert.equal(k.annualTaxesCents, c(184500 * 0.062 + 250000 * 0.0145 + 42));
  const contractor = costOfHire({ ...i, workerType: 'contractor_hourly', hourlyRateCents: c(60), hoursPerWeek: 20 });
  assert.equal(contractor.annualTaxesCents, 0); assert.equal(contractor.annualWagesCents, c(60 * 20 * 52)); assert.equal(contractor.annualBenefitsCents, 0);
  assert.equal(k.firstMonthCents, k.monthlyLoadedCents + k.oneTimeCents); // one-time costs counted once (source summary double-counted)
});

test('hiring scenario: break-even, target-holding gross profit, ramp, cash and guardrail', () => {
  const pnl = { ...zeroPnl(), revenue: c(100000), cogs: c(40000), direct_labor: c(30000), facilities: c(5000), mgmt_labor: c(8000) };
  const b: HiringBaseline = { asOf: '2025-12', months: Array.from({ length: 24 }, (_, k) => ({ period: addMonths('2025-12', k + 1), pnl })), ownerAdjMonthlyCents: 0, startingCashCents: c(100000), nonPnlCashOutMonthlyCents: c(5000), collectionLagMonths: 1, coreCapitalTargetCents: c(60000) };
  const i = { ...defaultHiringInputs('2026-03'), expectedMonthlyRevenueCents: c(20000), trainingMonths: 1, rampMonths: 1 };
  const r = evaluateHire(i, b, DEFAULT_SETTINGS); const C = r.netMonthlyCostCents;
  assert.equal(r.breakEvenGrossProfitCents, C); assert.equal(r.breakEvenRevenueCents, Math.round(C / 0.6)); assert.equal(r.revenueToHoldTargetCents, Math.round(C / 0.5));
  assert.deepEqual([0, 1, 2].map((k) => productivity(k, i)), [0, 0.5, 1]);
  assert.equal(r.timeline[1].active, false); assert.equal(r.timeline[2].active, true); assert.equal(r.timeline[2].costCents, C + r.cost.oneTimeCents);
  assert.equal(r.timeline[1].baselineCashCents, c(100000 + 2 * 12000)); // baseline pretax 17k − 5k non-P&L cash
  // first productive month's sales are collected one month later
  assert.equal(r.timeline[3].scenarioCashCents! - r.timeline[2].scenarioCashCents!, c(12000) - C - c(10000 * 0.4));
  assert.equal(r.scenario.pretax - r.baseline.pretax, r.profitImpact12Cents);
  assert.ok(r.scenario.dLER.value! < r.baseline.dLER.value! + 1); assert.equal(r.guardrailBreached, false); assert.equal(r.earliestSupportableStart, '2026-01');
  const tight = evaluateHire({ ...i, guardrailMinCashCents: c(10_000_000) }, b, DEFAULT_SETTINGS); assert.equal(tight.earliestSupportableStart, null); assert.equal(tight.guardrailBreached, true);
  assert.equal(evaluateHire(i, { ...b, startingCashCents: null }, DEFAULT_SETTINGS).earliestSupportableStart, null);
});

const item = (o: Partial<CashItem>): CashItem => ({ id: o.name ?? 'x', name: 'x', direction: 'out', category: 'vendor', amountCents: 0, cadence: 'once', anchorDate: '2025-12-01', endDate: null, secondDay: null, active: true, ...o });
test('cash rhythms expand on the right dates', () => {
  assert.deepEqual(occurrences(item({ cadence: 'biweekly', anchorDate: '2026-01-02' }), '2026-01-01', '2026-02-10'), ['2026-01-02', '2026-01-16', '2026-01-30']);
  assert.deepEqual(occurrences(item({ cadence: 'monthly', anchorDate: '2026-01-31' }), '2026-01-01', '2026-04-30'), ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
  assert.deepEqual(occurrences(item({ cadence: 'semimonthly', anchorDate: '2026-01-05', secondDay: 20 }), '2026-01-01', '2026-02-06'), ['2026-01-05', '2026-01-20', '2026-02-05']);
  assert.deepEqual(occurrences(item({ cadence: 'quarterly', anchorDate: '2026-01-15' }), '2026-01-01', '2026-08-01'), ['2026-01-15', '2026-04-15', '2026-07-15']);
  assert.equal(weekStart('2026-11-17', 1), '2026-11-16'); assert.equal(weekStart('2026-11-17', 0), '2026-11-15');
});

test('13-week forecast reproduces the Weekly CF template and what-if delays', () => {
  const items = [item({ name: 'deposits', direction: 'in', amountCents: c(27000), anchorDate: '2025-12-03' }), item({ name: 'bills1', amountCents: c(1000), anchorDate: '2025-12-04' }), item({ name: 'rent', amountCents: c(25000), anchorDate: '2025-12-05' }), item({ name: 'payroll', amountCents: c(15000), anchorDate: '2025-12-05' }), item({ name: 'bills2', amountCents: c(3000), anchorDate: '2025-12-10' })];
  const f = forecast13('2025-12-01', c(50000), items, c(35000));
  assert.equal(f.weeks[0].endCents, c(36000)); assert.equal(f.weeks[1].endCents, c(33000)); assert.equal(f.weeks.length, 13); assert.equal(f.weeks[1].belowFloor, true); assert.equal(f.lowestCents, c(33000));
  const late = forecast13('2025-12-01', c(50000), items, c(35000), { delays: [{ itemId: 'deposits', days: 30 }] });
  assert.equal(late.weeks[0].endCents, c(9000)); assert.equal(late.weeks[4].endCents, c(33000)); assert.equal(late.endCents, f.endCents);
});

test('weekly GM and LER tracking matches the weekly template', () => {
  const s = mergeSettings({ dlerTarget: 2.25, weeklyGpTargetCents: c(50000) });
  const rows = weeklyRows([[75000, 22500], [85000, 25000], [72500, 20500]].map(([rev, dl], i) => ({ weekStart: `2026-03-${String(2 + i * 7).padStart(2, '0')}`, revenueCents: c(rev), cogsCents: c(rev * 0.35), directLaborCents: c(dl), cashBalanceCents: null, source: 't' })), s);
  near(rows[0].dLER.value, 2.1666666667); assert.equal(rows[0].gpOverUnderCents, c(-1250)); assert.equal(rows[1].gpRollingOverUnderCents, c(4000)); assert.equal(rows[2].gpRollingOverUnderCents, c(1125));
  assert.equal(rows[0].targetLaborSpendCents, c(21666.67)); assert.equal(rows[0].laborOverUnderCents, c(833.33)); assert.equal(rows[2].laborRollingOverUnderCents, c(833.33));
  near(rows[2].mtdLER.value, (48750 + 55250 + 47125) / 68000);
});

test('KPI formula engine is safe: arithmetic only, no code execution', () => {
  assert.equal(evaluateFormula('(cogs + total_labor) / revenue', { cogs: 30, total_labor: 30, revenue: 100 }).value, 0.6);
  assert.equal(evaluateFormula('max(a, b) - round(2.567, 1)', { a: 3, b: 5 }).value, 2.4);
  assert.deepEqual(formulaVariables('billable_hours / available_hours').sort(), ['available_hours', 'billable_hours']);
  assert.equal(evaluateFormula('a / b', { a: 1, b: 0 }).value, null); assert.match(evaluateFormula('a / b', { a: 1, b: 0 }).reason!, /divides by zero/);
  assert.deepEqual(evaluateFormula('a / hours', { a: 1 }).missing, ['hours']);
  for (const bad of ['process.exit(1)', 'a.b', 'require("fs")', 'a; b', 'x = 1', '1 +', 'constructor()', 'a[0]', '`x`', 'eval(1)', '((((((((((((((((((((((((((((((((1))))))))))))))))))))))))))))))))']) assert.throws(() => parseFormula(bad), FormulaError, bad);
});

test('profit needs matches the Profit Planning Worksheet', () => {
  const r12 = rolling12(series(12), 11, DEFAULT_SETTINGS)!;
  const p = profitPlan({ debtPrincipalCents: c(45000), assetPurchasesCents: 0, savingsGoalCents: c(25000), ownerDistributionsCents: c(60000), estimatedTaxRate: 0.25, marketOwnerPayCents: 0 }, r12);
  assert.equal(p.cashUsesCents, c(130000)); assert.equal(p.requiredPretaxCents, c(173333.33)); assert.equal(p.taxReserveCents, c(43333.33));
  assert.equal(p.gapCents, Math.max(0, p.requiredPretaxCents - r12.adjustedPretax));
  const reach = computePnl({ ...r12.lines, revenue: p.requiredRevenueCents!, cogs: Math.round(r12.lines.cogs * p.requiredRevenueCents! / r12.lines.revenue), direct_labor: Math.round(r12.lines.direct_labor * p.requiredRevenueCents! / r12.lines.revenue) }, r12.ownerAdj, DEFAULT_SETTINGS);
  assert.ok(Math.abs(reach.adjustedPretax - p.requiredPretaxCents) < 500); // the solved revenue actually produces the required profit
});

test('sweat equity: underpay accrues, distributions reduce it, never below zero', () => {
  const pnl = { ...zeroPnl(), revenue: c(50000), cogs: c(20000) }; // pretax 30,000 a month
  const eq = [100000, 130000, 125000, 155000, 115000]; // month 3: 35,000 distributed; month 5: 70,000 distributed
  const m: MonthData[] = eq.map((e, i) => ({ period: addMonths('2026-01', i), pnl, bs: { ...zeroBs(), cash: c(e), equity: c(e) }, ownerAdj: c(10000), status: 'approved' as const }));
  const r = sweatEquity(m);
  assert.equal(r[0].distributionSource, 'unavailable'); assert.deepEqual(r.map((x) => x.distributions), [null, 0, c(35000), 0, c(70000)]);
  assert.deepEqual(r.map((x) => x.balance), [c(10000), c(20000), 0, c(10000), 0]);
  assert.deepEqual(r.map((x) => x.excessDistributions), [0, 0, c(5000), 0, c(50000)]);
  const entered = sweatEquity(m, { '2026-03': c(4000) }); assert.equal(entered[2].distributionSource, 'entered'); assert.equal(entered[2].balance, c(26000));
  const overpaid = sweatEquity(m.map((x) => ({ ...x, bs: null, ownerAdj: x.period === '2026-03' ? c(-15000) : c(10000) }))); assert.deepEqual(overpaid.map((x) => x.balance), [c(10000), c(20000), c(5000), c(15000), c(25000)]);
});

test('owner market-wage plan: cost, market and income approaches, gap, S-corp and documentation checks', async () => {
  const { evaluateWagePlan, blankOwner } = await import('../src/engine/ownerwage.ts');
  const ctx = { today: '2026-11-17', r12HeadroomCents: c(-20000), r12OwnerAdjCents: c(54000), pretaxTargetPct: 0.1 };
  const owner = { ...blankOwner(), name: 'A', approach: 'cost' as const, roles: [{ title: 'General manager', hoursPerYear: 1200, hourlyWageCents: c(60), source: 'BLS OEWS', sourceDate: '2026-05-01' }, { title: 'Estimator', hoursPerYear: 800, hourlyWageCents: c(40), source: 'BLS OEWS', sourceDate: '2026-05-01' }], actualW2AnnualCents: c(50000), plannedDistributionsAnnualCents: c(30000) };
  const r = evaluateWagePlan({ year: 2026, isSCorp: true, analysisDate: '2026-06-01', owners: [owner] }, ctx);
  assert.equal(r.owners[0].reasonableAnnualCents, c(104000)); assert.equal(r.owners[0].totalHours, 2000); assert.equal(r.owners[0].blendedHourlyCents, c(52));
  assert.equal(r.totalGapAnnualCents, c(54000)); assert.equal(r.monthlyAdjustmentCents, c(4500)); assert.equal(r.documentationComplete, true);
  assert.ok(r.owners[0].warnings.some((w) => /before distributions/.test(w))); assert.match(r.affordability!, /\$20,000 over the salary cap/);
  const notS = evaluateWagePlan({ year: 2026, isSCorp: false, analysisDate: '2026-06-01', owners: [owner] }, ctx); assert.ok(!notS.owners[0].warnings.some((w) => /before distributions/.test(w)));
  const weak = evaluateWagePlan({ year: 2025, isSCorp: true, analysisDate: '2025-01-15', owners: [{ ...blankOwner(), name: 'B', approach: 'market', marketTitle: 'Dentist', marketAnnualCents: c(180000), marketSource: 'Glassdoor', marketSourceDate: '2025-01-01', actualW2AnnualCents: c(200000) }, { ...blankOwner(), name: 'C', approach: 'income', incomeAnnualCents: c(90000) }] }, { ...ctx, r12HeadroomCents: c(50000), r12OwnerAdjCents: 0 });
  assert.equal(weak.owners[0].gapAnnualCents, c(-20000)); assert.ok(weak.owners[0].warnings.some((w) => /biased/.test(w))); assert.equal(weak.documentationComplete, false);
  assert.ok(weak.flags.some((f) => /more than a year ago/.test(f.text))); assert.equal(weak.totalGapAnnualCents, c(70000)); assert.match(weak.affordability!, /\$20,000 over/);
});

test('four forces of cash flow: the worked example (taxes, debt, core capital, then distributions)', async () => {
  const { fourForces, cashWalk, nextEstimatedTaxDate } = await import('../src/engine/fourforces.ts');
  // Cash available $225,000 = $100,000 beginning + $125,000 pretax; 40% tax; $50,000 debt; $100,000 core capital target -> $25,000 distributable.
  const base = { cashCents: c(225000), locCents: 0, pretaxYtdCents: c(125000), taxRate: 0.4, taxesPaidYtdCents: 0, scheduledDebtCents: c(50000), coreCapitalTargetCents: c(100000), avgMonthlyPretaxCents: c(10000), distributionsYtdCents: 0 };
  const f = fourForces(base);
  assert.deepEqual(f.steps.map((x) => x.needCents), [c(50000), 0, c(50000), c(100000), 0]); assert.equal(f.steps[2].remainingCents, c(125000)); assert.equal(f.availableForDistributionCents, c(25000)); assert.equal(f.shortfallCents, 0);
  // Spending $100,000 first (vehicle + condo) leaves the core capital target $75,000 short and nothing to distribute.
  const spent = fourForces({ ...base, cashCents: c(125000), distributionsYtdCents: c(50000) });
  assert.equal(spent.availableForDistributionCents, 0); assert.equal(spent.shortfallCents, c(75000)); assert.equal(spent.steps[3].fundedCents, c(25000));
  assert.ok(Math.abs(spent.monthsOfProfitToFund! - 12.5) < 1e-9, 'only 60% of profit is retained after tax'); assert.ok(spent.flags.some((x) => /distributions have been taken/.test(x.text)));
  assert.equal(fourForces({ ...base, taxesPaidYtdCents: c(50000) }).availableForDistributionCents, c(75000)); assert.equal(fourForces({ ...base, locCents: c(30000) }).availableForDistributionCents, 0);
  assert.equal(fourForces({ ...base, pretaxYtdCents: c(-20000) }).taxReserveNeededCents, 0);
  // A projection from tax planning replaces rate x profit, in either direction, and is reserved in full less what has been paid.
  assert.equal(fourForces({ ...base, projectedTaxCents: c(80000) }).taxReserveNeededCents, c(80000)); assert.equal(fourForces({ ...base, projectedTaxCents: c(80000) }).availableForDistributionCents, 0);
  assert.equal(fourForces({ ...base, projectedTaxCents: c(30000), taxesPaidYtdCents: c(10000) }).availableForDistributionCents, c(55000)); assert.equal(fourForces({ ...base, projectedTaxCents: 0 }).taxReserveNeededCents, 0);
  assert.match(fourForces({ ...base, projectedTaxCents: c(80000) }).steps[0].note, /from tax planning/);
  // Where did the cash go: $100,000 + $125,000 profit - $50,000 vehicle - $50,000 principal - $100,000 out to the owner (tax + condo) = $25,000.
  const pnl = { ...zeroPnl(), revenue: c(1000000), cogs: c(875000) };
  const m: MonthData[] = [{ period: '2025-12', pnl: zeroPnl(), bs: { ...zeroBs(), cash: c(100000), notes_payable: c(80000), equity: c(20000) }, ownerAdj: 0, status: 'approved' }, { period: '2026-01', pnl, bs: { ...zeroBs(), cash: c(25000), fixed_assets: c(50000), notes_payable: c(30000), equity: c(45000) }, ownerAdj: 0, status: 'approved' }];
  const w = cashWalk(m, 1, 1)!; assert.equal(w.pretaxCents, c(125000)); assert.equal(w.assetPurchasesCents, c(-50000)); assert.equal(w.debtCents, c(-50000)); assert.equal(w.distributionsCents, c(-100000)); assert.equal(w.endingCashCents, c(25000)); assert.equal(w.differenceCents, 0);
  assert.equal(cashWalk(m, 0, 1), null); assert.equal(nextEstimatedTaxDate('2026-11-17'), '2027-01-15'); assert.equal(nextEstimatedTaxDate('2026-04-15'), '2026-04-15');
});

test('capital: return on investment, buy-in math (worked example) and sweat equity between owners', async () => {
  const { buyIn, capitalView } = await import('../src/engine/capital.ts'); const { evaluateWagePlan, blankOwner } = await import('../src/engine/ownerwage.ts'); const { forecast13, twoWeekView } = await import('../src/engine/cash.ts');
  // $1M revenue, $150,000 pretax, $300,000 equity: value = 3 x profit + equity = $750,000; 40% discount; $50,000 bonus nets $30,000.
  const r = buyIn({ grossBonusCents: c(50000), bonusTaxRate: 0.4, avgPretaxCents: c(150000), equityCents: c(300000), profitMultiple: 3, discountPct: 0.4, sharesOutstanding: 750000, ownerTaxRate: 0.4 });
  assert.equal(r.businessValueCents, c(750000)); near(r.pricePerShareCents, 100); near(r.discountedPriceCents, 60); assert.equal(r.netInvestmentCents, c(30000)); near(r.sharesPurchased, 50000, 1e-6); near(r.totalShares, 800000, 1e-6); near(r.buyerOwnership, 0.0625);
  assert.equal(r.buyer.profitCents, c(9375)); assert.equal(r.buyer.taxDistributionCents, c(3750)); assert.equal(r.buyer.profitDistributionCents, c(5625)); near(r.buyer.roi.value, 0.3125);
  assert.equal(r.original.profitCents, c(140625)); assert.equal(r.original.taxDistributionCents, c(56250)); assert.equal(r.original.profitDistributionCents, c(84375)); near(r.original.roi.value, 0.46875);
  // Return on investment = pretax profit / equity; debt is reported beside capital, not in it.
  const cv = capitalView({ equityCents: c(1300000), locCents: 0, notesCents: 0, sweatEquityCents: 0, pretax12Cents: c(620000), complete: true }); near(cv.returnOnEquity.value, 620 / 1300); assert.equal(cv.debtCents, 0);
  assert.equal(capitalView({ equityCents: c(-5000), locCents: c(40000), notesCents: 0, sweatEquityCents: 0, pretax12Cents: c(10000), complete: true }).returnOnEquity.value, null);
  assert.equal(capitalView({ equityCents: c(50000), locCents: c(40000), notesCents: c(60000), sweatEquityCents: 0, pretax12Cents: c(10000), complete: true }).notes.length, 2);
  // Two equal owners, both worth $100,000; one is paid $100,000 and the other $50,000: the second has put in $25,000 more than her half each year.
  const o = (name: string, paid: number) => ({ ...blankOwner(), name, ownershipPct: 0.5, approach: 'market' as const, marketTitle: 'Partner', marketAnnualCents: c(100000), marketSource: 'BLS', marketSourceDate: '2026-01-01', actualW2AnnualCents: c(paid) });
  const w = evaluateWagePlan({ year: 2026, isSCorp: true, analysisDate: '2026-06-01', owners: [o('John', 100000), o('Mary', 50000)] }, { today: '2026-11-18', r12HeadroomCents: null, r12OwnerAdjCents: null, pretaxTargetPct: 0.1 });
  assert.deepEqual(w.owners.map((x) => x.sweatDifferentialCents), [c(-25000), c(25000)]); assert.ok(w.flags.some((f) => /Settle the difference at least once a year/.test(f.text)));
  assert.ok(evaluateWagePlan({ year: 2026, isSCorp: true, analysisDate: '2026-06-01', owners: [{ ...o('A', 100000), ownershipPct: 0.7 }, o('B', 50000)] }, { today: '2026-11-18', r12HeadroomCents: null, r12OwnerAdjCents: null, pretaxTargetPct: 0.1 }).flags.some((f) => /not 100%/.test(f.text)));
  // Two-week cash flow forecast report: payables grouped into a short list.
  const it = (name: string, category: string, cents: number, date: string, direction: 'in' | 'out' = 'out') => ({ id: name, name, direction, category, amountCents: c(cents), cadence: 'once' as const, anchorDate: date, endDate: null, secondDay: null, active: true });
  const tw = twoWeekView(forecast13('2026-05-25', c(96338.98), [it('bills', 'vendor', 6912.52, '2026-05-25'), it('cc', 'credit_card', 1013.25, '2026-05-25'), it('rent', 'rent', 9935, '2026-05-25'), it('payroll', 'payroll', 26002.24, '2026-05-25'), it('bills2', 'vendor', 738.59, '2026-06-01'), it('cc2', 'credit_card', 525, '2026-06-01'), it('loan', 'loan_payment', 2500, '2026-06-01'), it('tax', 'payroll_taxes', 8930.94, '2026-06-01'), it('401k', 'payroll_taxes', 1548.65, '2026-06-01')], 0));
  assert.deepEqual(tw.weeks.map((x) => x.payablesCents), [c(43863.01), c(14243.18)]); assert.equal(tw.weeks[0].payables.find((p) => p.group === 'General bills')!.cents, c(7925.77)); assert.equal(tw.weeks[1].payables.find((p) => p.group === 'Payroll taxes and benefits')!.cents, c(10479.59)); assert.equal(tw.weeks[1].endCents, c(96338.98 - 43863.01 - 14243.18));
});

test('reporting rhythms: sales and productivity report, rolling-twelve column, expense checks, report due day, bill-pay day', async () => {
  const R = await import('../src/engine/reporting.ts'); const { forecast13 } = await import('../src/engine/cash.ts'); const { zeroPnl, trailing, DEFAULT_SETTINGS } = await import('../src/engine/core.ts');
  const S = DEFAULT_SETTINGS; const mo = (period: string, l: Record<string, number>) => ({ period, pnl: { ...zeroPnl(), ...Object.fromEntries(Object.entries(l).map(([k, v]) => [k, c(v)])) }, bs: null, ownerAdj: 0, status: 'approved' as const });
  // Worked example: four closed months, then May by week. Gross profit is sales less non-labor direct costs; labor is all payroll.
  const months = [mo('2026-01', { revenue: 145000, cogs: 73225, mgmt_labor: 35000 }), mo('2026-02', { revenue: 154000, cogs: 75152, mgmt_labor: 37000 }), mo('2026-03', { revenue: 180000, cogs: 94320, mgmt_labor: 40000 }), mo('2026-04', { revenue: 190000, cogs: 94810, direct_labor: 30000, mgmt_labor: 12000 })];
  const wk = (d: string, sales: number, labor: number | null) => ({ weekStart: d, revenueCents: c(sales), cogsCents: c(sales / 2), directLaborCents: labor === null ? c(6000) : c(labor - 3000), otherLaborCents: labor === null ? null : c(3000) });
  const p = R.salesProductivity(months, [wk('2026-05-04', 40000, 10000), wk('2026-05-11', 38000, 9500), wk('2026-05-18', 35000, 11000)], S, 2)!;
  const two = (r: { value: number | null }) => Number(r.value!.toFixed(2));
  assert.deepEqual(p.rows.filter((r) => r.kind === 'month').map((r) => [two(r.mtdLER), two(r.ytdLER)]), [[2.05, 2.05], [2.13, 2.09], [2.14, 2.11], [2.27, 2.15]]);
  assert.deepEqual(p.rows.filter((r) => r.kind === 'week').map((r) => [two(r.weekLER!), two(r.mtdLER), two(r.ytdLER)]), [[2, 2, 2.14], [2, 2, 2.14], [1.59, 1.85, 2.1]]);
  const tot = p.rows.at(-1)!; assert.equal(tot.kind, 'month_total'); assert.deepEqual([tot.salesCents, tot.gpCents, tot.laborCents], [c(113000), c(56500), c(30500)]);
  // A $40,000 week at 50% leaves $20,000; at a 2.0 target that supports $10,000 of payroll. $11,000 on $17,500 is $2,250 over.
  assert.equal(p.rows.find((r) => r.key === '2026-05-04')!.supportedLaborCents, c(10000)); assert.equal(p.rows.find((r) => r.key === '2026-05-18')!.laborOverUnderCents, c(2250));
  // A week without office payroll is reported as not available rather than as a flattering direct-labor-only ratio.
  const q = R.salesProductivity(months, [wk('2026-05-04', 40000, 10000), wk('2026-05-11', 38000, null)], S, null)!; assert.equal(q.weeksMissingLabor, 1); assert.equal(q.rows.at(-1)!.mtdLER.value, null); assert.match(q.rows.at(-2)!.weekLER!.reason!, /not entered/); assert.equal(q.rows.find((r) => r.key === '2026-05-04')!.weekLER!.value, 2);
  // Rolling-twelve column: pretax below target by $149,500, salary cap $219,500, labor efficiency 1.43 against 2.40 needed.
  const a = R.r12Row(trailing([mo('2025-12', { revenue: 815000, cogs: 289000, mgmt_labor: 369000, marketing: 48000, facilities: 74000, payroll_taxes_benefits: 31000, other_opex: 72000 })], 0, 1, S)!, S);
  assert.deepEqual([a.grossProfit, a.pretax, a.targetCents, a.aboveBelowCents, a.salaryCap], [c(526000), c(-68000), c(81500), c(-149500), c(219500)]); assert.equal(two(a.ler), 1.43); assert.equal(two(a.lerTarget), 2.4);
  // $1.12M revenue at $106,000 pretax: 15% needs $62,000 more gross profit, about 8% more from the same staff.
  const b = R.r12Row(trailing([mo('2026-06', { revenue: 1120000, cogs: 320000, mgmt_labor: 416000, marketing: 50000, facilities: 89000, payroll_taxes_benefits: 46000, other_opex: 93000 })], 0, 1, S)!, S);
  assert.equal(b.pretax, c(106000)); assert.equal(b.additionalGpForStretchCents, c(62000)); near(b.productivityIncrease.value, 0.0775); assert.equal(R.wagesLerTarget(trailing([months[0]], 0, 1, S)!) !== null, true);
  assert.equal(R.rolling12Table(months, S).length, 0, 'never shows a window with fewer than twelve months');
  // Expense checks: payroll taxes out of proportion to payroll, a spike in other expenses, thin marketing.
  const steady = Array.from({ length: 12 }, (_, i) => mo(`2025-${String(i + 1).padStart(2, '0')}`, { revenue: 100000, cogs: 30000, mgmt_labor: 40000, payroll_taxes_benefits: 4000, facilities: 5000, other_opex: 6000, marketing: 1000 }));
  const odd = [...steady, mo('2026-01', { revenue: 100000, cogs: 30000, mgmt_labor: 40000, payroll_taxes_benefits: 7000, facilities: 5000, other_opex: 15000, marketing: 1000 })];
  const ch = Object.fromEntries(R.expenseChecks(odd, S).map((x) => [x.key, x])); assert.equal(ch.payroll_taxes_benefits.tone, 'warn'); assert.match(ch.payroll_taxes_benefits.text, /\$3,000 more/); assert.equal(ch.other_opex.tone, 'warn'); assert.deepEqual(ch.other_opex.spikeMonths, ['2026-01']); assert.equal(ch.facilities.tone, 'info'); assert.equal(ch.marketing.tone, 'warn');
  assert.ok(R.expenseChecks(steady, S).every((x) => x.key === 'marketing' || x.tone === 'info'));
  // Reports by the fifth.
  assert.deepEqual([R.reportRhythm('2026-11-18', 5, null).status, R.reportRhythm('2026-11-18', 5, null).days, R.reportRhythm('2026-11-18', 5, null).expectedPeriod], ['overdue', 13, '2026-10']);
  assert.equal(R.reportRhythm('2026-11-18', 5, '2026-11-04').status, 'on_time'); assert.deepEqual([R.reportRhythm('2026-11-18', 5, '2026-11-09').status, R.reportRhythm('2026-11-18', 5, '2026-11-09').days], ['late', 4]); assert.equal(R.reportRhythm('2026-01-03', 5, null).expectedPeriod, '2025-12'); assert.equal(R.reportRhythm('2026-01-03', 5, null).status, 'due');
  // Bill-pay day: a vendor bill due Thursday goes out the Monday before; payroll keeps its date; a bill due just past the window is pulled in.
  assert.equal(R.payDayOnOrBefore('2026-11-19', 1), '2026-11-16'); assert.equal(R.payDayOnOrBefore('2026-11-16', 1), '2026-11-16');
  const it = (id: string, category: string, date: string) => ({ id, name: id, direction: 'out' as const, category, amountCents: c(1000), cadence: 'once' as const, anchorDate: date, endDate: null, secondDay: null, active: true });
  const f = forecast13('2026-11-16', c(10000), [it('bill', 'vendor', '2026-11-26'), it('pay', 'payroll', '2026-11-27'), it('next', 'vendor', '2026-12-02')], 0, {}, 2, 1);
  assert.deepEqual(f.weeks[1].lines.map((l) => [l.name, l.date, l.dueDate]), [['bill', '2026-11-23', '2026-11-26'], ['pay', '2026-11-27', undefined]]); assert.equal(f.totalOut, c(2000));
  assert.equal(forecast13('2026-11-16', c(10000), [it('next', 'vendor', '2026-12-02')], 0, {}, 3, 1).weeks[2].lines[0].date, '2026-11-30');
  assert.equal(forecast13('2026-11-18', c(10000), [it('bill', 'vendor', '2026-11-20')], 0, {}, 1, 1).weeks[0].lines[0].date, '2026-11-18', 'a pay day already past is paid at the start of the forecast');
});

test('economic value: blended value, discounts, buyout note, years to repay, net-assets fallback (worked examples)', async () => {
  const { valuation, defaultValuation, annualPayment, yearsToRepay } = await import('../src/engine/valuation.ts'); const D = defaultValuation(0.4);
  // Company A, year five: last three years of profit $792,000 plus equity $613,500 = $1,405,500.
  const A = { pretaxCents: c(792000), monthsUsed: 36, pretax12Cents: c(300000), equityCents: c(613500), debtCents: 0, ebitda12Cents: c(300000), revenue12Cents: c(3000000), coreCapitalSurplusCents: c(163500), ownerWageApplied: true, asOf: '2026-12' };
  const a = valuation(A, D); assert.equal(a.method, 'blended'); assert.equal(a.valueCents, c(1405500)); assert.equal(a.estimated, false);
  // 20% for lack of marketability, then 20% for lack of control.
  assert.deepEqual([a.marketabilityDiscountCents, a.controlDiscountCents, a.discountedValueCents], [c(281100), c(224880), c(899520)]);
  near(a.impliedEbitdaMultiple.value, 4.685); near(a.impliedRevenueMultiple.value, 0.4685); // shown as 4.69 and 0.47
  // Half the business on the undiscounted value, paid over five years at 7% from after-tax profit: $12,994.19 short, -8.2%, a balanced deal.
  assert.equal(a.stakeBasis, 'undiscounted'); assert.equal(a.stakePriceCents, c(702750)); assert.equal(a.afterTaxAnnualCents, c(158400)); assert.equal(a.note.annualPaymentCents, c(171394.19)); assert.equal(a.note.excessCents, c(-12994.19)); assert.equal(Number((a.note.variance.value! * 100).toFixed(1)), -8.2); assert.equal(a.note.status, 'balanced');
  assert.equal(Number(a.yearsToRepayWhole.value!.toFixed(2)), 14.34); assert.ok(a.flags.some((f) => /longer than the ten years/.test(f.text)));
  // Company B at 15%: $1,870,750; the same buyout has $9,470.74 to spare (4.0%); the whole business repays in 11.84 years.
  const B = { ...A, pretaxCents: c(1188000), pretax12Cents: c(450000), equityCents: c(682750), ebitda12Cents: c(450000) }; const b = valuation(B, D);
  assert.equal(b.valueCents, c(1870750)); assert.equal(b.stakePriceCents, c(935375)); assert.equal(b.note.annualPaymentCents, c(228129.26)); assert.equal(b.note.excessCents, c(9470.74)); assert.equal(Number((b.note.variance.value! * 100).toFixed(1)), 4.0); assert.equal(Number(b.yearsToRepayWhole.value!.toFixed(2)), 11.84); assert.equal(b.discountedValueCents, c(1197280));
  // A 10% owner is priced on the discounted value if they leave early ($119,728) and shares in the full value only if the whole business sells ($187,075).
  const minority = valuation(B, { ...D, stakePct: 0.1 }); assert.equal(minority.stakeBasis, 'discounted'); assert.equal(minority.stakePriceCents, c(119728)); assert.equal(minority.stakeIfWholeBusinessSoldCents, c(187075)); assert.ok(minority.flags.some((f) => /only a sale of the whole business/.test(f.text)));
  // Outside the 10% band either way.
  assert.equal(valuation({ ...A, pretaxCents: c(90000), equityCents: c(900000) }, D).note.status, 'shortfall'); assert.equal(valuation({ ...A, equityCents: 0 }, D).note.status, 'excess');
  // Advisor adjustment to equity is applied and must carry a reason.
  const adj = valuation(A, { ...D, equityAdjustmentCents: c(-50000) }); assert.equal(adj.valueCents, c(1355500)); assert.ok(adj.flags.some((f) => /without a reason/.test(f.text)));
  // No profit stream: value is net assets; negative equity is stated plainly and nothing is financeable.
  const loss = valuation({ ...A, pretaxCents: c(-60000), equityCents: c(-20000) }, D); assert.equal(loss.method, 'net_assets'); assert.equal(loss.valueCents, c(-20000)); assert.equal(loss.note.status, null); assert.equal(loss.yearsToRepayWhole.value, null); assert.equal(loss.discountedValueCents, c(-20000));
  // Fewer than three years: average of what is available times three, flagged; fewer than twelve months or no balance sheet: not available.
  const short = valuation({ ...A, pretaxCents: c(105000), monthsUsed: 12, equityCents: c(155000) }, D); assert.equal(short.estimated, true); assert.equal(short.valueCents, c(470000)); assert.ok(short.flags.some((f) => /Only 12 months/.test(f.text)));
  assert.equal(valuation({ ...A, monthsUsed: 9 }, D).available, false); assert.equal(valuation({ ...A, equityCents: null }, D).available, false);
  assert.ok(valuation({ ...A, ownerWageApplied: false, coreCapitalSurplusCents: c(-40000), debtCents: c(5000) }, D).flags.length >= 4);
  assert.equal(annualPayment(c(1000), 0, 4), c(250)); assert.equal(yearsToRepay(c(1000), 0.1, c(100)).value, null, 'a payment equal to the interest never repays');
});

test('value and distributions at 5%, 10% and 15% pretax profit (worked five-year example)', async () => {
  const { profitLevels } = await import('../src/engine/valuation.ts');
  const [five, ten, fifteen] = profitLevels({ startEquityCents: c(50000), revenueCents: [1050000, 1920000, 2070000, 2850000, 3000000].map(c), levels: [0.05, 0.10, 0.15], taxRate: 0.4, coreCapitalMonths: 2, firstProfitDistributionYear: 3, marketabilityDiscount: 0.2, controlDiscount: 0.2 });
  const col = (r: any, k: string) => r.years.map((y: any) => y[k]);
  // 10%: tax distributions follow the prior year's profit; profit distributions start small in year three.
  assert.deepEqual(col(ten, 'pretaxCents'), [105000, 192000, 207000, 285000, 300000].map(c)); assert.deepEqual(col(ten, 'taxDistributionCents'), [0, 42000, 76800, 82800, 114000].map(c));
  assert.deepEqual(col(ten, 'profitDistributionCents'), [0, 0, 17000, 107700, 85200].map(c)); assert.deepEqual(col(ten, 'equityCents'), [155000, 305000, 418200, 512700, 613500].map(c));
  assert.deepEqual(col(ten, 'coreCapitalTargetCents'), [157500, 288000, 310500, 427500, 450000].map(c)); assert.deepEqual(ten.years.map((y) => Math.round(y.returnOnInvestment.value! * 100)), [68, 63, 49, 56, 49]);
  assert.deepEqual(col(ten, 'valueCents'), [470000, 750500, 922200, 1196700, 1405500].map(c)); assert.deepEqual(col(ten, 'discountedValueCents'), [300800, 480320, 590208, 765888, 899520].map(c)); assert.equal(ten.totalProfitDistributionsCents, c(209900));
  // 15%: far larger distributions and value from the same revenue.
  assert.deepEqual(col(fifteen, 'profitDistributionCents'), [0, 0, 160500, 174050, 192800].map(c)); assert.deepEqual(col(fifteen, 'equityCents'), [207500, 432500, 467300, 596550, 682750].map(c)); assert.equal(fifteen.totalProfitDistributionsCents, c(527350)); assert.deepEqual(col(fifteen, 'valueCents'), [680000, 1100750, 1223300, 1622550, 1870750].map(c)); assert.equal(fifteen.yearCoreCapitalReached, 1);
  // 5%: five years to get near the core capital target and no profit distributions at all.
  assert.deepEqual(col(five, 'equityCents'), [102500, 177500, 242600, 343700, 436700].map(c)); assert.equal(five.totalProfitDistributionsCents, 0); assert.equal(five.endingValueCents, c(832700)); assert.equal(five.yearCoreCapitalReached, null); assert.deepEqual(col(five, 'coreCapitalTargetCents'), [166250, 304000, 327750, 451250, 475000].map(c));
});

test('simple forecast model: profit to cash road map (worked example) and the what-if forecast', async () => {
  const W = await import('../src/engine/whatif.ts'); const { zeroPnl, zeroBs, DEFAULT_SETTINGS, computePnl } = await import('../src/engine/core.ts');
  // Two months of actuals, three of forecast. Receivables in the forecast months come from 30 days to collect on the last two months' sales.
  assert.equal(W.arForDso(30, [c(110000), c(105000)], 60), c(107500));
  const m = (period: string, revenue: number, cogs: number, labor: number, marketing: number, ptb: number, other: number, arEnd: number, apEnd: number, locEnd: number, distributions = 0) => ({ period, revenue: c(revenue), cogs: c(cogs), labor: c(labor), marketing: c(marketing), facilities: c(5000), payrollTaxesBenefits: c(ptb), otherOpex: c(other), arEnd: c(arEnd), apEnd: c(apEnd), locEnd: c(locEnd), notesEnd: 0, distributions: c(distributions) });
  const rows = W.roadmap({ cash: c(25000), ar: c(95000), ap: c(20000), loc: c(50000), notes: 0, ytdGp: 0, ytdLabor: 0, priorRevenue: [] }, [
    m('2026-01', 100000, 60000, 15000, 1500, 3000, 7500, 110000, 15000, 65000, 5000), m('2026-02', 110000, 63800, 15000, 1500, 3000, 7500, 100000, 20000, 35000),
    m('2026-03', 105000, 59850, 18000, 2000, 3600, 7000, 107500, 25000, 30000), m('2026-04', 120000, 66000, 20000, 2000, 4000, 7000, 112500, 30000, 25000), m('2026-05', 130000, 70200, 21000, 2000, 4200, 7000, 125000, 35000, 20000, 18460)], { coreCapitalMonths: 2, dsoWindowDays: 60 });
  const col = (k: string) => rows.map((r: any) => r[k]); const two = (k: string) => rows.map((r: any) => Number(r[k].value.toFixed(2)));
  assert.deepEqual(col('totalOpex'), [32000, 32000, 35600, 38000, 39200].map(c)); assert.deepEqual(col('pretax'), [8000, 14200, 9550, 16000, 20600].map(c));
  // $8,000 of profit is not $8,000 of cash: receivables up $15,000 and payables down $5,000 use cash, $15,000 of new debt supplies it, $5,000 is distributed.
  assert.deepEqual([rows[0].arChange, rows[0].apChange, rows[0].debtChange, rows[0].equityChange], [c(-15000), c(-5000), c(15000), c(-5000)]);
  assert.deepEqual(col('netChange'), [-2000, -800, 2050, 11000, -10360].map(c)); assert.deepEqual(col('cashEnd'), [23000, 22200, 24250, 35250, 24890].map(c));
  assert.deepEqual(two('ler'), [2.67, 3.08, 2.51, 2.7, 2.85]); assert.deepEqual(two('lerYtd'), [2.67, 2.87, 2.74, 2.73, 2.75]); assert.deepEqual(rows.slice(2).map((r) => Number(r.dso.value!.toFixed(2))), [30, 30, 30]);
  // Core capital is cash less debt; the target is two months of operating expenses, with or without cost of goods sold.
  assert.deepEqual(col('coreCapital'), [-42000, -12800, -5750, 10250, 4890].map(c)); assert.deepEqual(col('targetWithoutCogs'), [64000, 64000, 71200, 76000, 78400].map(c)); assert.deepEqual(col('targetWithCogs'), [184000, 191600, 190900, 208000, 218800].map(c));
  assert.equal(c(18460), Math.round(0.4 * (rows[2].pretax + rows[3].pretax + rows[4].pretax)), 'the distribution is 40% of the three previous months of profit');

  // What-if on a steady business: $100,000 a month, 40% gross profit, $32,000 of costs, customers pay in 30 days.
  const S = { ...DEFAULT_SETTINGS, dsoWindowDays: 60, cashFloorCents: 0 }; const hist = Array.from({ length: 14 }, (_, i) => { const d = new Date(Date.UTC(2025, 8 + i, 1)); const period = d.toISOString().slice(0, 7);
    return { period, pnl: { ...zeroPnl(), revenue: c(100000), cogs: c(60000), mgmt_labor: c(15000), marketing: c(1500), facilities: c(5000), payroll_taxes_benefits: c(3000), other_opex: c(7500) }, bs: i === 13 ? { ...zeroBs(), cash: c(50000), accounts_receivable: c(100000), accounts_payable: c(20000), notes_payable: c(30000), equity: c(100000) } : null, ownerAdj: 0, status: 'approved' as const }; });
  assert.equal(hist.at(-1)!.period, '2026-10'); const base = W.whatIf(hist, S); assert.equal(base.available, true); assert.equal(base.months.length, 12); assert.equal(base.months[0].period, '2026-11');
  assert.deepEqual(base.defaults, { salesChangePct: 0, grossProfitPct: 0.4, payrollChangeMonthlyCents: 0, overheadChangeMonthlyCents: 0, dsoDays: 30, debtPaydownMonthlyCents: 0, purchasesMonthlyCents: 0, distributionPolicy: 'tax_only' });
  assert.ok(base.months.every((r) => r.pretax === c(8000) && r.arEnd === c(100000) && r.apEnd === c(20000))); assert.deepEqual(base.summary!.vsBaseline, { pretax: 0, endCash: 0, minCash: 0 });
  // Tax distributions go out in January, April, June and September at 40% of the profit earned since the last one.
  assert.deepEqual(base.months.filter((r) => r.taxDistribution > 0).map((r) => [r.period, r.taxDistribution]), [['2027-01', c(12800)], ['2027-04', c(9600)], ['2027-06', c(6400)], ['2027-09', c(9600)]]);
  assert.equal(base.summary!.next12.endCash, c(50000 + 96000 - 38400)); assert.equal(base.summary!.fiscalYear.actualMonths, 10); assert.equal(base.summary!.fiscalYear.forecastMonths, 2); assert.equal(base.summary!.fiscalYear.truePretax, c(96000));
  // Sales up 10%: more profit, but receivables grow by $10,000, so cash rises by less than profit.
  const up = W.whatIf(hist, S, { salesChangePct: 0.1 }); assert.equal(up.months[0].revenue, c(110000)); assert.equal(up.months[1].arEnd, c(110000)); assert.equal(up.summary!.vsBaseline.pretax, c(48000)); assert.ok(up.summary!.vsBaseline.endCash! < c(48000) && up.summary!.vsBaseline.endCash! > 0);
  // Collecting ten days faster adds no profit and frees a third of receivables as cash.
  const fast = W.whatIf(hist, S, { dsoDays: 20 }); assert.equal(fast.summary!.vsBaseline.pretax, 0); assert.equal(fast.summary!.vsBaseline.endCash, c(33333.33));
  // $5,000 a month more payroll costs that plus payroll taxes and benefits (20% of payroll here).
  const hire = W.whatIf(hist, S, { payrollChangeMonthlyCents: c(5000) }); assert.equal(hire.months[0].labor, c(20000)); assert.equal(hire.summary!.vsBaseline.pretax, c(-72000));
  // Debt pay-down and purchases use cash without touching profit; the loan cannot go below zero.
  const pay = W.whatIf(hist, S, { debtPaydownMonthlyCents: c(5000), purchasesMonthlyCents: c(1000) }); assert.equal(pay.summary!.vsBaseline.pretax, 0); assert.equal(pay.months.at(-1)!.notesEnd, 0); assert.equal(pay.summary!.vsBaseline.endCash, c(-30000 - 12000));
  // Profit up but cash down is called out; running out of cash is called out.
  const grow = W.whatIf(hist, S, { salesChangePct: 0.1, dsoDays: 60 }); assert.ok(grow.flags.some((f) => /Profit is not cash/.test(f.text)));
  assert.ok(W.whatIf(hist, S, { salesChangePct: -0.4 }).flags.some((f) => /Cash runs out/.test(f.text)));
  // Distributing everything above the core capital target leaves core capital at the target; no distributions keeps the cash.
  const ex = W.whatIf(hist, S, { distributionPolicy: 'tax_then_excess' }); assert.ok(ex.summary!.next12.profitDistributions > 0); assert.ok(ex.months.at(-1)!.coreCapital >= ex.months.at(-1)!.coreCapitalTarget);
  assert.equal(W.whatIf(hist, S, { distributionPolicy: 'none' }).summary!.next12.endCash, c(50000 + 96000));
  // No balance sheet: profit is forecast, cash is not. Too little history: nothing is.
  const noBs = W.whatIf(hist.map((x) => ({ ...x, bs: null })), S); assert.equal(noBs.cashAvailable, false); assert.equal(noBs.summary!.next12.endCash, null); assert.equal(noBs.summary!.next12.truePretax, c(96000));
  assert.equal(W.whatIf(hist.slice(0, 2), S).available, false); assert.equal(computePnl(hist[0].pnl, 0, S).pretax, c(8000));
});

test('rolling three: direction beside the rolling twelve, with the seasonal check', async () => {
  const R = await import('../src/engine/reporting.ts'); const { zeroPnl, DEFAULT_SETTINGS } = await import('../src/engine/core.ts'); const { highlights, recentChanges } = await import('../src/engine/comms.ts');
  const S = DEFAULT_SETTINGS; const mk = (i: number, revenue: number, labor: number) => ({ period: new Date(Date.UTC(2025, i, 1)).toISOString().slice(0, 7), pnl: { ...zeroPnl(), revenue: c(revenue), cogs: c(revenue * 0.4), mgmt_labor: c(labor), other_opex: c(10000) }, bs: null, ownerAdj: 0, status: 'approved' as const });
  const build = (f: (i: number) => [number, number], n = 18) => Array.from({ length: n }, (_, i) => mk(i, ...f(i))); const by = (r: any) => Object.fromEntries(r.signals.map((x: any) => [x.key, x]));
  // Steady business: everything in line.
  const flat = R.rolling3(build(() => [100000, 30000]), 17, S)!; assert.ok(flat.signals.every((x) => x.status === 'in_line')); assert.equal(flat.lastYearAvailable, true); assert.equal(flat.signals[0].r3, 0.2);
  // Payroll up $10,000 a month in the last three months: profit and labor efficiency slip, and last year confirms it is not seasonal.
  const slip = by(R.rolling3(build((i) => [100000, i >= 15 ? 40000 : 30000]), 17, S)); assert.equal(slip.profitability.status, 'worse'); assert.equal(slip.profitability.confirmed, true); near(slip.profitability.r3, 0.1); near(slip.profitability.r12, 0.175); near(slip.profitability.lastYear, 0.2);
  assert.equal(slip.labor.status, 'worse'); near(slip.labor.r3, 1.5); assert.equal(slip.sales.status, 'in_line'); assert.match(slip.profitability.text, /10\.0%, against 17\.5% for the twelve months and 20\.0% in the same three months last year: slipping\./);
  // A seasonal business: the same three months are slow every year, so the gap to the twelve months is not read as a decline.
  const season = by(R.rolling3(build((i) => [i % 12 >= 3 && i % 12 <= 5 ? 60000 : 110000, 30000]), 17, S)); assert.equal(season.profitability.status, 'seasonal'); assert.equal(season.sales.status, 'in_line'); assert.match(season.profitability.text, /normal for this time of year/);
  // Sales up 20% on the same months last year at the same margins.
  const grow = by(R.rolling3(build((i) => [i >= 15 ? 120000 : 100000, 30000]), 17, S)); assert.equal(grow.sales.status, 'better'); assert.match(grow.sales.text, /20\.0% above the same three months last year/); assert.equal(grow.profitability.status, 'better');
  // Ahead of the twelve months but behind last year: no call is made.
  assert.equal(by(R.rolling3(build((i) => [100000, i < 6 ? 15000 : i >= 15 ? 30000 : 40000]), 17, S)).profitability.status, 'mixed');
  // Twelve to fourteen months: direction is shown but marked as unchecked. Under twelve: nothing.
  const early = by(R.rolling3(build((i) => [100000, i >= 10 ? 40000 : 30000], 13), 12, S)); assert.equal(early.profitability.status, 'worse'); assert.equal(early.profitability.confirmed, false); assert.match(early.profitability.text, /may be seasonal/); assert.equal(early.sales.status, null);
  assert.equal(R.rolling3(build(() => [100000, 30000], 11), 10, S), null);
  // Only a real change reaches the email highlights; a seasonal swing does not.
  const sc = { period: '2026-06', measures: [] } as any; assert.ok(highlights(sc, {}, [], 4, R.rolling3(build((i) => [100000, i >= 15 ? 40000 : 30000]), 17, S)).some((h) => /^Recent direction\./.test(h)));
  assert.equal(recentChanges(R.rolling3(build((i) => [i % 12 >= 3 && i % 12 <= 5 ? 60000 : 110000, 30000]), 17, S)).length, 0);
});
