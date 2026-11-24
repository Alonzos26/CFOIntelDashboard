// Monthly statements packet (PDF) sent to the client: the Overview page first (figure tiles, scorecard, top priorities and the monthly trend),
// then the statements from Profit & Performance: management P&L, budget to actual, balance sheet and cash flow statement.
// Landscape US Letter. Built from approved months only (see gather in comms.ts), so nothing unreviewed can reach a client through a packet.
import { FIRM_NAME, type Gathered } from './comms.ts';
import { Flow, type Col, type RGB, decodePng, hex, textWidth, wrap } from './pdf.ts';
import { measureActual, measureTarget } from '../engine/comms.ts';
import { LINE_LABELS, type PnlResult, cashFlowMonth, computePnl, fmtMoney, fmtPct, fmtRatio, periodLabel, ytd } from '../engine/core.ts';

const MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const longPeriod = (p: string) => `${MONTH[Number(p.slice(5, 7)) - 1]} ${p.slice(0, 4)}`;
const $ = (c: number) => fmtMoney(c); const pc = (r: { value: number | null }) => (r.value === null ? 'n/a' : fmtPct(r.value));
// Same colours as the dashboard charts; text colours are darker steps of the status colours so they stay readable in print.
const NAVY = hex('#231a52'), BLUE = hex('#2a78d6'), ORANGE = hex('#eb6834'), NEUTRAL = hex('#898781'), GOOD = hex('#0a7a2a'), BAD = hex('#c23030'), AMBER = hex('#9a6700'), EDGE = hex('#dcdbd6'), GRID = hex('#e6e5e0');
const GRADE: Record<string, RGB> = { Great: GOOD, Good: hex('#1f5fb0'), OK: AMBER, Caution: BAD };
const fmtV = (v: number | null, kind: string) => (v === null ? 'N/A' : kind === 'money' ? fmtMoney(v, { compact: true }) : kind === 'pct' ? fmtPct(v) : kind === 'ratio' ? fmtRatio(v) : kind === 'months' ? `${v.toFixed(1)} mo` : String(v));
const fit = (s: string, size: number, w: number, bold = false) => { if (textWidth(s, size, bold) <= w) return s; let t = s; while (t.length > 3 && textWidth(`${t}…`, size, bold) > w) t = t.slice(0, -1); return `${t.trimEnd()}…`; };
const clip = (lines: string[], n: number) => (lines.length <= n ? lines : [...lines.slice(0, n - 1), `${lines[n - 1].replace(/[\s.,;:]+$/, '')}…`]);
/** Round axis steps: 1, 2 or 5 times a power of ten, giving about five gridlines. */
function ticks(lo: number, hi: number) { const span = hi - lo || 1; const raw = span / 5; const mag = 10 ** Math.floor(Math.log10(raw)); const step = [1, 2, 5, 10].map((k) => k * mag).find((x) => x >= raw)!; const a = Math.floor(lo / step) * step, b = Math.ceil(hi / step) * step; const out: number[] = []; for (let v = a; v <= b + step / 2; v += step) out.push(v); return out; }

export interface PacketOptions { today?: string; /** PNG file contents for the firm's logo; the firm name is printed when absent or unreadable. */ logo?: Buffer | null }
export function packetPdf(g: Gathered, preparedBy: string, o: PacketOptions = {}): Buffer {
  const today = o.today ?? new Date().toISOString().slice(0, 10); const P = longPeriod(g.period); const name = g.vars.client_name; const s = g.settings; const cur = g.months[g.idx];
  const basis = g.basis === 'cash' ? 'Cash basis' : g.basis === 'accrual' ? 'Accrual basis' : g.basis === 'mixed' ? 'Mixed cash and accrual basis' : 'Accounting basis not recorded';
  const png = o.logo ? decodePng(o.logo) : null; let title = 'Financial Scorecard'; let logo: { id: number; w: number; h: number } | null = null;
  const f = new Flow(100, (fl) => {
    if (logo) { const h = 44; fl.pdf.image(logo, fl.left, 30, (h * logo.w) / logo.h, h); } else fl.pdf.text(fl.left, 58, FIRM_NAME, { size: 14, bold: true, color: NAVY });
    fl.pdf.text(fl.right, 46, name, { size: 17, bold: true, align: 'right', color: NAVY }); fl.pdf.text(fl.right, 61, title, { size: 10.5, align: 'right' });
    fl.pdf.text(fl.right, 73, `Reporting period ${P}  |  Monthly  |  ${basis}  |  Unaudited${g.synthetic ? '  |  SYNTHETIC DEMO DATA' : ''}`, { size: 7.5, align: 'right', gray: 0.4 }); fl.pdf.rule(fl.left, 86, fl.right, 0.25, 0.6);
  }, { w: 792, h: 612, margin: 36, first: false });
  if (png) logo = f.pdf.addImage(png);
  const pdf = f.pdf; const L = f.left, R = f.right; f.header(); // first page header, drawn once the logo is registered

  // ---------- Page 1: the Overview page ----------
  const cards = g.overview.cards; const tw = (R - L - 30) / 4, th = 60;
  cards.slice(0, 8).forEach((k, i) => { const x = L + (i % 4) * (tw + 10), y = 98 + Math.floor(i / 4) * (th + 8);
    pdf.box(x, y, tw, th, { stroke: EDGE, width: 0.6 }); pdf.text(x + 8, y + 13, fit(k.label, 7.5, tw - 16), { size: 7.5, gray: 0.25 }); pdf.text(x + 8, y + 31, fmtV(k.value, k.kind), { size: 15, bold: true });
    const prior = k.compare?.value ?? null; const cmp = k.compare ? `vs ${k.compare.label.toLowerCase()}` : '';
    if (k.value === null || prior === null) pdf.text(x + 8, y + 43, 'no comparison', { size: 7, gray: 0.5 });
    else { const d = k.value - prior; if (Math.abs(d) < 1e-9) pdf.text(x + 8, y + 43, `No change ${cmp}`, { size: 7, gray: 0.4 });
      else { const col = (d > 0) === k.higherIsBetter ? GOOD : BAD; const t = k.kind === 'money' ? fmtMoney(Math.abs(d), { compact: true }) : k.kind === 'pct' ? `${Math.abs(d * 100).toFixed(1)} pts` : k.kind === 'months' ? `${Math.abs(d).toFixed(1)} mo` : Math.abs(d).toFixed(2);
        pdf.poly(d > 0 ? [[x + 8, y + 43], [x + 13, y + 43], [x + 10.5, y + 38.5]] : [[x + 8, y + 38.5], [x + 13, y + 38.5], [x + 10.5, y + 43]], col); pdf.text(x + 16, y + 43, t, { size: 7, bold: true, color: col }); pdf.text(x + 18 + textWidth(t, 7, true), y + 43, cmp, { size: 7, gray: 0.4 }); } }
    pdf.text(x + 8, y + 54, fit(k.target ? `${k.target.label}: ${fmtV(k.target.value, k.kind)}` : 'No target set', 6.5, tw - 16), { size: 6.5, gray: 0.4 });
    const pts = k.spark.map((v, j) => [j, v] as const).filter((p): p is readonly [number, number] => p[1] !== null);
    if (pts.length >= 2) { const lo = Math.min(...pts.map((p) => p[1])), hi = Math.max(...pts.map((p) => p[1])); const sx = x + tw - 68, sw = 58, sy = y + 10, sh = 22; const n = k.spark.length - 1 || 1;
      const xy = pts.map(([j, v]) => [sx + (j / n) * sw, hi === lo ? sy + sh / 2 : sy + sh - ((v - lo) / (hi - lo)) * sh] as [number, number]); pdf.line(xy, BLUE, 1); pdf.dot(xy[xy.length - 1][0], xy[xy.length - 1][1], 1.6, BLUE); } });
  let y = 244; pdf.text(L, y, 'Scorecard', { size: 11, bold: true }); pdf.text(L + 62, y, `Rolling ${g.scorecard.r12Complete ? '12' : g.scorecard.monthsIncluded} months to ${periodLabel(g.period)}`, { size: 8, gray: 0.4 }); y += 8;
  const X = { m: L + 4, a: L + 208, t: L + 304, tr: L + 320, g: L + 386, w: L + 446 }; const WW = R - X.w - 4;
  pdf.rule(L, y, R, 0.3, 0.6); for (const [x, lab, al] of [[X.m, 'MEASURE', 'left'], [X.a, 'ACTUAL', 'right'], [X.t, 'TARGET', 'right'], [X.tr, 'TREND', 'left'], [X.g, 'GRADE', 'left'], [X.w, 'WHAT IT SAYS', 'left']] as const) pdf.text(x, y + 11, lab, { size: 6.5, bold: true, gray: 0.3, align: al }); y += 16; pdf.rule(L, y, R, 0.6, 0.4);
  const rows = [...g.scorecard.measures.map((m) => { const c = g.commentary[m.key]; const tr = m.trend;
    return { label: m.label, actual: measureActual(m).replace(' the cap', ''), target: m.key === 'salary_cap' ? 'At or under' : measureTarget(m), sub: m.targetLabel, trend: tr.improving === null ? (tr.direction === 'flat' ? 'Steady' : 'No history') : tr.improving ? 'Improving' : 'Declining', trendCol: tr.improving === null ? null : tr.improving ? GOOD : BAD, grade: (c?.grade ?? m.grade) as string, says: c?.comment || m.note || m.basis }; }),
    ...(g.commentary.tax?.comment || g.commentary.tax?.grade ? [{ label: 'Tax implications', actual: '', target: '', sub: '', trend: 'Advisor review', trendCol: null as RGB | null, grade: g.commentary.tax.grade ?? 'N/A', says: g.commentary.tax.comment ?? '' }] : [])];
  const rh = Math.min(36, Math.max(24, (548 - y) / Math.max(rows.length, 1))); const maxLines = Math.max(1, Math.floor((rh - 6) / 9));
  for (const r of rows) { const says = clip(wrap(r.says ?? '', 7.5, WW).filter(Boolean), maxLines); const mid = y + rh / 2 + 3;
    pdf.text(X.m, mid, fit(r.label, 8.5, 150), { size: 8.5 }); pdf.text(X.a, mid, r.actual, { size: 8.5, align: 'right' });
    if (r.sub) { pdf.text(X.t, mid - 4, r.target, { size: 8.5, align: 'right' }); pdf.text(X.t, mid + 5, fit(r.sub, 6, 92), { size: 6, align: 'right', gray: 0.45 }); } else pdf.text(X.t, mid, r.target, { size: 8.5, align: 'right' });
    pdf.text(X.tr, mid, r.trend, r.trendCol ? { size: 8, color: r.trendCol } : { size: 8, gray: 0.4 });
    const gc = GRADE[r.grade]; if (gc) { pdf.dot(X.g + 2, mid - 2.8, 1.8, gc); pdf.text(X.g + 8, mid, r.grade, { size: 8, bold: true, color: gc }); } else pdf.text(X.g + 8, mid, r.grade, { size: 8, gray: 0.4 });
    says.forEach((l, i) => pdf.text(X.w, y + rh / 2 + 3 - ((says.length - 1) * 9) / 2 + i * 9, l, { size: 7.5, gray: 0.2 })); y += rh; pdf.rule(L, y, R, 0.88, 0.3); }
  const note1 = `Tiles show ${P} against the prior month. Scorecard measures cover the rolling ${g.scorecard.r12Complete ? 'twelve' : g.scorecard.monthsIncluded} months to ${periodLabel(g.period)}; trend compares them with the same measure three months earlier. Grades compare each result with targets set for this business; they are not industry averages.`;
  wrap(note1, 6.8, R - L).slice(0, 2).forEach((l, i) => pdf.text(L, 566 + i * 8.5, l, { size: 6.8, gray: 0.4 }));

  // ---------- Page 2: priorities and the monthly trend ----------
  title = 'Priorities and Monthly Trend'; f.newPage(); const lw = 330; y = 112; pdf.text(L, y, 'Your Top 3 Financial Priorities', { size: 11, bold: true }); y += 8;
  const para = (txt: string, size: number, opt: { bold?: boolean; gray?: number; color?: RGB } = {}, max = 6) => { for (const l of clip(wrap(txt, size, lw, opt.bold).filter(Boolean), max)) { y += size + 3; pdf.text(L, y, l, { size, ...opt }); } };
  const prios = g.overview.priorities as any[];
  if (!prios.length) { y += 6; para('No open priorities are recorded this month. Recommendations are posted to your dashboard after each review.', 8.5, { gray: 0.35 }); }
  prios.slice(0, 3).forEach((a, i) => { if (y > 500) return; y += 6; para(`${i + 1}. ${String(a.title).replace(/\.$/, '')}.`, 9.5, { bold: true }, 2); y += 1; if (a.observation) para(String(a.observation), 8.5, {}, 4); if (a.impact) para(String(a.impact), 8, { gray: 0.4 }, 3);
    if (a.recommendation) { y += 2; const lab = 'SUGGESTED NEXT STEP'; const lx = textWidth(lab, 6.5, true) + 6; const words = String(a.recommendation).split(/\s+/).filter(Boolean); const lines: string[] = []; let line = '';
      for (const w of words) { const t = line ? `${line} ${w}` : w; if (line && textWidth(t, 8.5) > lw - (lines.length ? 0 : lx)) { lines.push(line); line = w; } else line = t; } lines.push(line);
      clip(lines, 4).forEach((l, j) => { y += 11.5; if (j === 0) pdf.text(L, y, lab, { size: 6.5, bold: true, gray: 0.3 }); pdf.text(L + (j === 0 ? lx : 0), y, l, { size: 8.5 }); }); }
    if (a.impact_cents !== null && a.impact_cents !== undefined) { y += 2; para(`Estimated impact: ${fmtMoney(a.impact_cents)}${a.impact_basis ? ` (${a.impact_basis})` : ''}`, 8, { color: GOOD }, 2); }
    const who = [a.owner ? `Owner: ${a.owner}` : '', a.due_date ? `Due ${a.due_date}` : ''].filter(Boolean).join('  ·  '); if (who) para(who, 7, { gray: 0.45 }, 1);
    y += 9; if (i < Math.min(prios.length, 3) - 1) pdf.rule(L, y, L + lw, 0.8, 0.4); });
  // Trend chart: the same three series as the Overview page, for the last twelve months.
  const tr = g.overview.trend.slice(-12); const cx = L + lw + 24; pdf.text(cx, 112, 'Revenue, gross profit and true profit by month', { size: 11, bold: true });
  const SER: [string, (m: (typeof tr)[number]) => number, RGB][] = [['Revenue', (m) => m.revenue, NEUTRAL], ['Gross profit', (m) => m.grossProfit, BLUE], ['True pretax profit', (m) => m.adjustedPretax, ORANGE]];
  { let lx = cx; for (const [nm, , col] of SER) { pdf.box(lx, 121, 6, 6, { fill: col }); pdf.text(lx + 9, 127, nm, { size: 7.5, gray: 0.2 }); lx += 9 + textWidth(nm, 7.5) + 12; } }
  if (tr.length >= 2) { const all = tr.flatMap((m) => SER.map(([, fn]) => fn(m) / 100)); const top = Math.max(...all, 1), low = Math.min(0, ...all); /* a loss too small to see should not add an empty band below zero */ const tk = ticks(low < -0.03 * top ? low : 0, top); const lo = tk[0], hi = tk[tk.length - 1]; const px = cx + 40, pw = R - px - 6, py = 142, ph = 190;
    const Y = (v: number) => py + ph - ((v - lo) / (hi - lo)) * ph; const Xp = (i: number) => px + (i / (tr.length - 1)) * pw; const kfmt = (v: number) => { const a = Math.abs(v); const b = a >= 1_000_000 ? `$${(a / 1_000_000).toFixed(1)}M` : a >= 1000 ? `$${Math.round(a / 1000)}K` : `$${Math.round(a)}`; return v < 0 ? `(${b})` : b; };
    for (const v of tk) { pdf.rule(px, Y(v), px + pw, Math.abs(v) < 1e-9 ? 0.55 : 0.9, Math.abs(v) < 1e-9 ? 0.6 : 0.4); pdf.text(px - 6, Y(v) + 2.5, kfmt(v), { size: 7, align: 'right', gray: 0.4 }); } void GRID;
    tr.forEach((m, i) => { const mo = periodLabel(m.period).slice(0, 3); const lab = i === 0 || m.period.endsWith('-01') ? `${mo} '${m.period.slice(2, 4)}` : mo; pdf.text(Xp(i) - textWidth(lab, 7) / 2, py + ph + 12, lab, { size: 7, gray: 0.4 }); });
    for (const [, fn, col] of SER) { const pts = tr.map((m, i) => [Xp(i), Y(fn(m) / 100)] as [number, number]); pdf.line(pts, col, 1.6); const e = pts[pts.length - 1]; pdf.dot(e[0], e[1], 3.2, [1, 1, 1]); pdf.dot(e[0], e[1], 2.2, col); }
    const hiM = tr.reduce((a, b) => (b.adjustedPretax > a.adjustedPretax ? b : a)), loM = tr.reduce((a, b) => (b.adjustedPretax < a.adjustedPretax ? b : a)); let cy = py + ph + 24;
    for (const l of wrap(`True pretax profit was highest in ${periodLabel(hiM.period)} at ${$(hiM.adjustedPretax)} and lowest in ${periodLabel(loM.period)} at ${$(loM.adjustedPretax)}. It is profit before income tax after paying the owner a market-rate wage.`, 8, R - cx)) { cy += 11; pdf.text(cx, cy, l, { size: 8, gray: 0.35 }); }
    // The same figures as a small table, so nothing depends on reading the chart.
    cy += 16; const big = Math.max(...all.map(Math.abs)) >= 1_000_000; const lc = 74; const cw = (R - cx - lc) / tr.length; const k = (c: number) => { const v = c / 100_000; const b = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: big ? 0 : 1, maximumFractionDigits: big ? 0 : 1 }); return v < 0 ? `(${b})` : b; };
    pdf.rule(cx, cy - 9, R, 0.3, 0.6); tr.forEach((m, i) => pdf.text(cx + lc + (i + 1) * cw, cy, periodLabel(m.period).slice(0, 3), { size: 6.8, bold: true, align: 'right' })); cy += 4; pdf.rule(cx, cy, R, 0.6, 0.4);
    for (const [nm, fn] of SER) { cy += 11; pdf.text(cx, cy, nm, { size: 7 }); tr.forEach((m, i) => pdf.text(cx + lc + (i + 1) * cw, cy, k(fn(m)), { size: 6.8, align: 'right' })); cy += 3.5; pdf.rule(cx, cy, R, 0.88, 0.3); }
    cy += 10; pdf.text(cx, cy, 'Table in $ thousands.', { size: 6.5, gray: 0.45 });
    if (g.budget?.bva) { cy += 14; pdf.text(cx, cy, 'Against the budget', { size: 8.5, bold: true }); for (const l of clip(wrap(g.budget.bva.headline, 8, R - cx), 3)) { cy += 11; pdf.text(cx, cy, l, { size: 8, gray: 0.2 }); } }
  } else pdf.text(cx, 150, 'A trend needs at least two approved months.', { size: 8.5, gray: 0.4 });

  // ---------- Statements ----------
  title = 'Financial Statements'; f.newPage(); const W = R - L; const cols = (first: number, labels: string[]): Col[] => [{ label: '', width: first }, ...labels.map((l) => ({ label: l, width: (W - first) / labels.length, align: 'right' as const }))];
  const win = (i: number) => (i >= 0 ? computePnl(g.months[i].pnl, g.months[i].ownerAdj, s) : null); const priorYtd = g.idx - 12 >= 0 ? ytd(g.months, g.idx - 12, s) : null;
  const c6 = [g.month, g.prior, win(g.idx - 12), g.ytd, priorYtd, g.r12] as (PnlResult | null)[]; const v = (fn: (x: PnlResult) => number) => c6.map((x) => (x ? $(fn(x)) : '—')); const Ln = (k: keyof PnlResult['lines']) => v((x) => x.lines[k]);
  f.heading('Management profit and loss');
  f.table(cols(196, [periodLabel(g.period), g.idx > 0 ? periodLabel(g.months[g.idx - 1].period) : 'Prior month', g.idx - 12 >= 0 ? periodLabel(g.months[g.idx - 12].period) : 'Same month last year', 'Year to date', 'Prior year to date', g.r12.complete ? 'Rolling 12 months' : `Last ${g.r12.monthsIncluded} months`]), [
    { cells: ['Sales', ...Ln('revenue')], bold: true }, { cells: ['Non-labor cost of goods sold', ...Ln('cogs')] }, { cells: ['Gross profit before labor', ...v((x) => x.grossProfit)], bold: true, rule: true }, { cells: ['  as % of sales', ...c6.map((x) => (x ? pc(x.grossMarginPct) : '—'))], gray: 0.4 },
    { cells: ['Direct labor', ...Ln('direct_labor')] }, { cells: ['Contribution margin', ...v((x) => x.contributionMargin)], bold: true, rule: true },
    { cells: ['Management and office labor', ...Ln('mgmt_labor')] }, { cells: ['Facilities', ...Ln('facilities')] }, { cells: ['Marketing', ...Ln('marketing')] }, { cells: ['Payroll taxes and benefits', ...Ln('payroll_taxes_benefits')] }, { cells: ['Other operating expenses', ...Ln('other_opex')] },
    { cells: ['Operating income', ...v((x) => x.operatingIncome)], bold: true, rule: true }, { cells: ['Other income, depreciation and interest', ...v((x) => x.otherTotal)] },
    { cells: ['Pretax profit as booked', ...v((x) => x.pretax)], bold: true, rule: true }, { cells: ['Owner pay adjustment to market wage', ...v((x) => -x.ownerAdj)] }, { cells: ['True pretax profit', ...v((x) => x.adjustedPretax)], bold: true, rule: true },
    { cells: ['  as % of sales', ...c6.map((x) => (x ? pc(x.adjustedPretaxPct) : '—'))], gray: 0.4 } ], 9);
  f.para(`The first three columns are the month, the month before it and the same month a year earlier. Year to date runs from ${periodLabel(g.ytd.from)}. ${g.r12.complete ? '' : `A full rolling twelve months is not yet available; the last column covers ${g.r12.monthsIncluded} months. `}True pretax profit is profit before income tax after paying the owner a market-rate wage. Accounts are grouped into the lines above; the dashboard opens each line to the accounts inside it.${g.budget?.bva ? '' : ' No budget has been finalized for this fiscal year, so a budget to actual page is not included.'}`, { size: 8, gray: 0.4 });
  // Budget to actual: the locked budget against approved actuals.
  const b = g.budget?.bva;
  if (b) { f.newPage(); f.heading(`Budget to actual · ${g.budget!.label}`); f.para(b.headline, { size: 9.5, gap: 6 }); const mo = periodLabel(b.through).slice(0, 3); const tone = (fav: boolean | null) => (fav === null ? undefined : fav ? GOOD : BAD);
    const bc: Col[] = [{ label: '', width: 168 }, ...[`${mo} actual`, `${mo} budget`, 'Difference', 'YTD actual', 'YTD budget', 'Difference'].map((l) => ({ label: l, width: 60, align: 'right' as const })), { label: '%', width: 40, align: 'right' }, { label: 'Year to date', width: 70 }, { label: 'Full-year budget', width: W - 168 - 360 - 40 - 70, align: 'right' }];
    f.table(bc, b.rows.map((r) => ({ cells: [r.label, $(r.month.actual), $(r.month.budget), $(r.month.variance), $(r.ytd.actual), $(r.ytd.budget), $(r.ytd.variance), r.ytd.pct.value === null ? '—' : fmtPct(r.ytd.pct.value), r.ytd.favorable === null ? 'On budget' : r.ytd.favorable ? 'Favorable' : 'Unfavorable', $(r.fullYearBudget)], bold: r.kind === 'subtotal', rule: r.kind === 'subtotal',
      colors: [undefined, undefined, undefined, tone(r.month.favorable), undefined, undefined, tone(r.ytd.favorable), undefined, tone(r.ytd.favorable), undefined] })), 8.5);
    f.para(`Difference is actual less budget. Favorable means the difference adds to profit: more income or less cost than budgeted. The budget was finalized before the year began and is not changed afterward; year to date covers ${b.monthsElapsed} month${b.monthsElapsed === 1 ? '' : 's'}, and budget figures are rounded to the nearest $100.`, { size: 8, gray: 0.4, gap: 6 });
    if (b.drivers.length) { f.heading('Why actual differs from the plan', 10.5); b.drivers.slice(0, 5).forEach((d) => f.bullet(d, 8.5)); } }
  // Balance sheet
  const bs = cur.bs; const pb = g.idx > 0 ? g.months[g.idx - 1].bs : null; 
  // Prior year column: the balance sheet at the end of the prior fiscal year (December 31 for a calendar-year business).
  const pyEnd = (() => { const [yy, mm] = g.period.split('-').map(Number); const sy = mm >= s.fiscalYearStartMonth ? yy : yy - 1; const em = s.fiscalYearStartMonth === 1 ? 12 : s.fiscalYearStartMonth - 1; const ey = s.fiscalYearStartMonth === 1 ? sy - 1 : sy; return { period: `${ey}-${String(em).padStart(2, '0')}`, label: `${em}/${new Date(Date.UTC(ey, em, 0)).getUTCDate()}/${ey}` }; })();
  const yb = g.months.find((m) => m.period === pyEnd.period)?.bs ?? null;
  if (bs) { f.newPage(); f.heading('Balance sheet'); const A = ['cash', 'accounts_receivable', 'other_current_assets', 'fixed_assets', 'accumulated_depreciation', 'other_assets'] as const; const Li = ['accounts_payable', 'credit_cards', 'other_current_liabilities', 'line_of_credit', 'notes_payable'] as const;
    /* accumulated depreciation is stored as a negative asset */ const val = (x: typeof bs, k: string) => (x as any)[k] as number; const tot = (x: typeof bs, ks: readonly string[]) => ks.reduce((a, k) => a + val(x, k), 0);
    const row = (label: string, fn: (x: typeof bs) => number, o2: { bold?: boolean; rule?: boolean } = {}) => ({ cells: [label, $(fn(bs)), pb ? $(fn(pb)) : '—', pb ? $(fn(bs) - fn(pb)) : '—', yb ? $(fn(yb)) : '—'], ...o2 });
    f.table(cols(240, [periodLabel(g.period), 'Prior month', 'Change in the month', `Prior year (${pyEnd.label})`]), [...A.map((k) => row(LINE_LABELS[k] ?? k, (x) => val(x, k))), row('Total assets', (x) => tot(x, A), { bold: true, rule: true }), ...Li.map((k) => row(LINE_LABELS[k] ?? k, (x) => val(x, k))), row('Total liabilities', (x) => tot(x, Li), { bold: true, rule: true }), row("Owners' equity", (x) => x.equity, { bold: true }), row('Total liabilities and equity', (x) => tot(x, Li) + x.equity, { bold: true, rule: true })], 9);
    f.para(yb ? `Prior year is the balance sheet at ${pyEnd.label}, the end of the last fiscal year.` : `Prior year would show the balance sheet at ${pyEnd.label}, the end of the last fiscal year; no approved balance sheet is on file for that date.`, { size: 8, gray: 0.4 }); }
  // Cash flow statement (indirect), month by month, as on the Balance sheet & cash flow tab.
  const cfAt = (i: number) => (i > 0 && g.months[i].bs && g.months[i - 1].bs ? cashFlowMonth(g.months[i - 1].bs!, g.months[i].bs!, g.months[i].pnl) : null);
  const idxs = Array.from({ length: 6 }, (_, k) => g.idx - 5 + k).filter((i) => cfAt(i));
  if (idxs.length) { f.newPage(); f.heading('Cash flow statement'); type CF = NonNullable<ReturnType<typeof cfAt>>; const cfs = idxs.map((i) => cfAt(i)!);
    const fyIdx = g.months.map((m, i) => i).filter((i) => g.months[i].period >= g.ytd.from && i <= g.idx); const fyCf = fyIdx.map(cfAt); const haveYtd = fyCf.length > 1 && fyCf.every(Boolean);
    const sum = (fn: (c: CF) => number) => (fyCf as CF[]).reduce((a, c) => a + fn(c), 0); const other = (c: CF) => c.net - c.operations - c.investing - c.financing;
    const line = (label: string, fn: (c: CF) => number, o2: { bold?: boolean; rule?: boolean; ytd?: number | null } = {}) => ({ cells: [label, ...cfs.map((c) => $(fn(c))), ...(haveYtd ? [o2.ytd === null ? '' : $(o2.ytd ?? sum(fn))] : [])], bold: o2.bold, rule: o2.rule });
    const anyOther = [...cfs, ...(haveYtd ? (fyCf as CF[]) : [])].some((c) => Math.abs(other(c)) > 100), anyDiff = [...cfs, ...(haveYtd ? (fyCf as CF[]) : [])].some((c) => Math.abs(c.difference) > 100);
    f.table(cols(haveYtd ? 196 : 240, [...idxs.map((i) => periodLabel(g.months[i].period)), ...(haveYtd ? ['Year to date'] : [])]), [
      line('Pretax profit as booked', (c) => c.netIncome), line('Depreciation and working capital changes', (c) => c.operations - c.netIncome), line('Cash from operations', (c) => c.operations, { bold: true, rule: true }),
      line('Fixed asset purchases', (c) => c.investing), line('Line of credit, net', (c) => c.loc), line('Notes payable, net', (c) => c.notes), line('Distributions and other equity', (c) => c.equityOther), ...(anyOther ? [line('Other balance sheet changes', other)] : []),
      line('Net change in cash', (c) => c.net, { bold: true, rule: true }), line('Beginning cash', (c) => c.beginningCash, { ytd: haveYtd ? (fyCf[0] as CF).beginningCash : null }), ...(anyDiff ? [line('Difference not explained by the balance sheet', (c) => -c.difference)] : []),
      line('Ending cash', (c) => c.endingCashReported, { bold: true, rule: true, ytd: cur.bs ? cur.bs.cash : null }) ], 8.5);
    f.para(`Indirect method, built from the change between month-end balance sheets, so ending cash is the cash on the balance sheet. Working capital changes are the movements in receivables, payables, credit cards and other current balances. Pretax profit is as booked, before the owner-pay adjustment and before income tax.${haveYtd ? ` Year to date runs from ${periodLabel(g.ytd.from)}.` : ''}`, { size: 8, gray: 0.4, gap: 8 }); }
  f.heading('Where to look next', 10.5);
  f.para('Your dashboard is kept current with these figures. It has the full scorecard with trends, the 13-week cash forecast, the budget and outlook, and a what-if forecast for testing a decision before you make it.', { size: 9 });
  f.para(`Questions about anything here go to ${preparedBy} at ${FIRM_NAME}. Prepared ${today}.`, { size: 9 });
  const n = pdf.pageCount; for (let i = 0; i < n; i++) pdf.onPage(i, () => { pdf.text(L, pdf.h - 22, `${FIRM_NAME}  ·  Management statements for discussion  ·  Unaudited; not prepared for lenders or tax filing${g.synthetic ? '  ·  SYNTHETIC DEMO DATA: every figure is invented' : ''}`, { size: 7, gray: 0.4 }); pdf.text(R, pdf.h - 22, `Page ${i + 1} of ${n}`, { size: 7, align: 'right', gray: 0.4 }); });
  return pdf.build({ title: `${name} - ${P} financial statements`, author: FIRM_NAME });
}
