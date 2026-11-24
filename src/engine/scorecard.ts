// Simple Numbers-inspired scorecard: rolling-12 actuals vs configurable targets, graded Great / Good / OK / Caution.
import { type Grade, type MonthData, type Settings, type Thresholds, coreCapital, dso, rolling12 } from './core.ts';

export type ValueKind = 'pct' | 'money' | 'ratio' | 'days';
export interface Measure {
  key: 'profitability' | 'sales' | 'opex' | 'salary_cap' | 'dso' | 'core_capital' | 'labor';
  label: string;
  actual: number | null; actualKind: ValueKind;
  target: number | null; targetKind: ValueKind; targetLabel: string;
  attainment: number | null;
  grade: Grade;
  trend: { direction: 'up' | 'down' | 'flat' | 'n/a'; improving: boolean | null; prior: number | null };
  basis: string;      // how the number was calculated
  note: string | null; // N/A reasons and caveats
  higherIsBetter: boolean;
}
export interface Scorecard { period: string; r12From: string; r12Complete: boolean; monthsIncluded: number; measures: Measure[]; reportedPretaxPct: number | null }

export function gradeAttainment(att: number | null, t: Thresholds): Grade {
  if (att === null || !Number.isFinite(att)) return 'N/A';
  const a = att + 1e-9; // tolerance so that exactly-on-threshold results are not lost to floating-point rounding
  if (a >= t.great) return 'Great';
  if (a >= t.good) return 'Good';
  if (a >= t.ok) return 'OK';
  return 'Caution';
}

interface Raw { actual: number | null; target: number | null; attainment: number | null; note: string | null; targetLabel: string }

function rawMeasures(months: MonthData[], idx: number, s: Settings): Record<Measure['key'], Raw> | null {
  const r = rolling12(months, idx, s);
  if (!r) return null;
  const prior = idx >= 12 ? rolling12(months, idx - 12, s) : null;
  const div = (a: number | null, b: number | null) => (a === null || b === null || b === 0 ? null : a / b);

  const profit = r.adjustedPretaxPct.value;
  const salesTarget = s.salesTargetR12Cents ?? (prior && prior.complete ? prior.lines.revenue : null);
  const opexPct = r.opexPct.value;
  const d = dso(months, idx, s);
  const cc = coreCapital(months, idx, s);
  return {
    profitability: {
      actual: profit, target: s.pretaxTargetPct, attainment: profit === null ? null : profit / s.pretaxTargetPct,
      note: r.adjustedPretaxPct.reason ?? null, targetLabel: 'Target pretax profit',
    },
    sales: {
      actual: r.lines.revenue, target: salesTarget, attainment: div(r.lines.revenue, salesTarget),
      note: salesTarget === null ? 'No sales target is set and there is not yet a full prior rolling-12 period to compare with.' : s.salesTargetR12Cents === null ? 'No sales target is set; compared with the previous rolling 12 months.' : null,
      targetLabel: s.salesTargetR12Cents === null ? 'Prior rolling 12' : 'Sales target',
    },
    opex: {
      actual: opexPct, target: s.opexPctTarget, attainment: opexPct === null || s.opexPctTarget === null || opexPct <= 0 ? null : s.opexPctTarget / opexPct,
      note: s.opexPctTarget === null ? 'No operating expense target has been set for this client.' : r.opexPct.reason ?? null, targetLabel: 'Target % of revenue',
    },
    salary_cap: {
      actual: r.salaryCapHeadroom, target: 0, attainment: r.adjustedLabor > 0 ? r.salaryCap / r.adjustedLabor : null,
      note: r.adjustedLabor > 0 ? null : 'Not available: no labor cost was recorded.', targetLabel: 'At or under cap',
    },
    dso: {
      actual: d.value, target: s.dsoTargetDays, attainment: d.value === null || s.dsoTargetDays === null || d.value <= 0 ? null : s.dsoTargetDays / d.value,
      note: d.reason ?? (s.dsoTargetDays === null ? 'No DSO target has been set for this client.' : null), targetLabel: 'Target days',
    },
    core_capital: {
      actual: cc.available, target: cc.target, attainment: cc.attainment.value,
      note: cc.attainment.reason ?? (cc.locBalance && cc.locBalance > 0 ? 'A line-of-credit balance is outstanding; it is deducted from cash.' : null), targetLabel: `${s.coreCapitalMonths}-month target`,
    },
    labor: {
      actual: r.dLER.value, target: s.dlerTarget, attainment: r.dLER.value === null || s.dlerTarget === null ? null : r.dLER.value / s.dlerTarget,
      note: r.dLER.reason ?? (s.dlerTarget === null ? 'No direct labor efficiency target has been set for this client.' : null), targetLabel: 'Target direct LER',
    },
  };
}

const META: Record<Measure['key'], { label: string; actualKind: ValueKind; targetKind: ValueKind; higherIsBetter: boolean; basis: string }> = {
  profitability: { label: 'Profitability', actualKind: 'pct', targetKind: 'pct', higherIsBetter: true, basis: 'Rolling-12 pretax profit after normalizing owner pay to market rate, as a % of revenue.' },
  sales: { label: 'Sales', actualKind: 'money', targetKind: 'money', higherIsBetter: true, basis: 'Rolling-12 revenue.' },
  opex: { label: 'Operating Expenses', actualKind: 'pct', targetKind: 'pct', higherIsBetter: false, basis: 'Rolling-12 operating expenses (including management labor) as a % of revenue.' },
  salary_cap: { label: 'Salary Cap', actualKind: 'money', targetKind: 'money', higherIsBetter: true, basis: 'Labor you can afford at the target profit, minus actual labor including the owner-pay adjustment. Positive = under the cap.' },
  dso: { label: 'A/R DSO', actualKind: 'days', targetKind: 'days', higherIsBetter: false, basis: 'Receivables ÷ average daily sales over the measurement window.' },
  core_capital: { label: 'Core Capital', actualKind: 'money', targetKind: 'money', higherIsBetter: true, basis: 'Cash minus line-of-credit balance, compared with the reserve target.' },
  labor: { label: 'Labor Efficiency', actualKind: 'ratio', targetKind: 'ratio', higherIsBetter: true, basis: 'Rolling-12 gross profit ÷ direct labor (direct LER).' },
};

export function buildScorecard(months: MonthData[], idx: number, s: Settings): Scorecard | null {
  const raw = rawMeasures(months, idx, s);
  const r = rolling12(months, idx, s);
  if (!raw || !r) return null;
  const earlier = idx >= 3 ? rawMeasures(months, idx - 3, s) : null;
  const measures = (Object.keys(META) as Measure['key'][]).map((key): Measure => {
    const m = META[key]; const x = raw[key];
    let grade = gradeAttainment(x.attainment, s.grades[key]);
    if (key === 'core_capital' && grade === 'Great' && months[idx].bs && months[idx].bs!.line_of_credit > 0) grade = 'Good';
    const prior = earlier ? earlier[key].actual : null;
    let direction: Measure['trend']['direction'] = 'n/a'; let improving: boolean | null = null;
    if (x.actual !== null && prior !== null) {
      const delta = x.actual - prior; const scale = Math.max(Math.abs(prior), 1e-9);
      direction = Math.abs(delta) / scale < 0.01 ? 'flat' : delta > 0 ? 'up' : 'down';
      improving = direction === 'flat' ? null : (direction === 'up') === m.higherIsBetter;
    }
    return { key, label: m.label, actual: x.actual, actualKind: m.actualKind, target: x.target, targetKind: m.targetKind, targetLabel: x.targetLabel, attainment: x.attainment, grade, trend: { direction, improving, prior }, basis: m.basis, note: x.note, higherIsBetter: m.higherIsBetter };
  });
  return { period: months[idx].period, r12From: r.from, r12Complete: r.complete, monthsIncluded: r.monthsIncluded, measures, reportedPretaxPct: r.pretaxPct.value };
}
