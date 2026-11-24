// Staff-only client communications: data for the monthly email draft and meeting script, the statements packet (PDF) and the draft email file.
// Built from approved months only, so nothing unreviewed can reach a client through a packet.
import { type Db } from './db.ts';
import * as svc from './services.ts';
import { headlineFor, summaryFor } from './budget.ts';
import { type Deck, type Slide } from './slides.ts';
import { DEFAULT_EMAIL, type Commentary, highlights, measureActual, measureTarget, meetingScript, renderTemplate, scriptText } from '../engine/comms.ts';
import { buildScorecard, type Scorecard } from '../engine/scorecard.ts';
import { rolling3 } from '../engine/reporting.ts';
import { computePnl, coreCapital, fmtMoney, fmtPct, periodLabel, rolling12, ytd } from '../engine/core.ts';

export const FIRM_NAME = 'SJ Advisory & Tax';
const longPeriod = (p: string) => `${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][Number(p.slice(5, 7)) - 1]} ${p.slice(0, 4)}`;
export interface CommsOptions { advisorName: string; publicUrl: string | null; personalNote?: string; today?: string }

export function gather(db: Db, tenantId: string, o: CommsOptions) {
  const tenant = db.get('SELECT name, is_synthetic FROM tenants WHERE id = ?', tenantId)!; const s = svc.loadSettings(db, tenantId); const months = svc.loadMonths(db, tenantId, true);
  if (!months.length) return { ready: false as const, reason: 'No month has been approved yet. Approve a month under Review & Approval before preparing a client packet.', clientName: tenant.name as string };
  const idx = months.length - 1; const cur = months[idx]; const all = svc.loadMonths(db, tenantId, false);
  const month = computePnl(cur.pnl, cur.ownerAdj, s); const prior = idx > 0 ? computePnl(months[idx - 1].pnl, months[idx - 1].ownerAdj, s) : null; const y = ytd(months, idx, s)!; const r = rolling12(months, idx, s)!;
  const pub = db.get("SELECT commentary_json, snapshot_json FROM scorecards WHERE tenant_id = ? AND period = ? AND status = 'published'", tenantId, cur.period);
  const scorecard: Scorecard = pub ? JSON.parse(pub.snapshot_json) : buildScorecard(months, idx, s)!; const commentary: Commentary = pub ? JSON.parse(pub.commentary_json) : {};
  const insights = svc.insightsFor(db, tenantId); const cc = coreCapital(months, idx, s);
  const contacts = db.all("SELECT u.name, u.email, m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = ? AND m.role IN ('client_owner','client_manager') AND u.active = 1 ORDER BY m.role = 'client_owner' DESC, u.name", tenantId) as { name: string; email: string; role: string }[];
  const actions = db.all("SELECT title, owner, due_date, status FROM actions WHERE tenant_id = ? AND status IN ('open','in_progress') ORDER BY priority, due_date IS NULL, due_date LIMIT 8", tenantId).map((a) => ({ title: a.title as string, owner: a.owner as string, dueDate: a.due_date as string | null, status: a.status as string }));
  const basis = svc.accountingBasis(db, tenantId); const rhythm = svc.reportingRhythm(db, tenantId, o.today);
  const notices: string[] = [];
  if (all.length && all[all.length - 1].period > cur.period) notices.push(`${periodLabel(all[all.length - 1].period)} has been imported but is not approved. This packet covers ${periodLabel(cur.period)}, the latest approved month.`);
  if (!pub) notices.push(`The ${periodLabel(cur.period)} scorecard is not published. The packet shows calculated grades without your commentary; publish it on the Scorecard page to include your comments.`);
  if (basis.value !== 'accrual' && basis.text) notices.push(basis.text);
  if (rhythm.expectedPeriod === cur.period && rhythm.status === 'late') notices.push(rhythm.text);
  if (!contacts.length) notices.push('No client owner or manager is set up for this client, so the draft has no recipient. Add the address before sending.');
  const first = (contacts[0]?.name ?? '').replace(/\s*\(.*\)\s*/g, '').trim().split(/\s+/)[0] || 'there';
  const recent = rolling3(months, idx, s); const hl = highlights(scorecard, commentary, insights, 4, recent);
  const vars: Record<string, string> = { client_name: String(tenant.name).replace(/\s+[—-]\s+SYNTHETIC DEMO$/, ''), first_name: first, period: longPeriod(cur.period), highlights: hl.map((h) => `- ${h}`).join('\n'),
    revenue: fmtMoney(month.lines.revenue), revenue_ytd: fmtMoney(y.lines.revenue), pretax_profit: fmtMoney(month.adjustedPretax), pretax_pct: month.adjustedPretaxPct.value === null ? 'n/a' : fmtPct(month.adjustedPretaxPct.value), pretax_profit_ytd: fmtMoney(y.adjustedPretax),
    cash: cur.bs ? fmtMoney(cur.bs.cash) : 'not available (no balance sheet)', personal_note: (o.personalNote ?? '').trim(), dashboard_url: o.publicUrl ? `${o.publicUrl.replace(/\/$/, '')}/c/${tenantId}/overview` : '[link to your client portal]', advisor_name: o.advisorName, firm_name: FIRM_NAME };
  const script = meetingScript({ clientName: vars.client_name, firstName: first, advisorName: o.advisorName, period: cur.period, scorecard, commentary, scorecardPublished: !!pub, insights,
    month: { revenue: month.lines.revenue, truePretax: month.adjustedPretax, pretaxPct: month.adjustedPretaxPct.value }, ytd: { revenue: y.lines.revenue, truePretax: y.adjustedPretax, pretaxPct: y.adjustedPretaxPct.value }, cash: cur.bs?.cash ?? null,
    coreCapital: cc.available === null ? null : { available: cc.available, target: cc.target }, actions, internal: notices, recent });
  { const bl = headlineFor(db, tenantId, cur.period); if (bl) script.sections[1].say.push(`Against the budget we set for the year: ${bl}`); else script.sections[1].internal.push('No finalized budget exists for this fiscal year, so there is no budget-to-actual line.'); }
  return { ready: true as const, clientName: tenant.name as string, synthetic: !!tenant.is_synthetic, period: cur.period, months, idx, settings: s, month, prior, ytd: y, r12: r, scorecard, commentary, scorecardPublished: !!pub, insights, coreCapital: cc, contacts, actions, notices, vars, highlights: hl, script, recent,
    /** What the client's Overview page shows for this month: figure tiles, top priorities visible to the client, and the monthly trend. */ overview: (() => { const ov = svc.overview(db, tenantId, true, 'monthly'); return { cards: ov.cards, priorities: ov.priorities, trend: ov.trend ?? [] }; })(),
    /** Budget to actual and outlook, when a budget is finalized for the fiscal year. */ budget: summaryFor(db, tenantId, cur.period), basis: basis.value };
}
export type Gathered = Extract<ReturnType<typeof gather>, { ready: true }>;

export function template(db: Db, tenantId: string) {
  const r = db.get('SELECT t.subject, t.body, t.updated_at, u.name FROM comm_templates t LEFT JOIN users u ON u.id = t.updated_by WHERE t.tenant_id = ?', tenantId);
  return r ? { subject: r.subject as string, body: r.body as string, custom: true, updatedAt: r.updated_at as string, updatedBy: r.name as string | null } : { ...DEFAULT_EMAIL, custom: false, updatedAt: null, updatedBy: null };
}
export function draft(db: Db, tenantId: string, g: Gathered) { const t = template(db, tenantId); const subject = renderTemplate(t.subject, g.vars); const body = renderTemplate(t.body, g.vars); return { subject: subject.text.trim(), body: body.text, unknown: [...new Set([...subject.unknown, ...body.unknown])], empty: [...new Set([...subject.empty, ...body.empty])] }; }
export const packetName = (g: Gathered) => `${g.vars.client_name.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${g.period}-financial-statements.pdf`;
export { scriptText };

// The statements packet itself is built in packet.ts.
const $ = (c: number) => fmtMoney(c); const pc = (r: { value: number | null }) => (r.value === null ? 'n/a' : fmtPct(r.value));

// ---------- Draft email file (.eml) with the packet attached ----------
const b64 = (b: Buffer) => b.toString('base64').replace(/(.{76})/g, '$1\r\n'); const hdr = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);
/** An unsent message that opens as a draft in Outlook, Apple Mail and most desktop mail programs. Nothing is sent by this application. */
export function emailFile(o: { to: string[]; subject: string; body: string; attachment: Buffer; filename: string }): Buffer {
  const bd = `----sjats-${Buffer.from(o.filename).toString('hex').slice(0, 24)}`; const safe = (s: string) => s.replace(/[\r\n]+/g, ' ');
  return Buffer.from([`To: ${o.to.map(safe).join(', ')}`, `Subject: ${hdr(safe(o.subject))}`, 'X-Unsent: 1', 'MIME-Version: 1.0', `Content-Type: multipart/mixed; boundary="${bd}"`, '', `--${bd}`, 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', b64(Buffer.from(o.body.replace(/\r?\n/g, '\r\n'), 'utf8')), `--${bd}`,
    `Content-Type: application/pdf; name="${o.filename}"`, 'Content-Transfer-Encoding: base64', `Content-Disposition: attachment; filename="${o.filename}"`, '', b64(o.attachment), `--${bd}--`, ''].join('\r\n'), 'utf8');
}

// ---------- Meeting slides ----------
/** The deck that goes with the meeting script: same approved figures, one idea per slide, short enough to present in the meeting. */
export function deck(db: Db, tenantId: string, g: Gathered, preparedBy: string, today = new Date().toISOString().slice(0, 10)): Deck {
  const P = longPeriod(g.period); const name = g.vars.client_name; const w = [g.month, g.ytd, g.r12]; const cur = g.months[g.idx]; const slides: Slide[] = []; const b = summaryFor(db, tenantId, g.period);
  slides.push({ kind: 'title', title: name, subtitle: `${P} financial review\nPrepared by ${preparedBy}, ${FIRM_NAME} \u00b7 ${today}${g.synthetic ? '\nSYNTHETIC DEMONSTRATION DATA: every figure is invented' : ''}` });
  slides.push({ kind: 'content', title: 'The month at a glance', table: { head: ['', P, 'Year to date', g.r12.complete ? 'Rolling 12 months' : `Last ${g.r12.monthsIncluded} months`], widths: [2.2, 1, 1, 1], rows: [
    { cells: ['Sales', ...w.map((x) => $(x.lines.revenue))] }, { cells: ['Gross profit before labor', ...w.map((x) => $(x.grossProfit))] }, { cells: ['Gross profit %', ...w.map((x) => pc(x.grossMarginPct))] },
    { cells: ['True pretax profit', ...w.map((x) => $(x.adjustedPretax))], bold: true }, { cells: ['True pretax profit %', ...w.map((x) => pc(x.adjustedPretaxPct))], bold: true }, ...(cur.bs ? [{ cells: ['Cash at month end', $(cur.bs.cash), '', ''] }] : [])] },
    note: 'True pretax profit is profit before income tax, after paying the owner a market-rate wage.' });
  slides.push({ kind: 'content', title: 'What stood out', bullets: g.highlights });
  const r3 = (k: string) => { const x = g.recent?.signals.find((z) => z.key === k); return !x?.status ? '' : x.status === 'better' ? 'Improving' : x.status === 'worse' ? 'Slipping' : x.status === 'seasonal' ? 'Seasonal' : x.status === 'mixed' ? 'Unclear' : 'In line'; };
  slides.push({ kind: 'content', title: 'Scorecard', table: { head: ['Measure', 'Actual', 'Target', 'Last 3 months', 'Grade'], widths: [2, 1.6, 1.4, 1.1, 0.8], rows: g.scorecard.measures.map((m) => ({ cells: [m.label, measureActual(m).replace(' the cap', ''), measureTarget(m).replace(' the cap', ''), r3(m.key), g.commentary[m.key]?.grade ?? m.grade] })) },
    note: 'Grades are on the rolling twelve months, against targets set for this business. The last three months show direction only.' });
  if (b?.bva) { const pick = ['revenue', 'gross_profit', 'direct_labor', 'mgmt_labor', 'operating_income', 'true_pretax']; const sign = (c: number) => (c < 0 ? `(${$(-c)})` : $(c));
    slides.push({ kind: 'content', title: `Budget to actual \u00b7 ${b.label} year to date`, lead: b.bva.headline, table: { head: ['', 'Actual', 'Budget', 'Difference', 'Full-year budget'], widths: [2.2, 1, 1, 1, 1.1], rows: b.bva.rows.filter((r) => pick.includes(r.key)).map((r) => ({ cells: [r.label, $(r.ytd.actual), $(r.ytd.budget), sign(r.ytd.variance), $(r.fullYearBudget)], bold: r.kind === 'subtotal' })) } });
    if (b.bva.drivers.length) slides.push({ kind: 'content', title: 'Why actual differs from the plan', bullets: b.bva.drivers.slice(0, 5), note: 'The budget is fixed as it was set. Differences show where to look, not what happened.' }); }
  if (b?.outlook && !b.outlook.uncoveredMonths.length) { const o = b.outlook; const h = (x: typeof o.next3, t: string) => (x ? `${t}: ${$(x.revenue)} of sales and ${$(x.truePretax)} of true pretax profit${x.truePretaxPct.value === null ? '' : ` (${fmtPct(x.truePretaxPct.value)})`}.` : `${t}: not available yet.`);
    slides.push({ kind: 'content', title: 'Outlook: where the year is heading', lead: o.headline, bullets: [h(o.next3, 'Next 3 months'), h(o.next12, 'Next 12 months')], note: 'A forecast, rebuilt from the latest results each month. It is an estimate, not a result.' }); }
  if (cur.bs) { const cc = g.coreCapital; const bl = [`Cash at the end of ${P}: ${$(cur.bs.cash)}.`];
    if (cc.available !== null) { const gap2 = cc.available - cc.target; bl.push(`Operating reserve: ${$(cc.available)} against a target of ${$(cc.target)}.`, gap2 >= 0 ? `That is ${$(gap2)} above target. Taxes come first, then debt; what is left above the target can be distributed or reinvested.` : `That is ${$(-gap2)} short. Until it is closed: taxes first, then debt, then the reserve. Profit distributions wait.`); }
    if (cur.bs.line_of_credit > 0) bl.push(`Line of credit balance: ${$(cur.bs.line_of_credit)}.`); slides.push({ kind: 'content', title: 'Cash and operating reserve', bullets: bl }); }
  if (g.insights.length) slides.push({ kind: 'content', title: 'What we suggest acting on', bullets: g.insights.slice(0, 3).map((x) => `${x.title.replace(/[.:]+$/, '')}: ${x.action}`) });
  slides.push({ kind: 'content', title: 'Commitments and next steps', bullets: [...(g.actions.length ? g.actions.slice(0, 5).map((a) => `${a.title}${a.owner ? ` \u00b7 ${a.owner}` : ''}${a.dueDate ? ` \u00b7 due ${a.dueDate}` : ''} \u00b7 ${a.status.replace('_', ' ')}`) : ['No open actions yet. Agree one or two today, each with an owner and a date.']), 'Next review: same time next month.'] });
  return { title: `${name} - ${P} financial review`, author: FIRM_NAME, footer: `${name} \u00b7 ${P} \u00b7 ${FIRM_NAME} \u00b7 For management discussion \u00b7 Unaudited${g.synthetic ? ' \u00b7 SYNTHETIC DEMO DATA' : ''}`, slides };
}
export const deckName = (g: Gathered, ext: string) => packetName(g).replace('financial-statements.pdf', `review-slides.${ext}`);
