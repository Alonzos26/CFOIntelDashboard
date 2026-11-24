// Client communications for the firm's staff: the monthly email draft and the meeting script.
// Everything is assembled from stored, approved figures. Nothing here is shown to clients.
import { type Insight } from './insights.ts';
import { type Measure, type Scorecard } from './scorecard.ts';
import { fmtMoney, fmtPct, fmtRatio, periodLabel } from './core.ts';
import { type Rolling3 } from './reporting.ts';

/** Rolling-three signals worth saying out loud: a real change in direction, not a seasonal swing. */
export const recentChanges = (r: Rolling3 | null | undefined) => (r ? r.signals.filter((x) => x.key !== 'gross_profit' && (x.status === 'better' || x.status === 'worse')) : []);

export const fmtMeasure = (v: number | null, kind: string) => (v === null ? 'N/A' : kind === 'pct' ? fmtPct(v) : kind === 'money' ? fmtMoney(v) : kind === 'ratio' ? fmtRatio(v) : `${Math.round(v)} days`);
export const measureActual = (m: Measure) => (m.key === 'salary_cap' && m.actual !== null ? `${fmtMoney(Math.abs(m.actual))} ${m.actual >= 0 ? 'under' : 'over'} the cap` : fmtMeasure(m.actual, m.actualKind));
export const measureTarget = (m: Measure) => (m.key === 'salary_cap' ? 'at or under the cap' : fmtMeasure(m.target, m.targetKind));
export type Commentary = Record<string, { grade?: string; comment?: string }>;

// ---------- Email template ----------
export const MERGE_FIELDS: [string, string][] = [
  ['client_name', 'Client business name'], ['first_name', "Main contact's first name"], ['period', 'Month being delivered, e.g. October 2026'], ['highlights', 'Two to four bullets drawn from the scorecard and insights'],
  ['revenue', 'Sales for the month'], ['revenue_ytd', 'Sales, fiscal year to date'], ['pretax_profit', 'True pretax profit for the month'], ['pretax_pct', 'True pretax profit as a share of sales'], ['pretax_profit_ytd', 'True pretax profit, fiscal year to date'],
  ['cash', 'Cash at month end'], ['personal_note', 'Your own note for this month (the line is dropped when left empty)'], ['dashboard_url', 'Link to the client dashboard'], ['advisor_name', 'Your name'], ['firm_name', 'Firm name'],
];
export const DEFAULT_EMAIL = {
  subject: '{{client_name}}: {{period}} financial statements and scorecard',
  body: `Hi {{first_name}},

Your {{period}} financial statements are attached. I have been through them, and this is what stood out to me:

{{highlights}}

The month at a glance:
- Sales: {{revenue}} for the month, {{revenue_ytd}} year to date
- True pretax profit: {{pretax_profit}} for the month ({{pretax_pct}} of sales), {{pretax_profit_ytd}} year to date
- Cash: {{cash}} at month end

{{personal_note}}

Your dashboard has the detail behind these numbers: the full scorecard, the cash forecast, and the what-if forecast, where you can test a decision before you make it.
{{dashboard_url}}

I would like to walk through this with you. Do you have 30 minutes in the next week or two? Reply with a time that works. And if anything is coming up, such as a hire, a large purchase or a price change, tell me now so we can run the numbers before you commit.

{{advisor_name}}
{{firm_name}}`,
};
/** Fill {{fields}}. Unknown fields are left in place and reported, so a typo in a template is seen rather than sent. */
export function renderTemplate(tpl: string, vars: Record<string, string>): { text: string; unknown: string[]; empty: string[] } {
  const unknown = new Set<string>(), empty = new Set<string>();
  let text = tpl.replace(/^[ \t]*\{\{\s*personal_note\s*\}\}[ \t]*\r?\n(\r?\n)?/m, (m) => ((vars.personal_note ?? '').trim() ? m : ''));
  text = text.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, k: string) => { if (!Object.hasOwn(vars, k)) { unknown.add(k); return m; } if (!vars[k].trim() && k !== 'personal_note') empty.add(k); return vars[k]; });
  return { text: text.replace(/\n{3,}/g, '\n\n').trim() + '\n', unknown: [...unknown], empty: [...empty] };
}
const ORDER = ['Caution', 'OK', 'Good', 'Great'];
const graded = (sc: Scorecard, c: Commentary) => sc.measures.map((m) => ({ m, grade: c[m.key]?.grade ?? m.grade, comment: c[m.key]?.comment ?? '' })).filter((x) => x.grade !== 'N/A');
/** Plain-sentence highlights: the strongest result, the ones that need attention, and the top insight. Figures only; no estimates. */
export function highlights(sc: Scorecard, c: Commentary, insights: Insight[], max = 4, recent: Rolling3 | null = null): string[] {
  const g = graded(sc, c); const out: string[] = []; const line = (x: { m: Measure; grade: string; comment: string }) => `${x.m.label}: ${measureActual(x.m)}${x.m.key === 'salary_cap' ? '' : ` against a target of ${measureTarget(x.m)}`}.${x.comment ? ` ${x.comment}` : ''}`;
  const best = [...g].sort((a, b) => ORDER.indexOf(b.grade) - ORDER.indexOf(a.grade))[0]; const watch = g.filter((x) => x.grade === 'Caution' || x.grade === 'OK').sort((a, b) => ORDER.indexOf(a.grade) - ORDER.indexOf(b.grade)).slice(0, 2);
  if (best && ORDER.indexOf(best.grade) >= 2) out.push(`Going well. ${line(best)}`);
  for (const w of watch) if (w !== best) out.push(`Needs attention. ${line(w)}`);
  const rc = recentChanges(recent)[0]; if (rc) { out.splice(Math.min(out.length, max - 1), out.length, ...out.slice(Math.min(out.length, max - 1))); if (out.length >= max) out.length = max - 1; out.push(`Recent direction. ${rc.text}`); }
  const top = insights[0]; if (top && out.length < max) out.push(`Worth a conversation. ${top.title.replace(/[.:]+$/, '')}: ${top.action}`);
  if (!out.length) out.push('Nothing out of line this month. The scorecard has the detail.');
  return out.slice(0, max);
}

// ---------- Meeting script ----------
export interface ScriptInput {
  clientName: string; firstName: string; advisorName: string; period: string; scorecard: Scorecard; commentary: Commentary; scorecardPublished: boolean; insights: Insight[];
  month: { revenue: number; truePretax: number; pretaxPct: number | null }; ytd: { revenue: number; truePretax: number; pretaxPct: number | null }; cash: number | null; coreCapital: { available: number | null; target: number } | null;
  actions: { title: string; owner: string; dueDate: string | null; status: string }[]; internal: string[]; recent?: Rolling3 | null;
}
export interface ScriptSection { heading: string; minutes: number; say: string[]; ask: string[]; internal: string[] }
const MEANING: Record<string, { what: string; ask: string }> = {
  profitability: { what: 'This is profit before tax, after paying you what the job would cost to fill. It is the one number that says whether the business itself is making money.', ask: 'Does that match how the month felt to you?' },
  sales: { what: 'This is sales over the last twelve months against the plan.', ask: 'What is in the pipeline for the next ninety days, and is anything slipping?' },
  opex: { what: 'This is overhead: everything it costs to keep the doors open other than the people doing the work.', ask: 'Is there any spending here you would not approve again today?' },
  salary_cap: { what: 'The salary cap is the most the business can spend on payroll and still hit its profit target at this level of sales.', ask: 'Is anyone on the team not yet producing what their seat costs?' },
  labor: { what: 'Labor yield is the gross profit earned for each dollar of payroll. It is the best single measure of productivity.', ask: 'Where is the team waiting on work, or on each other?' },
  dso: { what: 'This is how many days customers take to pay.', ask: 'Who is the slowest payer right now, and who is going to call them this week?' },
  core_capital: { what: 'Operating reserve is cash in the bank with nothing drawn on the line of credit, measured against two months of operating costs.', ask: 'Until this is at target, are you comfortable taking distributions for taxes only?' },
};
const trendWord = (m: Measure) => (m.trend.improving === null ? (m.trend.direction === 'flat' ? 'It is holding steady.' : '') : m.trend.improving ? 'It is moving the right way.' : 'It has slipped since last time.');
export function meetingScript(i: ScriptInput): { title: string; minutes: number; sections: ScriptSection[] } {
  const P = periodLabel(i.period); const g = graded(i.scorecard, i.commentary); const weak = g.filter((x) => x.grade === 'Caution' || x.grade === 'OK'); const strong = g.filter((x) => x.grade === 'Great' || x.grade === 'Good');
  const pct = (v: number | null) => (v === null ? 'not available' : fmtPct(v)); const S: ScriptSection[] = [];
  S.push({ heading: 'Open', minutes: 2, say: [`${i.firstName}, thanks for making the time. I want to do three things today: show you where ${P} landed, go through the scorecard together, and agree on what we do about it before next month.`, 'Before I start: is there anything on your mind that you want to make sure we cover?'], ask: [], internal: ['Let them answer fully. Note it and come back to it by name later.', ...i.internal] });
  S.push({ heading: `The headline for ${P}`, minutes: 3, say: [`Sales for the month were ${fmtMoney(i.month.revenue)}, and true pretax profit was ${fmtMoney(i.month.truePretax)}, which is ${pct(i.month.pretaxPct)} of sales.`, `Year to date that makes ${fmtMoney(i.ytd.revenue)} in sales and ${fmtMoney(i.ytd.truePretax)} in true pretax profit, or ${pct(i.ytd.pretaxPct)}.`,
    ...(i.cash !== null ? [`You finished the month with ${fmtMoney(i.cash)} in cash.`] : []), strong.length || weak.length ? `On the scorecard, ${strong.length} ${strong.length === 1 ? 'measure is' : 'measures are'} in good shape and ${weak.length} ${weak.length === 1 ? 'needs' : 'need'} our attention. I will spend most of our time on ${weak.length ? 'those' : 'keeping it that way'}.` : 'The scorecard does not have enough history to grade yet, so today is about the trend.'],
    ask: ['Any surprises in those numbers?'], internal: ['One month is a data point. Keep pointing back to the rolling twelve months.', ...(i.recent ? i.recent.signals.filter((x) => x.status === 'seasonal' || x.status === 'mixed').map((x) => `Rolling three, do not over-read: ${x.text}`) : ['A rolling-three comparison is not available yet (needs twelve months of history).'])] });
  { const rc = recentChanges(i.recent); const head = S[S.length - 1]; if (rc.length) head.say.push('The twelve-month numbers move slowly, so I also look at the last three months to see which way things are heading.', ...rc.map((x) => x.text)); else if (i.recent) head.say.push('I also checked the last three months against the twelve-month picture and against the same months last year. Nothing has changed direction.'); }
  const order = [...weak.sort((a, b) => ORDER.indexOf(a.grade) - ORDER.indexOf(b.grade)), ...strong];
  S.push({ heading: 'Scorecard walk-through', minutes: Math.max(6, order.length * 2), say: order.flatMap((x) => { const mm = MEANING[x.m.key]; return [`${x.m.label}. ${mm?.what ?? ''} You are at ${measureActual(x.m)}${x.m.key === 'salary_cap' ? '' : `, and the target we set is ${measureTarget(x.m)}`}. That grades ${x.grade}. ${trendWord(x.m)}${x.comment ? ` My read: ${x.comment}` : ''}`.replace(/\s+/g, ' ').trim()]; }),
    ask: order.slice(0, 4).map((x) => `${x.m.label}: ${MEANING[x.m.key]?.ask ?? 'What do you make of that?'}`), internal: ['Share the Scorecard page on screen. Start with what needs attention while energy is high; finish on what is working.', ...(i.commentary.tax?.comment ? [`Tax implications (${i.commentary.tax.grade ?? 'not graded'}): ${i.commentary.tax.comment}`] : ['No tax implications note is recorded for this month. Add one on the Scorecard page if tax planning is in play.']), ...(i.scorecardPublished ? [] : ['The scorecard for this month is not published. The client still sees the previous one on their dashboard.'])] });
  if (i.coreCapital && i.coreCapital.available !== null) { const gap = i.coreCapital.available - i.coreCapital.target;
    S.push({ heading: 'Cash and operating reserve', minutes: 3, say: [`Operating reserve is ${fmtMoney(i.coreCapital.available)} against a target of ${fmtMoney(i.coreCapital.target)}.`, gap >= 0 ? `That is ${fmtMoney(gap)} above target. Taxes come first, then any debt, and what is left above the target is yours to distribute or reinvest.` : `That is ${fmtMoney(-gap)} short. Until it is closed, the order is taxes first, then debt, then building this reserve. Profit distributions wait.`], ask: ['Is there any large payment or purchase coming that I do not know about?'], internal: ['Open Cash Flow and show the Cash Flow Waterfall and the 13-week forecast.'] }); }
  const top = i.insights.slice(0, 3);
  if (top.length) S.push({ heading: 'What I would act on', minutes: top.length * 3, say: top.flatMap((x, k) => [`${['First', 'Second', 'Third'][k]}: ${x.title.replace(/[.:]+$/, '')}. ${x.observation} ${x.cause} What I suggest: ${x.action}${x.impactCents !== null && x.impactBasis ? ` On the numbers, that is worth about ${fmtMoney(x.impactCents)} (${x.impactBasis}).` : ''}`.replace(/\s+/g, ' ').trim()]), ask: ['Which of these do you want to take on first, and who owns it?'], internal: ['Do not offer a dollar impact where none is shown. If asked, say you will work it out in the what-if forecast.', 'Open the Decision Lab and run the change they pick, live, so they see profit and cash move.'] });
  S.push({ heading: 'Commitments and close', minutes: 3, say: [...(i.actions.length ? ['Here is where the actions we agreed on stand.', ...i.actions.slice(0, 5).map((a) => `${a.title}: ${a.status.replace('_', ' ')}${a.owner ? `, owned by ${a.owner}` : ''}${a.dueDate ? `, due ${a.dueDate}` : ''}.`)] : ['We do not have any open actions on the list, so let us leave today with one or two.']),
    'So, to confirm what each of us is doing before we meet again: I will record these in your dashboard today, with a name and a date on each.', `You will have next month's statements from me early in the month. Between now and then your dashboard is there whenever you want it, and I am a reply away.`], ask: ['What would make next month a win for you?', 'Same time next month?'], internal: ['Record every commitment under Goals & Actions before the end of the day and mark the ones the client should see.', 'Book the next meeting before you hang up.'] });
  return { title: `${i.clientName}: ${P} review`, minutes: S.reduce((a, s) => a + s.minutes, 0), sections: S };
}
export function scriptText(s: { title: string; minutes: number; sections: ScriptSection[] }): string {
  return [`${s.title}`, `About ${s.minutes} minutes. Internal document: not for the client.`, '', ...s.sections.flatMap((x, i) => [`${i + 1}. ${x.heading.toUpperCase()} (${x.minutes} min)`, '', ...x.say.map((l) => `SAY: ${l}`), ...(x.ask.length ? ['', ...x.ask.map((l) => `ASK: ${l}`)] : []), ...(x.internal.length ? ['', ...x.internal.map((l) => `[Note to self: ${l}]`)] : []), '', ''])].join('\n');
}
