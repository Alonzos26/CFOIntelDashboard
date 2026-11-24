// Weekly Pulse: weekly gross margin and labor-efficiency tracking with running over/under targets.
// Sources: Reports to Watch "Weekly GM and LER", Labor Productivity (week / MTD / YTD LER).
import { type Ratio, type Settings, fmtMoney, fmtPct, fmtRatio, ratio } from './core.ts';

export interface WeeklyEntry { weekStart: string; revenueCents: number; cogsCents: number; directLaborCents: number; /** Office and management payroll for the week; null when not entered. */ otherLaborCents?: number | null; cashBalanceCents: number | null; source: string }
export interface WeeklyRow extends WeeklyEntry {
  grossProfitCents: number; grossMarginPct: Ratio; dLER: Ratio; contributionCents: number;
  gpTargetCents: number | null; gpOverUnderCents: number | null; gpRollingOverUnderCents: number | null;
  targetLaborSpendCents: number | null; laborOverUnderCents: number | null; laborRollingOverUnderCents: number | null;
  mtdLER: Ratio; ytdLER: Ratio; mtdRevenueCents: number; mtdGrossProfitCents: number; ytdRevenueCents: number; ytdGrossProfitCents: number;
}

function fiscalYearStart(iso: string, startMonth: number): string {
  const y = Number(iso.slice(0, 4)), m = Number(iso.slice(5, 7));
  return `${m >= startMonth ? y : y - 1}-${String(startMonth).padStart(2, '0')}-01`;
}

export function weeklyRows(entries: WeeklyEntry[], s: Settings): WeeklyRow[] {
  const sorted = [...entries].sort((a, b) => a.weekStart.localeCompare(b.weekStart));
  let gpRoll = 0, laborRoll = 0; let fy = '';
  return sorted.map((e, i) => {
    const thisFy = fiscalYearStart(e.weekStart, s.fiscalYearStartMonth);
    if (thisFy !== fy) { fy = thisFy; gpRoll = 0; laborRoll = 0; } // running totals restart each fiscal year
    const gp = e.revenueCents - e.cogsCents;
    const gpOU = s.weeklyGpTargetCents === null ? null : gp - s.weeklyGpTargetCents;
    const targetLabor = s.dlerTarget ? Math.round(gp / s.dlerTarget) : null;
    const laborOU = targetLabor === null ? null : e.directLaborCents - targetLabor;
    if (gpOU !== null) gpRoll += gpOU; if (laborOU !== null) laborRoll += laborOU;
    const month = e.weekStart.slice(0, 7);
    const mtd = sorted.slice(0, i + 1).filter((x) => x.weekStart.slice(0, 7) === month);
    const ytdRows = sorted.slice(0, i + 1).filter((x) => x.weekStart >= thisFy);
    const sum = (rows: WeeklyEntry[], f: (x: WeeklyEntry) => number) => rows.reduce((a, x) => a + f(x), 0);
    const gpOf = (x: WeeklyEntry) => x.revenueCents - x.cogsCents;
    return {
      ...e, grossProfitCents: gp, grossMarginPct: ratio(gp, e.revenueCents, 'no sales were recorded'),
      dLER: ratio(gp, e.directLaborCents, 'no direct labor was recorded'), contributionCents: gp - e.directLaborCents,
      gpTargetCents: s.weeklyGpTargetCents, gpOverUnderCents: gpOU, gpRollingOverUnderCents: gpOU === null ? null : gpRoll,
      targetLaborSpendCents: targetLabor, laborOverUnderCents: laborOU, laborRollingOverUnderCents: laborOU === null ? null : laborRoll,
      mtdLER: ratio(sum(mtd, gpOf), sum(mtd, (x) => x.directLaborCents), 'no direct labor was recorded'),
      ytdLER: ratio(sum(ytdRows, gpOf), sum(ytdRows, (x) => x.directLaborCents), 'no direct labor was recorded'),
      mtdRevenueCents: sum(mtd, (x) => x.revenueCents), mtdGrossProfitCents: sum(mtd, gpOf),
      ytdRevenueCents: sum(ytdRows, (x) => x.revenueCents), ytdGrossProfitCents: sum(ytdRows, gpOf),
    };
  });
}

export interface Briefing { performance: string; improved: string; attention: string; actions: string; watch: string }

/** Rule-based first draft of the weekly briefing. Every sentence cites figures from the rows; an advisor reviews before publishing. */
export function draftBriefing(rows: WeeklyRow[], idx: number, s: Settings, cash?: { lowestCents: number; lowestWeek: string; floorCents: number } | null): Briefing {
  const r = rows[idx]; const p = idx > 0 ? rows[idx - 1] : null;
  const improved: string[] = [], attention: string[] = [], actions: string[] = [], watch: string[] = [];
  const perf = `Sales were ${fmtMoney(r.revenueCents)} with gross profit of ${fmtMoney(r.grossProfitCents)} (${fmtPct(r.grossMarginPct.value)} margin). Direct labor was ${fmtMoney(r.directLaborCents)}, a direct LER of ${fmtRatio(r.dLER.value)}.` +
    (r.gpOverUnderCents !== null ? ` Gross profit was ${fmtMoney(Math.abs(r.gpOverUnderCents))} ${r.gpOverUnderCents >= 0 ? 'over' : 'under'} the weekly target of ${fmtMoney(r.gpTargetCents)}.` : '');
  if (p) {
    if (r.grossProfitCents > p.grossProfitCents) improved.push(`Gross profit rose ${fmtMoney(r.grossProfitCents - p.grossProfitCents)} from the prior week.`);
    else if (r.grossProfitCents < p.grossProfitCents) attention.push(`Gross profit fell ${fmtMoney(p.grossProfitCents - r.grossProfitCents)} from the prior week.`);
    if (r.dLER.value !== null && p.dLER.value !== null) {
      if (r.dLER.value > p.dLER.value + 0.02) improved.push(`Direct LER improved from ${fmtRatio(p.dLER.value)} to ${fmtRatio(r.dLER.value)}.`);
      else if (r.dLER.value < p.dLER.value - 0.02) attention.push(`Direct LER slipped from ${fmtRatio(p.dLER.value)} to ${fmtRatio(r.dLER.value)}.`);
    }
  }
  if (r.laborOverUnderCents !== null && s.dlerTarget) {
    if (r.laborOverUnderCents > 0) {
      attention.push(`Direct labor ran ${fmtMoney(r.laborOverUnderCents)} over the spend that a ${fmtRatio(s.dlerTarget)} LER target allows for this week's gross profit.`);
      actions.push('Review scheduling and job assignments for the week against the hours actually billed or produced.');
    } else improved.push(`Direct labor came in ${fmtMoney(-r.laborOverUnderCents)} under the target spend.`);
  }
  if (r.gpRollingOverUnderCents !== null && r.gpRollingOverUnderCents < 0) {
    attention.push(`Year to date, gross profit is running ${fmtMoney(-r.gpRollingOverUnderCents)} behind the cumulative weekly target.`);
    actions.push('Identify which jobs or services fell short of target margin and confirm pricing on work scheduled for the next two weeks.');
  }
  if (cash) {
    if (cash.lowestCents < cash.floorCents) {
      attention.push(`The 13-week cash forecast dips to ${fmtMoney(cash.lowestCents)} in the week of ${cash.lowestWeek}, below the ${fmtMoney(cash.floorCents)} minimum.`);
      actions.push('Prioritize collection of the largest open receivables and review the timing of discretionary payments before that week.');
    }
    watch.push(`Lowest projected cash in the next 13 weeks: ${fmtMoney(cash.lowestCents)} (week of ${cash.lowestWeek}).`);
  }
  watch.push(`Month-to-date direct LER is ${fmtRatio(r.mtdLER.value)}${s.dlerTarget ? ` against a target of ${fmtRatio(s.dlerTarget)}` : ''}.`);
  const join = (a: string[], empty: string) => (a.length ? a.join(' ') : empty);
  return { performance: perf, improved: join(improved, 'No measured improvement over the prior week.'), attention: join(attention, 'Nothing fell outside target ranges this week.'), actions: join(actions, 'No corrective action is indicated by this week\'s figures.'), watch: watch.join(' ') };
}
