// 13-week cash-flow forecast built from cash rhythms (dated, recurring cash events) — timing, not prorated monthly profit.
// Sources: Reports to Watch "Weekly CF", Cash Rhythms & Weekly Forecasting Worksheet, Cash Flow Planning Workshop.

export type Cadence = 'once' | 'weekly' | 'biweekly' | 'semimonthly' | 'monthly' | 'quarterly' | 'annual';
export const CADENCES: Cadence[] = ['once', 'weekly', 'biweekly', 'semimonthly', 'monthly', 'quarterly', 'annual'];
export const CASH_CATEGORIES = {
  in: ['collections', 'known_receivable', 'deposit', 'recurring_receipt', 'loan_proceeds', 'other_in'],
  out: ['payroll', 'payroll_taxes', 'vendor', 'rent', 'credit_card', 'loan_payment', 'estimated_taxes', 'capital_purchase', 'owner_distribution', 'other_out'],
} as const;
/** Cash uses that are not P&L expenses (debt principal, taxes, equipment, distributions). */
export const NON_PNL_CATEGORIES = ['loan_payment', 'estimated_taxes', 'capital_purchase', 'owner_distribution'];

export interface CashItem {
  id: string; name: string; direction: 'in' | 'out'; category: string;
  amountCents: number; cadence: Cadence; anchorDate: string; endDate: string | null; secondDay: number | null; active: boolean;
}

const DAY = 86_400_000;
export const toDay = (iso: string) => Math.round(Date.parse(iso + 'T00:00:00Z') / DAY);
export const fromDay = (d: number) => new Date(d * DAY).toISOString().slice(0, 10);
export const addDays = (iso: string, n: number) => fromDay(toDay(iso) + n);
/** Start of the week containing `iso`, for a client-selected week-start day (0 = Sunday). */
export function weekStart(iso: string, weekStartDay: number): string {
  const d = toDay(iso); const dow = new Date(d * DAY).getUTCDay();
  return fromDay(d - ((dow - weekStartDay + 7) % 7));
}
function dayInMonth(y: number, m0: number, day: number): number {
  const last = new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();
  return Math.round(Date.UTC(y, m0, Math.min(day, last)) / DAY);
}

/** Every date in [from, to] on which the item occurs. */
export function occurrences(item: CashItem, from: string, to: string): string[] {
  const a = toDay(from), b = Math.min(toDay(to), item.endDate ? toDay(item.endDate) : Infinity), anchor = toDay(item.anchorDate);
  const out: number[] = [];
  if (item.cadence === 'once') { if (anchor >= a && anchor <= b) out.push(anchor); }
  else if (item.cadence === 'weekly' || item.cadence === 'biweekly') {
    const step = item.cadence === 'weekly' ? 7 : 14;
    let d = anchor; if (d < a) d += Math.ceil((a - d) / step) * step;
    for (; d <= b; d += step) out.push(d);
  } else {
    const stepMonths = item.cadence === 'quarterly' ? 3 : item.cadence === 'annual' ? 12 : 1;
    const ad = new Date(anchor * DAY); const days = [ad.getUTCDate()];
    if (item.cadence === 'semimonthly') days.push(item.secondDay ?? ((ad.getUTCDate() + 14) % 28) + 1);
    let y = ad.getUTCFullYear(), m = ad.getUTCMonth();
    for (let guard = 0; guard < 600; guard++) {
      const first = Math.round(Date.UTC(y, m, 1) / DAY);
      if (first > b) break;
      for (const dd of days) { const d = dayInMonth(y, m, dd); if (d >= a && d <= b && d >= anchor) out.push(d); }
      m += stepMonths; y += Math.floor(m / 12); m %= 12;
    }
  }
  return out.sort((x, y) => x - y).map(fromDay);
}

export interface CashOverrides { delays?: { itemId: string; days: number }[]; extra?: CashItem[]; scaleInflowsPct?: number }
export interface CashLine { date: string; name: string; category: string; direction: 'in' | 'out'; amountCents: number; itemId: string; dueDate?: string }
/** Categories paid in the weekly bill run when a bill-pay day is set. Payroll, rent, taxes and loan payments keep their own dates. */
export const BILL_RUN_CATEGORIES = ['vendor', 'credit_card'];
export interface CashWeek { index: number; weekStart: string; weekEnd: string; beginCents: number; inflowCents: number; outflowCents: number; endCents: number; belowFloor: boolean; lines: CashLine[] }
export interface CashForecast { weeks: CashWeek[]; beginCents: number; endCents: number; lowestCents: number; lowestWeek: string; floorCents: number; weeksBelowFloor: number; totalIn: number; totalOut: number }

export function forecast13(startDate: string, beginCents: number, items: CashItem[], floorCents: number, ov: CashOverrides = {}, weeks = 13, billPayWeekday: number | null = null): CashForecast {
  const end = addDays(startDate, weeks * 7 - 1);
  const payDay = (d: string) => { const dow = new Date(d + 'T00:00:00Z').getUTCDay(); const p = addDays(d, -((dow - (billPayWeekday as number) + 7) % 7)); return p < startDate ? startDate : p; };
  const all = [...items.filter((i) => i.active), ...(ov.extra ?? [])];
  const lines: CashLine[] = [];
  for (const it of all) {
    const delay = ov.delays?.find((d) => d.itemId === it.id)?.days ?? 0;
    // Look back by the delay so events pushed into the window are captured.
    const run = billPayWeekday !== null && it.direction === 'out' && BILL_RUN_CATEGORIES.includes(it.category);
    for (const date of occurrences(it, addDays(startDate, -Math.max(delay, 0)), run ? addDays(end, 6) : end)) {
      const due = addDays(date, delay); if (due < startDate) continue;
      const shifted = run ? payDay(due) : due;
      if (shifted < startDate || shifted > end) continue;
      const scale = it.direction === 'in' && ov.scaleInflowsPct !== undefined && !ov.extra?.includes(it) ? 1 + ov.scaleInflowsPct : 1;
      lines.push({ date: shifted, name: it.name, category: it.category, direction: it.direction, amountCents: Math.round(it.amountCents * scale), itemId: it.id, ...(run && shifted !== due ? { dueDate: due } : {}) });
    }
  }
  lines.sort((a, b) => a.date.localeCompare(b.date));
  const out: CashWeek[] = []; let cash = beginCents;
  for (let w = 0; w < weeks; w++) {
    const ws = addDays(startDate, w * 7), we = addDays(ws, 6);
    const wl = lines.filter((l) => l.date >= ws && l.date <= we);
    const inflow = wl.filter((l) => l.direction === 'in').reduce((a, l) => a + l.amountCents, 0);
    const outflow = wl.filter((l) => l.direction === 'out').reduce((a, l) => a + l.amountCents, 0);
    const begin = cash; cash = begin + inflow - outflow;
    out.push({ index: w + 1, weekStart: ws, weekEnd: we, beginCents: begin, inflowCents: inflow, outflowCents: outflow, endCents: cash, belowFloor: cash < floorCents, lines: wl });
  }
  const low = out.reduce((a, w) => (w.endCents < a.endCents ? w : a), out[0]);
  return { weeks: out, beginCents, endCents: cash, lowestCents: low.endCents, lowestWeek: low.weekStart, floorCents, weeksBelowFloor: out.filter((w) => w.belowFloor).length, totalIn: out.reduce((a, w) => a + w.inflowCents, 0), totalOut: out.reduce((a, w) => a + w.outflowCents, 0) };
}

const PER_YEAR: Record<Cadence, number> = { once: 0, weekly: 52, biweekly: 26, semimonthly: 24, monthly: 12, quarterly: 4, annual: 1 };
/** Average monthly amount of recurring non-P&L cash uses, for the monthly scenario baseline. */
export function nonPnlMonthly(items: CashItem[]): number {
  return Math.round(items.filter((i) => i.active && i.direction === 'out' && NON_PNL_CATEGORIES.includes(i.category)).reduce((a, i) => a + (i.amountCents * PER_YEAR[i.cadence]) / 12, 0));
}

/** Payables groups for the weekly cash flow forecast report: five short categories, plus what does not fit them. */
export const PAYABLE_GROUPS: [string, string[]][] = [['General bills', ['vendor', 'credit_card', 'other_out']], ['Payroll', ['payroll']], ['Payroll taxes and benefits', ['payroll_taxes']], ['Rent', ['rent']], ['Debt payments', ['loan_payment']], ['Taxes, equipment and distributions', ['estimated_taxes', 'capital_purchase', 'owner_distribution']]];
export interface TwoWeek { weeks: { weekStart: string; weekEnd: string; beginCents: number; receiptsCents: number; payables: { group: string; cents: number }[]; payablesCents: number; endCents: number; shortCents: number }[]; }
/** First two weeks of the forecast, with payables grouped. `shortCents` is how far cash falls below zero before any line-of-credit draw. */
export function twoWeekView(f: CashForecast): TwoWeek {
  return { weeks: f.weeks.slice(0, 2).map((w) => { const out = w.lines.filter((l) => l.direction === 'out');
    const payables = PAYABLE_GROUPS.map(([group, cats]) => ({ group, cents: out.filter((l) => cats.includes(l.category)).reduce((a, l) => a + l.amountCents, 0) }));
    return { weekStart: w.weekStart, weekEnd: w.weekEnd, beginCents: w.beginCents, receiptsCents: w.inflowCents, payables, payablesCents: w.outflowCents, endCents: w.endCents, shortCents: Math.max(0, -w.endCents) }; }) };
}
