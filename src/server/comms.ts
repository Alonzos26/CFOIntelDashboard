// Staff-only client communications: data for the monthly email draft and meeting script, the statements packet (PDF) and the draft email file.
// Built from approved months only, so nothing unreviewed can reach a client through a packet.
import { type Db } from './db.ts';
import * as svc from './services.ts';
import { Flow, Pdf, type Col } from './pdf.ts';
import { DEFAULT_EMAIL, type Commentary, highlights, measureActual, measureTarget, meetingScript, renderTemplate, scriptText } from '../engine/comms.ts';
import { buildScorecard, type Scorecard } from '../engine/scorecard.ts';
import { rolling3 } from '../engine/reporting.ts';
import { BS_LINES, LINE_LABELS, type PnlResult, computePnl, coreCapital, fmtMoney, fmtPct, periodLabel, rolling12, ytd } from '../engine/core.ts';

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
  return { ready: true as const, clientName: tenant.name as string, synthetic: !!tenant.is_synthetic, period: cur.period, months, idx, settings: s, month, prior, ytd: y, r12: r, scorecard, commentary, scorecardPublished: !!pub, insights, coreCapital: cc, contacts, actions, notices, vars, highlights: hl, script, recent };
}
export type Gathered = Extract<ReturnType<typeof gather>, { ready: true }>;

export function template(db: Db, tenantId: string) {
  const r = db.get('SELECT t.subject, t.body, t.updated_at, u.name FROM comm_templates t LEFT JOIN users u ON u.id = t.updated_by WHERE t.tenant_id = ?', tenantId);
  return r ? { subject: r.subject as string, body: r.body as string, custom: true, updatedAt: r.updated_at as string, updatedBy: r.name as string | null } : { ...DEFAULT_EMAIL, custom: false, updatedAt: null, updatedBy: null };
}
export function draft(db: Db, tenantId: string, g: Gathered) { const t = template(db, tenantId); const subject = renderTemplate(t.subject, g.vars); const body = renderTemplate(t.body, g.vars); return { subject: subject.text.trim(), body: body.text, unknown: [...new Set([...subject.unknown, ...body.unknown])], empty: [...new Set([...subject.empty, ...body.empty])] }; }
export const packetName = (g: Gathered) => `${g.vars.client_name.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${g.period}-financial-statements.pdf`;
export { scriptText };

// ---------- Monthly statements packet ----------
const $ = (c: number) => fmtMoney(c); const pc = (r: { value: number | null }) => (r.value === null ? 'n/a' : fmtPct(r.value));
export function packetPdf(g: Gathered, preparedBy: string, today = new Date().toISOString().slice(0, 10)): Buffer {
  const P = longPeriod(g.period); const name = g.vars.client_name;
  const f = new Flow(74, (fl) => { fl.pdf.text(fl.left, 40, name, { size: 9, bold: true, gray: 0.3 }); fl.pdf.text(fl.right, 40, `Monthly financial statements · ${P}`, { size: 9, align: 'right', gray: 0.3 }); fl.pdf.rule(fl.left, 48, fl.right, 0.6); });
  f.pdf.text(f.left, f.y + 22, name, { size: 22, bold: true }); f.y += 34; f.pdf.text(f.left, f.y + 13, `Monthly financial statements · ${P}`, { size: 13, gray: 0.25 }); f.y += 24;
  f.para(`Prepared by ${preparedBy}, ${FIRM_NAME}, on ${today}. Management statements for discussion: unaudited, and not prepared for lenders or tax filing.${g.synthetic ? ' SYNTHETIC DEMONSTRATION DATA: every figure in this packet is invented.' : ''}`, { size: 9, gray: 0.3, gap: 8 });
  const cols = (first: string, labels: string[]): Col[] => { const fw = labels.length > 3 ? 180 : 210; const w = (f.right - f.left - fw) / labels.length; return [{ label: first, width: fw }, ...labels.map((l) => ({ label: l, width: w, align: 'right' as const }))]; };
  const w = [g.month, g.ytd, g.r12] as PnlResult[]; const r12Label = g.r12.complete ? 'Rolling 12 months' : `Last ${g.r12.monthsIncluded} months`;
  f.heading('The month at a glance');
  f.table(cols('', [P, 'Year to date', r12Label]), [
    { cells: ['Sales', ...w.map((x) => $(x.lines.revenue))] }, { cells: ['Gross profit before labor', ...w.map((x) => $(x.grossProfit))] }, { cells: ['  as % of sales', ...w.map((x) => pc(x.grossMarginPct))], gray: 0.4 },
    { cells: ['True pretax profit', ...w.map((x) => $(x.adjustedPretax))], bold: true }, { cells: ['  as % of sales', ...w.map((x) => pc(x.adjustedPretaxPct))], gray: 0.4 },
    ...(g.months[g.idx].bs ? [{ cells: ['Cash at month end', $(g.months[g.idx].bs!.cash), '', ''] }] : []), ...(g.coreCapital.available !== null ? [{ cells: ['Core capital / target', `${$(g.coreCapital.available)} / ${$(g.coreCapital.target)}`, '', ''] }] : []) ]);
  f.para('True pretax profit is profit before income tax after paying the owner a market-rate wage for the work they do.', { size: 8.5, gray: 0.4 });
  f.heading('What stood out'); g.highlights.forEach((h) => f.bullet(h));
  f.heading(`Scorecard · rolling 12 months to ${periodLabel(g.period)}`);
  f.table([{ label: 'Measure', width: 190 }, { label: 'Actual', width: 130, align: 'right' }, { label: 'Target', width: 130, align: 'right' }, { label: 'Grade', width: f.right - f.left - 450, align: 'right' }],
    [...g.scorecard.measures.map((m) => ({ cells: [m.label, measureActual(m).replace(' the cap', ''), measureTarget(m).replace(' the cap', ''), g.commentary[m.key]?.grade ?? m.grade], note: g.commentary[m.key]?.comment || undefined })),
      ...(g.commentary.tax?.comment || g.commentary.tax?.grade ? [{ cells: ['Tax implications', '', '', g.commentary.tax.grade ?? 'N/A'], note: g.commentary.tax.comment || undefined }] : [])]);
  f.para('Grades compare each result with targets set for this business. They are not industry averages.', { size: 8.5, gray: 0.4 });
  // Management P&L
  f.newPage(); f.heading('Management profit and loss');
  const c4 = [g.month, g.prior, g.ytd, g.r12] as (PnlResult | null)[]; const v = (fn: (x: PnlResult) => number) => c4.map((x) => (x ? $(fn(x)) : '—')); const L = (k: keyof PnlResult['lines']) => v((x) => x.lines[k]);
  f.table(cols('', [P, 'Prior month', 'Year to date', g.r12.complete ? 'Rolling 12' : `Last ${g.r12.monthsIncluded} mo.`]), [
    { cells: ['Sales', ...L('revenue')], bold: true }, { cells: ['Non-labor cost of goods sold', ...L('cogs')] }, { cells: ['Gross profit before labor', ...v((x) => x.grossProfit)], bold: true, rule: true },
    { cells: ['Direct labor', ...L('direct_labor')] }, { cells: ['Contribution margin', ...v((x) => x.contributionMargin)], bold: true, rule: true },
    { cells: ['Management and office labor', ...L('mgmt_labor')] }, { cells: ['Facilities', ...L('facilities')] }, { cells: ['Marketing', ...L('marketing')] }, { cells: ['Payroll taxes and benefits', ...L('payroll_taxes_benefits')] }, { cells: ['Other operating expenses', ...L('other_opex')] },
    { cells: ['Operating income', ...v((x) => x.operatingIncome)], bold: true, rule: true }, { cells: ['Other income, depreciation and interest', ...v((x) => x.otherTotal)] },
    { cells: ['Pretax profit as booked', ...v((x) => x.pretax)], bold: true, rule: true }, { cells: ['Owner pay adjustment to market wage', ...v((x) => -x.ownerAdj)] }, { cells: ['True pretax profit', ...v((x) => x.adjustedPretax)], bold: true, rule: true },
    { cells: ['  as % of sales', ...c4.map((x) => (x ? pc(x.adjustedPretaxPct) : '—'))], gray: 0.4 } ]);
  f.para(`Year to date runs from ${periodLabel(g.ytd.from)}. ${g.r12.complete ? '' : `A full rolling twelve months is not yet available; the last column covers ${g.r12.monthsIncluded} months. `}Accounts are grouped into the lines above; the dashboard shows the accounts behind each line.`, { size: 8.5, gray: 0.4 });
  // Balance sheet
  const bs = g.months[g.idx].bs; const pb = g.idx > 0 ? g.months[g.idx - 1].bs : null;
  if (bs) { f.newPage(); f.heading('Balance sheet'); const A = ['cash', 'accounts_receivable', 'other_current_assets', 'fixed_assets', 'accumulated_depreciation', 'other_assets'] as const; const Li = ['accounts_payable', 'credit_cards', 'other_current_liabilities', 'line_of_credit', 'notes_payable'] as const;
    /* accumulated depreciation is stored as a negative asset */ const val = (b: typeof bs, k: string) => (b as any)[k] as number; const tot = (b: typeof bs, ks: readonly string[]) => ks.reduce((a, k) => a + val(b, k), 0);
    const row = (label: string, fn: (b: typeof bs) => number, o: { bold?: boolean; rule?: boolean } = {}) => ({ cells: [label, $(fn(bs)), pb ? $(fn(pb)) : '—', pb ? $(fn(bs) - fn(pb)) : '—'], ...o });
    f.table(cols('', [periodLabel(g.period), 'Prior month', 'Change']), [...A.map((k) => row(LINE_LABELS[k] ?? k, (b) => val(b, k))), row('Total assets', (b) => tot(b, A), { bold: true, rule: true }), ...Li.map((k) => row(LINE_LABELS[k] ?? k, (b) => val(b, k))), row('Total liabilities', (b) => tot(b, Li), { bold: true, rule: true }), row("Owners' equity", (b) => b.equity, { bold: true }), row('Total liabilities and equity', (b) => tot(b, Li) + b.equity, { bold: true, rule: true })]);
    void BS_LINES; }
  f.heading('Where to look next');
  f.para('Your dashboard is kept current with these figures. It has the full scorecard with trends, the 13-week cash forecast, the rolling twelve-month view, and a what-if forecast for testing a decision before you make it.');
  f.para(`Questions about anything here go to ${preparedBy} at ${FIRM_NAME}.`);
  const n = f.pdf.pageCount; for (let i = 0; i < n; i++) f.pdf.onPage(i, () => { f.pdf.rule(f.left, Pdf.height - 44, f.right, 0.6); f.pdf.text(f.left, Pdf.height - 32, `${FIRM_NAME} · For management discussion · Unaudited${g.synthetic ? ' · SYNTHETIC DEMO DATA' : ''}`, { size: 8, gray: 0.4 }); f.pdf.text(f.right, Pdf.height - 32, `Page ${i + 1} of ${n}`, { size: 8, align: 'right', gray: 0.4 }); });
  return f.pdf.build({ title: `${name} - ${P} financial statements`, author: FIRM_NAME });
}

// ---------- Draft email file (.eml) with the packet attached ----------
const b64 = (b: Buffer) => b.toString('base64').replace(/(.{76})/g, '$1\r\n'); const hdr = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);
/** An unsent message that opens as a draft in Outlook, Apple Mail and most desktop mail programs. Nothing is sent by this application. */
export function emailFile(o: { to: string[]; subject: string; body: string; attachment: Buffer; filename: string }): Buffer {
  const bd = `----sjats-${Buffer.from(o.filename).toString('hex').slice(0, 24)}`; const safe = (s: string) => s.replace(/[\r\n]+/g, ' ');
  return Buffer.from([`To: ${o.to.map(safe).join(', ')}`, `Subject: ${hdr(safe(o.subject))}`, 'X-Unsent: 1', 'MIME-Version: 1.0', `Content-Type: multipart/mixed; boundary="${bd}"`, '', `--${bd}`, 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', b64(Buffer.from(o.body.replace(/\r?\n/g, '\r\n'), 'utf8')), `--${bd}`,
    `Content-Type: application/pdf; name="${o.filename}"`, 'Content-Transfer-Encoding: base64', `Content-Disposition: attachment; filename="${o.filename}"`, '', b64(o.attachment), `--${bd}--`, ''].join('\r\n'), 'utf8');
}
