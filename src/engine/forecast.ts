// Driver-based monthly forecast (method from Deluxe CF Model "PL by Month" forecast columns).
import { type MonthData, type PnlLines, type Settings, addMonths, trailing, zeroPnl } from './core.ts';

export interface ForecastDrivers {
  revenueGrowthPct: number;      // vs. same month last year
  grossMarginPct: number;
  dLER: number;                  // direct labor = gross profit ÷ dLER
  mLER: number | null;           // management labor = contribution margin ÷ mLER (null = hold trailing average)
  marketingPctOfRevenue: number;
  burdenPctOfWages: number;      // payroll taxes & benefits as % of all wages
  otherOpexPctOfRevenue: number;
}

/** Default drivers taken from the trailing 12 months of actuals — every one is an editable assumption. */
export function defaultDrivers(months: MonthData[], s: Settings): ForecastDrivers {
  const r = trailing(months, months.length - 1, 12, s)!;
  const prior = months.length >= 24 ? trailing(months, months.length - 13, 12, s) : null;
  const growth = prior && prior.lines.revenue > 0 ? r.lines.revenue / prior.lines.revenue - 1 : 0;
  const wages = r.lines.direct_labor + r.lines.mgmt_labor;
  const rev = r.lines.revenue || 1;
  return {
    revenueGrowthPct: Math.max(-0.5, Math.min(0.5, growth)),
    grossMarginPct: r.grossMarginPct.value ?? 0,
    dLER: r.dLER.value ?? s.dlerTarget ?? 2,
    mLER: r.mLER.value,
    marketingPctOfRevenue: r.lines.marketing / rev,
    burdenPctOfWages: wages > 0 ? r.lines.payroll_taxes_benefits / wages : 0,
    otherOpexPctOfRevenue: r.lines.other_opex / rev,
  };
}

export function forecastMonths(months: MonthData[], n: number, d: ForecastDrivers, s: Settings): { period: string; pnl: PnlLines }[] {
  const out: { period: string; pnl: PnlLines }[] = [];
  const last = months[months.length - 1];
  const t = trailing(months, months.length - 1, Math.min(12, months.length), s)!;
  const avg = (k: keyof PnlLines) => Math.round(t.lines[k] / t.monthsIncluded);
  const byPeriod = new Map(months.map((m) => [m.period, m.pnl]));
  for (let i = 1; i <= n; i++) {
    const period = addMonths(last.period, i);
    const ly = byPeriod.get(addMonths(period, -12)) ?? out.find((o) => o.period === addMonths(period, -12))?.pnl;
    const p = zeroPnl();
    p.revenue = Math.round((ly ? ly.revenue : avg('revenue')) * (1 + d.revenueGrowthPct));
    const gp = Math.round(p.revenue * d.grossMarginPct);
    p.cogs = p.revenue - gp;
    p.direct_labor = d.dLER > 0 ? Math.round(gp / d.dLER) : avg('direct_labor');
    const cm = gp - p.direct_labor;
    p.mgmt_labor = d.mLER && d.mLER > 0 ? Math.round(cm / d.mLER) : avg('mgmt_labor');
    p.facilities = avg('facilities');
    p.marketing = Math.round(p.revenue * d.marketingPctOfRevenue);
    p.payroll_taxes_benefits = Math.round((p.direct_labor + p.mgmt_labor) * d.burdenPctOfWages);
    p.other_opex = Math.round(p.revenue * d.otherOpexPctOfRevenue);
    p.depreciation = avg('depreciation'); p.other_income_expense = avg('other_income_expense'); p.interest_expense = avg('interest_expense');
    out.push({ period, pnl: p });
  }
  return out;
}
