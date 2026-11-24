import React, { useMemo, useState } from 'react';
import { get, post, put, del, download } from './api.ts';
import { useT } from './App.tsx';
import { Async, Card, Delta, Drawer, Empty, ErrorNote, Field, Grade, Money, Note, Num, P, Pill, StatusPill, Term, dateLabel, fmt, useLoad } from './ui.tsx';
import { C, Chart, Spark } from './charts.tsx';
import { LINE_LABELS, PNL_LINES, type PnlLines, type Settings, computePnl, fmtMoney, fmtPct, fmtRatio, zeroPnl } from '../engine/core.ts';
import { type Measure, type Scorecard } from '../engine/scorecard.ts';
import { CADENCES, CASH_CATEGORIES } from '../engine/cash.ts';
import { fmtKpi } from '../engine/kpi.ts';
import { WagePlanCard } from './ownerwage.tsx';
import { BuyInCard, CapitalCard } from './capital.tsx';
import { CashReportsCard } from './cashreports.tsx';
import { ProductivityCard, RecentPill, RollingTab } from './rolling.tsx';
import { ProfitLevelsCard, ValuationCard } from './valuation.tsx';
import { WhatIfForecast } from './whatif.tsx';
import { FourForcesCard } from './fourforces.tsx';

const TERM: Record<string, string> = { gross_margin: 'Gross Margin', adjusted_pretax: 'Adjusted Pretax Profit', labor_efficiency: 'Direct LER', operating_cash_flow: 'Operating Cash Flow', reserve_coverage: 'Core Capital', cash: 'Core Capital' };
const MEASURE_TERM: Record<string, string> = { salary_cap: 'Salary Cap', dso: 'A/R DSO', core_capital: 'Core Capital', labor: 'Direct LER', profitability: 'Adjusted Pretax Profit' };
const KPI_PAGE: Record<string, string> = { labor: 'weekly', labor_efficiency: 'weekly', profitability: 'performance', salary_cap: 'performance', core_capital: 'cash', dso: 'cash', opex: 'performance', sales: 'performance' };

// ---------------------------------------------------------------- Overview
export function Overview() {
  const t = useT(); const [view, setView] = useState('monthly'); const [open, setOpen] = useState<any>(null);
  const r = useLoad(() => get(`${t.base}/overview?view=${view}`), [t.tid, view]);
  return <Async r={r}>{(d) => <>
    <div className="page-h">
      <div><h1>{d.header.tenantName}</h1>
        <p className="meta">{d.header.periodLabel ? <>Reporting period <b>{d.header.periodLabel}</b> · {d.header.viewLabel}{d.header.windowComplete === false && ` (${d.header.monthsIncluded} months available)`} · </> : null}<StatusPill status={d.header.status} /> · Last data refresh {dateLabel(d.header.lastImportAt)} · {d.header.dataSource}</p></div>
      <div className="controls">
        <label>Period<select value={view} onChange={(e) => (e.target.value === 'weekly' ? t.go('weekly') : setView(e.target.value))}><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="quarterly">Quarterly</option><option value="ytd">YTD</option><option value="r12">Rolling 12</option></select></label>
        <label>Scenario<select value="actual" onChange={(e) => e.target.value === 'custom' && t.go('lab')}><option value="actual">Actual</option><option disabled>Budget (Phase 2)</option><option disabled>Forecast (see Profit &amp; Performance)</option><option value="custom">Custom scenario…</option></select></label>
      </div>
    </div>
    {d.empty ? <Empty>{d.emptyReason}{t.can('import') && <> <button className="btn btn-primary" onClick={() => t.go('data')}>Import financial statements</button></>}</Empty> : <>
      <div className="kpis">{d.cards.map((k: any) => <button key={k.key} className="kpi" onClick={() => setOpen(k)}>
        <span className="kpi-l">{TERM[k.key] ? <Term name={TERM[k.key]}>{k.label}</Term> : k.label}</span>
        <span className="kpi-v">{fmt(k.value, k.kind, true)}</span>
        <span className="kpi-m"><Delta value={k.value} prior={k.compare?.value ?? null} kind={k.kind} higherIsBetter={k.higherIsBetter} /> <span className="muted">{k.compare ? `vs ${k.compare.label.toLowerCase()}` : ''}</span></span>
        <span className="kpi-f"><span className="muted">{k.target ? `${k.target.label}: ${fmt(k.target.value, k.kind, true)}` : 'No target set'}</span><Spark values={k.spark} /></span>
      </button>)}</div>
      <div className="grid-2">
        <Card title="Scorecard" right={d.scorecard ? <><StatusPill status={d.scorecard.status} /> <button className="btn btn-ghost" onClick={() => t.go('scorecard')}>Open</button></> : null}>
          {d.scorecard ? <ScorecardTable sc={d.scorecard.scorecard} commentary={d.scorecard.commentary} compact /> : <Empty>Your advisor has not published a scorecard yet.</Empty>}
        </Card>
        <Card title="Your Top 3 Financial Priorities" right={<button className="btn btn-ghost" onClick={() => t.go('actions')}>All actions</button>}>
          {d.priorities.length ? <ol className="prio">{d.priorities.map((a: any) => <li key={a.id}><Priority a={a} /></li>)}</ol> : <Empty>No open priorities. Your advisor will post recommendations here after reviewing your results.</Empty>}
        </Card>
      </div>
      <Card title="Revenue, gross profit and true profit by month"><Chart labels={d.trend.map((m: any) => P(m.period))} kind="money" zeroBased series={[{ name: 'Revenue', values: d.trend.map((m: any) => m.revenue), color: C.neutral }, { name: 'Gross profit', values: d.trend.map((m: any) => m.grossProfit), color: C.s1 }, { name: 'Adjusted pretax profit', values: d.trend.map((m: any) => m.adjustedPretax), color: C.s2 }]} /></Card>
    </>}
    {open && <Drawer title={open.label} onClose={() => setOpen(null)}>
      <div className="big">{fmt(open.value, open.kind)}</div>{open.note && <p className="muted">{open.note}</p>}
      <h4>What this means</h4><p>{open.explain.plain}</p>
      <h4>How it is calculated</h4><p className="mono">{open.explain.formula}</p>
      <h4>What drives it this period</h4><table className="tbl"><tbody>{open.explain.drivers.map((x: any) => <tr key={x.label}><td>{x.label}</td><td className="num">{fmt(x.value, x.kind)}</td></tr>)}{open.target && <tr><td>{open.target.label}</td><td className="num">{fmt(open.target.value, open.kind)}</td></tr>}</tbody></table>
      <Chart labels={open.sparkLabels} kind={open.kind} series={[{ name: open.label, values: open.spark }]} height={180} reference={open.target && open.kind !== 'money' ? { value: open.target.value, label: open.target.label } : undefined} />
      <h4>Possible next steps</h4><ul>{open.explain.actions.map((a: string) => <li key={a}>{a}</li>)}</ul>
      <div className="row"><button className="btn" onClick={() => t.go(KPI_PAGE[open.key] ?? 'performance')}>See the detail</button><button className="btn" onClick={() => t.go('lab')}>Test a scenario</button></div>
    </Drawer>}
  </>}</Async>;
}
function Priority({ a }: { a: any }) {
  const t = useT();
  return <div><b>{a.title}</b><p>{a.observation}</p>{a.impact && <p className="muted">{a.impact}</p>}<p><span className="lbl">Suggested next step</span> {a.recommendation}</p>
    <p className="meta">{a.owner && <>Owner <b>{a.owner}</b> · </>}{a.due_date && <>Due {dateLabel(a.due_date)} · </>}<StatusPill status={a.status} />{a.impact_cents !== null && <> · Estimated impact {fmtMoney(a.impact_cents)} <span className="muted">({a.impact_basis})</span></>}</p>
    <div className="row"><button className="btn btn-sm" onClick={() => t.go(KPI_PAGE[a.kpi] ?? 'performance')}>Analyze</button><button className="btn btn-sm" onClick={() => t.go('lab', a.scenario_id ?? undefined)}>Test a Scenario</button></div></div>;
}
const TREND = { up: '▲', down: '▼', flat: '→', 'n/a': '—' } as const;
export function ScorecardTable({ sc, commentary, compact, recent }: { sc: Scorecard; commentary: Record<string, { grade?: string; comment?: string }>; compact?: boolean; recent?: any }) {
  const r3 = (key: string) => (recent && recent.period === sc.period ? recent.signals.find((x: any) => x.key === key) : null);
  return <div className="tbl-wrap"><table className="tbl score"><thead><tr><th>Measure</th><th className="num">Actual</th><th className="num">Target</th><th>Trend</th>{recent && <th>Last 3 months</th>}<th>Grade</th></tr></thead><tbody>
    {sc.measures.map((m: Measure) => { const c = commentary[m.key]; const tr = m.trend;
      return <React.Fragment key={m.key}><tr><td>{MEASURE_TERM[m.key] ? <Term name={MEASURE_TERM[m.key]}>{m.label}</Term> : m.label}{!compact && <div className="sub">{m.basis}</div>}</td>
        <td className="num">{fmt(m.actual, m.actualKind, true)}{m.key === 'salary_cap' && m.actual !== null && <div className="sub">{m.actual >= 0 ? 'under cap' : 'over cap'}</div>}</td>
        <td className="num">{m.key === 'salary_cap' ? 'At or under' : fmt(m.target, m.targetKind, true)}<div className="sub">{m.targetLabel}</div></td>
        <td><span className={tr.improving === null ? 'muted' : tr.improving ? 'good' : 'bad'}>{TREND[tr.direction]} {tr.improving === null ? (tr.direction === 'flat' ? 'Steady' : 'No history') : tr.improving ? 'Improving' : 'Declining'}</span></td>
        {recent && <td>{r3(m.key) ? <span title={r3(m.key).text}><RecentPill s={r3(m.key)} /></span> : <span className="muted">—</span>}</td>}
        <td><Grade grade={c?.grade ?? m.grade} /></td></tr>
        {(c?.comment || (m.note && !compact)) && <tr className="score-c"><td colSpan={recent ? 6 : 5}>{c?.comment && <span className="comment">{c.comment}</span>}{m.note && !compact && <span className="muted"> {m.note}</span>}</td></tr>}</React.Fragment>; })}
    {(commentary.tax?.comment || commentary.tax?.grade) && <><tr><td>Tax implications{!compact && <div className="sub">Your advisor's read on taxes due on this year's profit</div>}</td><td className="num muted">—</td><td className="num muted">—</td><td className="muted">Advisor review</td>{recent && <td></td>}<td><Grade grade={commentary.tax.grade ?? 'N/A'} /></td></tr>
      {commentary.tax.comment && <tr className="score-c"><td colSpan={recent ? 6 : 5}><span className="comment">{commentary.tax.comment}</span></td></tr>}</>}
  </tbody></table>{!sc.r12Complete && <p className="muted small">Based on {sc.monthsIncluded} months of history — a full rolling 12 is not yet available.</p>}</div>;
}

// ---------------------------------------------------------------- Scorecard
export function ScorecardPage() {
  const t = useT(); const r = useLoad(() => get(`${t.base}/scorecard`), [t.tid]); const staff = t.can('view_internal');
  const [draft, setDraft] = useState<Record<string, { grade?: string; comment?: string }> | null>(null); const [notes, setNotes] = useState<string | null>(null); const [err, setErr] = useState<string | null>(null); const [msg, setMsg] = useState<string | null>(null);
  const [hist, setHist] = useState<any>(null);
  return <Async r={r}>{(d) => { const cur = d.current; if (!cur) return <><h1>Scorecard</h1><Empty>{staff ? 'Import and map financial statements to build the scorecard.' : 'Your advisor has not published a scorecard yet.'}</Empty></>;
    const comm = draft ?? cur.commentary; const set = (k: string, v: Partial<{ grade: string; comment: string }>) => setDraft({ ...comm, [k]: { ...comm[k], ...v } });
    const save = async (publish: boolean) => { setErr(null); setMsg(null); try { const x = await put(`${t.base}/scorecard`, { commentary: comm, internalNotes: notes ?? cur.internalNotes ?? '', publish }); setMsg(publish ? `Published the ${P(x.period)} scorecard to the client.` : 'Draft saved.'); setDraft(null); r.reload(); } catch (e) { setErr((e as Error).message); } };
    const shown = hist ?? cur;
    return <>
      <div className="page-h"><div><h1>Scorecard</h1><p className="meta">Rolling 12 months ending <b>{P(shown.period)}</b> · <StatusPill status={shown.status} />{shown.publishedAt && <> · Published {dateLabel(shown.publishedAt)}</>}</p></div>
        <div className="controls">{d.history.length > 0 && <label>History<select value={hist?.period ?? ''} onChange={async (e) => setHist(e.target.value ? await get(`${t.base}/scorecard/${e.target.value}`) : null)}><option value="">Current</option>{d.history.filter((h: any) => !h.status || h.status === 'published').map((h: any) => <option key={h.period} value={h.period}>{P(h.period)} (published)</option>)}</select></label>}<button className="btn" onClick={() => window.print()}>Print / PDF</button></div></div>
      {staff && !hist && d.periodStatus !== 'approved' && <Note tone="warn">{P(cur.period)} is <b>{d.periodStatus}</b>. Approve the period in Review &amp; Approval before publishing this scorecard. Clients currently see {d.published ? `the ${P(d.published.period)} scorecard` : 'no scorecard'}.</Note>}
      <Card><ScorecardTable sc={shown.scorecard} commentary={hist ? shown.commentary : comm} recent={(hist ? hist.recent : d.recent) ?? undefined} />
        {(hist ? hist.recent : d.recent) && <p className="muted small">Grades and targets are on the rolling twelve months. "Last 3 months" shows direction only: a change counts when the same three months last year do not explain it. Hover a marker for the figures; the detail is on Profit &amp; Performance under Rolling 12 &amp; 3.</p>}</Card>
      <Card title="Grading legend"><div className="row"><Grade grade="Great" /><Grade grade="Good" /><Grade grade="OK" /><Grade grade="Caution" /><Grade grade="N/A" /><span className="muted">Grades compare each result with targets set for this business by your advisor. They are not industry averages.</span></div></Card>
      {staff && !hist && <Card title="Advisor commentary and grade review" right={<Pill tone="info">Advisor only</Pill>}>
        <p className="muted">Calculated grades can be overridden with your judgment. Comments are visible to the client once published; internal notes never are.</p>
        <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Measure</th><th>Calculated</th><th>Published grade</th><th>Client-visible comment</th></tr></thead><tbody>
          {cur.scorecard.measures.map((m: Measure) => <tr key={m.key}><td>{m.label}</td><td><Grade grade={m.grade} /></td>
            <td><select value={comm[m.key]?.grade ?? ''} onChange={(e) => set(m.key, { grade: e.target.value || undefined })}><option value="">Use calculated</option>{['Great', 'Good', 'OK', 'Caution', 'N/A'].map((g) => <option key={g}>{g}</option>)}</select></td>
            <td><textarea rows={2} value={comm[m.key]?.comment ?? ''} onChange={(e) => set(m.key, { comment: e.target.value })} /></td></tr>)}
          <tr><td>Tax implications<div className="sub">Not calculated. See the four forces of cash flow on Cash Flow for the set-aside.</div></td><td><Grade grade="N/A" /></td>
            <td><select aria-label="Grade for tax implications" value={comm.tax?.grade ?? ''} onChange={(e) => set('tax', { grade: e.target.value || undefined })}><option value="">Not graded</option>{['Great', 'Good', 'OK', 'Caution'].map((g) => <option key={g}>{g}</option>)}</select></td>
            <td><textarea aria-label="Comment on tax implications" rows={2} value={comm.tax?.comment ?? ''} onChange={(e) => set('tax', { comment: e.target.value })} /></td></tr></tbody></table></div>
        <Field label="Internal notes (never shown to the client)"><textarea rows={3} value={notes ?? cur.internalNotes ?? ''} onChange={(e) => setNotes(e.target.value)} /></Field>
        <ErrorNote error={err} />{msg && <Note tone="good">{msg}</Note>}
        <div className="row"><button className="btn" onClick={() => save(false)}>Save draft</button>{t.can('publish') && <button className="btn btn-primary" onClick={() => save(true)}>Publish to client</button>}</div>
      </Card>}
    </>; }}</Async>;
}

// ---------------------------------------------------------------- Profit & Performance
const sumLines = (ms: any[]) => { const l = zeroPnl(); let adj = 0; for (const m of ms) { for (const k of PNL_LINES) l[k] += m.pnl.lines[k]; adj += m.pnl.ownerAdj; } return { l, adj }; };
export function Performance() {
  const t = useT(); const r = useLoad(() => get(`${t.base}/financials`), [t.tid]); const [tab, setTab] = useState('pnl');
  return <Async r={r}>{(d) => { if (!d.months.length) return <><h1>Profit &amp; Performance</h1><Empty>No approved financial periods yet.</Empty></>;
    const s: Settings = d.settings; const ms = d.months; const n = ms.length; const cur = ms[n - 1];
    const win = (from: number, to: number) => { if (from < 0 || to < 0 || to >= n) return null; const { l, adj } = sumLines(ms.slice(from, to + 1)); return computePnl(l, adj, s); };
    const fy = (i: number) => { const [y, m] = ms[i].period.split('-').map(Number); const start = `${m >= s.fiscalYearStartMonth ? y : y - 1}-${String(s.fiscalYearStartMonth).padStart(2, '0')}`; return ms.findIndex((x: any) => x.period >= start); };
    const cols: [string, ReturnType<typeof win>][] = [[P(cur.period), win(n - 1, n - 1)], ['Prior month', win(n - 2, n - 2)], ['Same month last year', win(n - 13, n - 13)], ['Year to date', win(fy(n - 1), n - 1)], ['Prior YTD', n > 12 ? win(fy(n - 13), n - 13) : null], ['Rolling 12', n >= 12 ? win(n - 12, n - 1) : null], ['Previous rolling 12', n >= 24 ? win(n - 24, n - 13) : null]];
    const row = (label: React.ReactNode, f: (p: NonNullable<ReturnType<typeof win>>) => string, cls = '') => <tr className={cls}><td>{label}</td>{cols.map(([h, p]) => <td key={h} className="num">{p ? f(p) : '—'}</td>)}</tr>;
    const $ = (v: number) => fmtMoney(v); const last = ms.slice(-24); const lab = last.map((m: any) => P(m.period));
    return <>
      <div className="page-h"><div><h1>Profit &amp; Performance</h1><p className="meta">Management P&amp;L through <b>{P(cur.period)}</b> · <StatusPill status={cur.status} /> · For management discussion only</p></div>
        <div className="controls">{t.can('export') && <button className="btn" onClick={() => download(`${t.base}/export/pnl.csv`, 'management-pnl.csv')}>Export CSV</button>}</div></div>
      {d.basis?.text && <Note tone={d.basis.value === 'unknown' ? 'info' : 'warn'}>{d.basis.text}</Note>}
      {d.reporting && (d.reporting.status === 'late' || d.reporting.status === 'overdue') && <Note tone="warn">{d.reporting.text}</Note>}
      <div className="tabs" role="tablist">{[['pnl', 'Management P&L'], ['r12', 'Rolling 12 & 3'], ['owner', 'Owner pay & salary cap'], ['value', 'Business value'], ['trends', 'Trends'], ['bs', 'Balance sheet & cash flow'], ['forecast', 'What-if forecast']].map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}</div>
      {tab === 'pnl' && <Card><div className="tbl-wrap"><table className="tbl pnl"><thead><tr><th></th>{cols.map(([h]) => <th key={h} className="num">{h}</th>)}</tr></thead><tbody>
        {row('Revenue', (p) => $(p.lines.revenue))}{row('Less non-labor cost of goods sold', (p) => $(p.lines.cogs))}
        {row(<Term name="Gross Profit">Gross profit</Term>, (p) => $(p.grossProfit), 'tot')}{row(<Term name="Gross Margin">Gross margin %</Term>, (p) => fmtPct(p.grossMarginPct.value), 'sub')}
        {row('Less direct labor', (p) => $(p.lines.direct_labor))}{row(<Term name="Contribution Margin">Contribution margin</Term>, (p) => $(p.contributionMargin), 'tot')}{row(<Term name="Direct LER">Direct LER</Term>, (p) => fmtRatio(p.dLER.value), 'sub')}
        {(['facilities', 'marketing', 'mgmt_labor', 'payroll_taxes_benefits', 'other_opex'] as const).map((k) => <React.Fragment key={k}>{row(LINE_LABELS[k], (p) => $(p.lines[k]))}</React.Fragment>)}
        {row('Total operating expenses', (p) => $(p.totalOpex), 'tot')}{row(<Term name="Management LER">Management LER</Term>, (p) => fmtRatio(p.mLER.value), 'sub')}
        {row('Operating income', (p) => $(p.operatingIncome), 'tot')}{row('Other income (expense), net', (p) => $(p.otherTotal))}
        {row('Pretax profit (reported)', (p) => $(p.pretax), 'tot')}{row('% of revenue', (p) => fmtPct(p.pretaxPct.value), 'sub')}
        {row('Owner compensation adjustment', (p) => $(-p.ownerAdj))}{row(<Term name="Adjusted Pretax Profit">Adjusted pretax profit (true profit)</Term>, (p) => $(p.adjustedPretax), 'tot strong')}{row('% of revenue', (p) => fmtPct(p.adjustedPretaxPct.value), 'sub')}
        {row(<Term name="Salary Cap">Salary cap</Term>, (p) => $(p.salaryCap))}{row('Labor incl. owner adjustment', (p) => $(p.adjustedLabor))}{row('Under (over) salary cap', (p) => $(p.salaryCapHeadroom), 'tot')}
        {row(<Term name="Total LER">Total LER</Term>, (p) => fmtRatio(p.tLER.value), 'sub')}{row('Adjusted LER (incl. owner adjustment)', (p) => fmtRatio(p.adjustedLER.value), 'sub')}
      </tbody></table></div><p className="muted small">N/A means a ratio cannot be calculated for that period (for example, no management labor was recorded). Payroll taxes and benefits are treated as {s.burdenTreatment === 'opex' ? 'an operating expense' : 'labor cost'} and counted once.</p></Card>}
      {tab === 'trends' && <div className="grid-2">
        <Card title="Revenue and gross profit — rolling 12"><Chart labels={lab} kind="money" series={[{ name: 'Revenue (R12)', values: last.map((m: any) => (m.r12.complete ? m.r12.revenue : null)), color: C.neutral }, { name: 'Gross profit (R12)', values: last.map((m: any) => (m.r12.complete ? m.r12.grossProfit : null)) }]} /></Card>
        <Card title="True profit margin — rolling 12"><Chart labels={lab} kind="pct" series={[{ name: 'Adjusted pretax %', values: last.map((m: any) => (m.r12.complete ? m.r12.adjustedPretaxPct : null)) }]} reference={{ value: s.pretaxTargetPct, label: `Target ${fmtPct(s.pretaxTargetPct, 0)}` }} /></Card>
        <Card title="Labor efficiency — rolling 12"><Chart labels={lab} kind="ratio" series={[{ name: 'Direct LER', values: last.map((m: any) => (m.r12.complete ? m.r12.dLER : null)) }, { name: 'Total LER', values: last.map((m: any) => (m.r12.complete ? m.r12.tLER : null)), color: C.neutral }]} reference={s.dlerTarget ? { value: s.dlerTarget, label: `Direct LER target ${fmtRatio(s.dlerTarget)}` } : undefined} /></Card>
        <Card title="Under (over) salary cap — rolling 12"><Chart labels={lab} kind="money" bars series={[{ name: 'Salary cap headroom', values: last.map((m: any) => (m.r12.complete ? m.r12.headroom : null)) }]} highlight={(i) => (last[i].r12.headroom ?? 0) < 0} /></Card>
        <Card title="Expense composition — latest rolling 12" className="span-2">{(() => { const p = cols[5][1] ?? cols[3][1]!; const items = [['Non-labor COGS', p.lines.cogs], ['Direct labor', p.lines.direct_labor], ['Management labor', p.lines.mgmt_labor], ['Payroll taxes & benefits', p.lines.payroll_taxes_benefits], ['Facilities', p.lines.facilities], ['Marketing', p.lines.marketing], ['Other operating', p.lines.other_opex]] as [string, number][];
          const max = Math.max(...items.map((x) => x[1]), 1); return <div className="hbars">{items.map(([l, v]) => <div key={l}><span>{l}</span><i><b style={{ width: `${(v / max) * 100}%` }} /></i><em>{$(v)} · {fmtPct(v / (p.lines.revenue || 1))} of revenue</em></div>)}</div>; })()}</Card>
      </div>}
      {tab === 'r12' && <RollingTab rows={d.rolling} checks={d.expenseChecks} recent={d.recent} />}
      {tab === 'owner' && <><WagePlanCard onApplied={r.reload} firstPeriod={ms[0].period} lastPeriod={cur.period} /><CapitalCard ms={ms} /><OwnerTab ms={ms} s={s} /></>}
      {tab === 'value' && <><ValuationCard base={d.valuationBase} taxRate={s.taxReserveRate} ler={d.rolling.at(-1)?.ler.value ?? null} /><ProfitLevelsCard base={d.valuationBase} s={s} currentPct={cur.r12.complete ? cur.r12.adjustedPretaxPct : null} /><BuyInCard ms={ms} /></>}
      {tab === 'bs' && <BalanceTab ms={ms} />}
      {tab === 'forecast' && <WhatIfForecast />}
    </>; }}</Async>;
}
function OwnerTab({ ms, s }: { ms: any[]; s: Settings }) {
  const cur = ms[ms.length - 1]; const sw = cur.sweat; const last = ms.slice(-24); const lab = last.map((m: any) => P(m.period));
  const fyOf = (period: string) => { const [y, m] = period.split('-').map(Number); return m >= s.fiscalYearStartMonth ? y : y - 1; };
  let ytd = 0; let fy = -1; const ytdBy: Record<string, number> = {}; for (const m of ms) { if (fyOf(m.period) !== fy) { fy = fyOf(m.period); ytd = 0; } ytd += m.pnl.salaryCapHeadroom; ytdBy[m.period] = ytd; }
  const totals = ms.reduce((a: any, m: any) => ({ under: a.under + m.sweat.underpay, dist: a.dist + (m.sweat.distributions ?? 0), excess: a.excess + m.sweat.excessDistributions }), { under: 0, dist: 0, excess: 0 });
  const derived = ms.some((m: any) => m.sweat.distributionSource === 'balance_sheet'); const none = ms.every((m: any) => m.sweat.distributionSource === 'unavailable');
  return <>
    <div className="kpis kpis-5">
      <div className="kpi static"><span className="kpi-l">Sweat equity balance</span><span className="kpi-v">{fmtMoney(sw.balance, { compact: true })}</span><span className="kpi-m muted">Unpaid market wages not yet returned through distributions, since {P(ms[0].period)}</span></div>
      <div className="kpi static"><span className="kpi-l">Owner underpay to date</span><span className="kpi-v">{fmtMoney(totals.under, { compact: true })}</span><span className="kpi-m muted">This month {fmtMoney(sw.underpay)}</span></div>
      <div className="kpi static"><span className="kpi-l">Shareholder distributions to date</span><span className="kpi-v">{none ? 'N/A' : fmtMoney(totals.dist, { compact: true })}</span><span className="kpi-m muted">This month {fmtMoney(sw.distributions)}</span></div>
      <div className="kpi static"><span className="kpi-l">Distributions beyond sweat equity</span><span className="kpi-v">{fmtMoney(totals.excess, { compact: true })}</span><span className="kpi-m muted">Return of profit rather than of unpaid wages</span></div>
      <div className="kpi static"><span className="kpi-l"><Term name="Salary Cap">Under (over) salary cap</Term></span><span className="kpi-v">{fmtMoney(cur.pnl.salaryCapHeadroom, { compact: true })}</span><span className="kpi-m"><span className={cur.r12.headroom < 0 ? 'bad' : 'good'}>Rolling 12: {fmtMoney(cur.r12.headroom, { compact: true })}</span></span></div>
    </div>
    <Note>How this works: each month the owner is paid less than a market wage, the shortfall is added to sweat equity. Shareholder distributions taken in the month are subtracted, because a distribution is the owner being paid in another form. The balance cannot go below zero; distributions beyond it are shown separately. {derived && 'Distributions are derived from the balance sheet (prior equity + pretax profit − current equity) unless your advisor has entered them, so owner contributions or other entries posted directly to equity will affect the figure.'}{none && ' No balance sheet or entered distributions are on file, so distributions are not yet reflected.'}</Note>
    <div className="grid-2">
      <Card title="Sweat equity balance"><Chart labels={lab} kind="money" zeroBased series={[{ name: 'Sweat equity balance', values: last.map((m: any) => m.sweat.balance) }]} /></Card>
      <Card title="Owner underpay vs distributions taken, by month"><Chart labels={lab} kind="money" bars series={[{ name: 'Owner underpay', values: last.map((m: any) => m.sweat.underpay), color: C.s1 }, { name: 'Distributions', values: last.map((m: any) => m.sweat.distributions), color: C.s2 }]} /></Card>
      <Card title="Labor vs salary cap, by month" className="span-2"><Chart labels={lab} kind="money" zeroBased series={[{ name: 'Salary cap', values: last.map((m: any) => m.pnl.salaryCap), color: C.neutral }, { name: 'Labor incl. owner adjustment', values: last.map((m: any) => m.pnl.adjustedLabor), color: C.s1 }]} /><p className="muted small">The salary cap is the most labor the month's revenue supports while still earning the {fmtPct(s.pretaxTargetPct, 0)} profit target. When the blue line is above the gray line, labor is over the cap.</p></Card>
    </div>
    <Card title="Month-by-month ledger"><div className="tbl-wrap tall"><table className="tbl"><thead><tr><th>Month</th><th className="num">Owner underpay</th><th className="num">Distributions taken</th><th className="num">Change in sweat equity</th><th className="num">Sweat equity balance</th><th className="num">Excess distributions</th><th className="num">Salary cap</th><th className="num">Labor incl. owner adj.</th><th className="num">Under (over) cap</th><th className="num">YTD under (over)</th><th className="num">R12 under (over)</th></tr></thead><tbody>
      {[...ms].reverse().map((m: any) => <tr key={m.period}><td>{P(m.period)}</td><td className="num">{fmtMoney(m.sweat.underpay)}</td><td className="num">{fmtMoney(m.sweat.distributions)}{m.sweat.distributionSource === 'entered' && <span className="sub">entered</span>}</td><td className="num">{fmtMoney(m.sweat.change)}</td><td className="num"><b>{fmtMoney(m.sweat.balance)}</b></td><td className="num">{fmtMoney(m.sweat.excessDistributions)}</td>
        <td className="num">{fmtMoney(m.pnl.salaryCap)}</td><td className="num">{fmtMoney(m.pnl.adjustedLabor)}</td><td className={`num ${m.pnl.salaryCapHeadroom < 0 ? 'bad' : ''}`}>{fmtMoney(m.pnl.salaryCapHeadroom)}</td><td className={`num ${(ytdBy[m.period] ?? 0) < 0 ? 'bad' : ''}`}>{m.period in ytdBy ? fmtMoney(ytdBy[m.period]) : '—'}</td><td className={`num ${m.r12.headroom < 0 ? 'bad' : ''}`}>{m.r12.complete ? fmtMoney(m.r12.headroom) : '—'}</td></tr>)}</tbody></table></div>
      <p className="muted small">Sweat equity here is a management tracking figure. It is not an accounting entry, a tax position or a legal claim on the business.</p></Card>
  </>;
}
function BalanceTab({ ms }: { ms: any[] }) {
  const cur = ms[ms.length - 1]; const withBs = ms.filter((m) => m.bs);
  if (!withBs.length) return <Empty>No balance sheet has been imported. Cash, DSO and core capital need one.</Empty>;
  const last = withBs.slice(-13); const bad = last.filter((m) => (m.cashFlow && Math.abs(m.cashFlow.difference) > 100) || Math.abs(m.bsImbalance ?? 0) > 100);
  const L = (k: string) => fmtMoney(cur.bs?.[k] ?? null);
  return <>{bad.length > 0 && <Note tone="bad"><b>Reconciliation difference.</b> Cash flow does not tie to the balance sheet in {bad.map((m) => P(m.period)).join(', ')}. The difference is shown below, not hidden. Check for unmapped balance-sheet accounts.</Note>}
    <div className="grid-2">
      <Card title={`Balance sheet — ${P(cur.period)}`}>{cur.bs ? <table className="tbl"><tbody>
        <tr><td>Cash</td><td className="num">{L('cash')}</td></tr><tr><td>Accounts receivable</td><td className="num">{L('accounts_receivable')}</td></tr><tr><td>Other current assets</td><td className="num">{L('other_current_assets')}</td></tr>
        <tr><td>Fixed assets, net of depreciation</td><td className="num">{fmtMoney(cur.bs.fixed_assets + cur.bs.accumulated_depreciation)}</td></tr><tr><td>Other assets</td><td className="num">{L('other_assets')}</td></tr>
        <tr className="tot"><td>Total assets</td><td className="num">{fmtMoney(cur.bs.cash + cur.bs.accounts_receivable + cur.bs.other_current_assets + cur.bs.fixed_assets + cur.bs.accumulated_depreciation + cur.bs.other_assets)}</td></tr>
        <tr><td>Accounts payable</td><td className="num">{L('accounts_payable')}</td></tr><tr><td>Credit cards</td><td className="num">{L('credit_cards')}</td></tr><tr><td>Other current liabilities</td><td className="num">{L('other_current_liabilities')}</td></tr>
        <tr><td>Line of credit</td><td className="num">{L('line_of_credit')}</td></tr><tr><td>Notes payable</td><td className="num">{L('notes_payable')}</td></tr><tr><td>Equity</td><td className="num">{L('equity')}</td></tr>
        <tr className="tot"><td>Out of balance</td><td className="num">{fmtMoney(cur.bsImbalance)}</td></tr><tr><td><Term name="A/R DSO">A/R days sales outstanding</Term></td><td className="num">{cur.dso.value === null ? 'N/A' : `${Math.round(cur.dso.value)} days`}</td></tr></tbody></table> : <Empty>No balance sheet for {P(cur.period)}.</Empty>}{cur.dso.reason && <p className="muted small">{cur.dso.reason}</p>}</Card>
      <Card title="Cash balance by month"><Chart labels={last.map((m) => P(m.period))} kind="money" zeroBased series={[{ name: 'Cash', values: last.map((m) => m.bs.cash) }]} /></Card>
    </div>
    <Card title="Cash flow statement (indirect), reconciled to the balance sheet"><div className="tbl-wrap"><table className="tbl"><thead><tr><th></th>{last.slice(1).map((m) => <th key={m.period} className="num">{P(m.period)}</th>)}</tr></thead><tbody>
      {[['Pretax profit', 'netIncome'], ['Cash from operations', 'operations'], ['Fixed asset purchases', 'investing'], ['Line of credit', 'loc'], ['Notes payable', 'notes'], ['Distributions and other equity', 'equityOther'], ['Net change in cash', 'net'], ['Ending cash (calculated)', 'endingCashCalc'], ['Ending cash (balance sheet)', 'endingCashReported'], ['Difference', 'difference']].map(([l, k]) => <tr key={k} className={k === 'net' || k === 'difference' ? 'tot' : ''}><td>{l}</td>{last.slice(1).map((m) => <td key={m.period} className={`num ${k === 'difference' && m.cashFlow && Math.abs(m.cashFlow.difference) > 100 ? 'bad' : ''}`}>{m.cashFlow ? fmtMoney(m.cashFlow[k], { compact: true }) : '—'}</td>)}</tr>)}</tbody></table></div></Card></>;
}

// ---------------------------------------------------------------- Weekly Pulse
export function WeeklyPulse() {
  const t = useT(); const r = useLoad(() => get(`${t.base}/weekly`), [t.tid]); const [report, setReport] = useState<string | null>(t.sub); const [entry, setEntry] = useState<any>(null); const [err, setErr] = useState<string | null>(null);
  if (report) return <WeeklyReport id={report} onBack={() => { setReport(null); r.reload(); }} />;
  return <Async r={r}>{(d) => { const rows = d.rows.slice(-12); const cur = rows[rows.length - 1]; const s: Settings = d.settings; const lab = rows.map((x: any) => dateLabel(x.weekStart).replace(/, \d{4}/, ''));
    const reportFor = (w: string) => d.reports.find((x: any) => x.week_start === w);
    const draft = async (w: string) => { setErr(null); try { const x = await post(`${t.base}/weekly/reports`, { weekStart: w }); setReport(x.id); } catch (e) { setErr((e as Error).message); } };
    const saveEntry = async () => { setErr(null); try { await put(`${t.base}/weekly/entries`, entry); setEntry(null); r.reload(); } catch (e) { setErr((e as Error).message); } };
    return <>
      <div className="page-h"><div><h1>Weekly Pulse</h1><p className="meta">{cur ? <>Week of <b>{dateLabel(cur.weekStart)}</b> · </> : null}<Pill tone="warn">Operational estimate</Pill></p></div>
        <div className="controls">{t.can('weekly_entry') && <button className="btn btn-primary" onClick={() => setEntry({ weekStart: '', revenueCents: 0, cogsCents: 0, directLaborCents: 0, otherLaborCents: null, cashBalanceCents: null })}>Enter weekly figures</button>}</div></div>
      <Note>{d.estimateLabel}</Note><ErrorNote error={err} />
      {!cur ? <Empty>No weekly updates have been published yet.</Empty> : <>
        <div className="kpis kpis-5">
          <div className="kpi static"><span className="kpi-l">Sales</span><span className="kpi-v">{fmtMoney(cur.revenueCents, { compact: true })}</span><span className="kpi-m muted">MTD {fmtMoney(cur.mtdRevenueCents, { compact: true })} · YTD {fmtMoney(cur.ytdRevenueCents, { compact: true })}</span></div>
          <div className="kpi static"><span className="kpi-l"><Term name="Gross Profit">Gross profit</Term></span><span className="kpi-v">{fmtMoney(cur.grossProfitCents, { compact: true })}</span><span className="kpi-m">{cur.gpOverUnderCents === null ? <span className="muted">No weekly target set</span> : <span className={cur.gpOverUnderCents >= 0 ? 'good' : 'bad'}>{fmtMoney(Math.abs(cur.gpOverUnderCents), { compact: true })} {cur.gpOverUnderCents >= 0 ? 'over' : 'under'} target</span>}</span></div>
          <div className="kpi static"><span className="kpi-l"><Term name="Gross Margin">Gross margin</Term></span><span className="kpi-v">{fmtPct(cur.grossMarginPct.value)}</span><span className="kpi-m muted">Contribution {fmtMoney(cur.contributionCents, { compact: true })}</span></div>
          <div className="kpi static"><span className="kpi-l"><Term name="Direct LER">Direct LER</Term></span><span className="kpi-v">{fmtRatio(cur.dLER.value)}</span><span className="kpi-m muted">MTD {fmtRatio(cur.mtdLER.value)} · YTD {fmtRatio(cur.ytdLER.value)}{s.dlerTarget ? ` · target ${fmtRatio(s.dlerTarget)}` : ''}</span></div>
          <div className="kpi static"><span className="kpi-l">Direct labor vs target spend</span><span className="kpi-v">{fmtMoney(cur.directLaborCents, { compact: true })}</span><span className="kpi-m">{cur.laborOverUnderCents === null ? <span className="muted">No LER target set</span> : <span className={cur.laborOverUnderCents <= 0 ? 'good' : 'bad'}>{fmtMoney(Math.abs(cur.laborOverUnderCents), { compact: true })} {cur.laborOverUnderCents <= 0 ? 'under' : 'over'} target</span>}</span></div>
        </div>
        <div className="grid-2">
          <Card title="Gross profit by week vs target"><Chart labels={lab} kind="money" bars series={[{ name: 'Gross profit', values: rows.map((x: any) => x.grossProfitCents) }]} reference={s.weeklyGpTargetCents ? { value: s.weeklyGpTargetCents, label: `Target ${fmtMoney(s.weeklyGpTargetCents, { compact: true })}` } : undefined} /></Card>
          <Card title="Direct labor efficiency by week"><Chart labels={lab} kind="ratio" series={[{ name: 'Direct LER', values: rows.map((x: any) => x.dLER.value) }]} reference={s.dlerTarget ? { value: s.dlerTarget, label: `Target ${fmtRatio(s.dlerTarget)}` } : undefined} /></Card>
        </div>
        <Card title="Weekly detail"><div className="tbl-wrap"><table className="tbl"><thead><tr><th>Week of</th><th className="num">Sales</th><th className="num">Direct costs</th><th className="num">Gross profit</th><th className="num">GM %</th><th className="num">Direct labor</th><th className="num">LER</th><th className="num">GP vs target</th><th className="num">Running GP vs target</th><th className="num">Labor vs target</th><th className="num">Cash</th><th>Report</th></tr></thead><tbody>
          {[...rows].reverse().map((x: any) => { const rep = reportFor(x.weekStart); return <tr key={x.weekStart}><td>{dateLabel(x.weekStart)}</td><td className="num">{fmtMoney(x.revenueCents)}</td><td className="num">{fmtMoney(x.cogsCents)}</td><td className="num">{fmtMoney(x.grossProfitCents)}</td><td className="num">{fmtPct(x.grossMarginPct.value)}</td><td className="num">{fmtMoney(x.directLaborCents)}</td><td className="num">{fmtRatio(x.dLER.value)}</td>
            <td className={`num ${x.gpOverUnderCents !== null && x.gpOverUnderCents < 0 ? 'bad' : ''}`}>{fmtMoney(x.gpOverUnderCents)}</td><td className={`num ${x.gpRollingOverUnderCents !== null && x.gpRollingOverUnderCents < 0 ? 'bad' : ''}`}>{fmtMoney(x.gpRollingOverUnderCents)}</td><td className={`num ${x.laborOverUnderCents !== null && x.laborOverUnderCents > 0 ? 'bad' : ''}`}>{fmtMoney(x.laborOverUnderCents)}</td><td className="num">{fmtMoney(x.cashBalanceCents)}</td>
            <td>{rep ? <button className="btn btn-sm" onClick={() => setReport(rep.id)}>{rep.status === 'published' ? 'View report' : 'Edit draft'}</button> : t.can('weekly_entry') ? <span className="row"><button className="btn btn-sm" onClick={() => draft(x.weekStart)}>Draft report</button><button className="btn btn-sm btn-ghost" onClick={() => setEntry({ weekStart: x.weekStart, revenueCents: x.revenueCents, cogsCents: x.cogsCents, directLaborCents: x.directLaborCents, cashBalanceCents: x.cashBalanceCents })}>Edit</button></span> : '—'}</td></tr>; })}</tbody></table></div>
          <p className="muted small">Labor vs target = actual direct labor − (gross profit ÷ target LER). Positive means labor ran over what the week's gross profit supports.</p></Card><ProductivityCard p={d.productivity} /></>}
      {entry && <Drawer title="Weekly figures" onClose={() => setEntry(null)}>
        <p className="muted">Enter operational figures from your sales system, payroll and bank. They are labelled as estimates until the month is closed and reconciled.</p>
        <Field label="Week starting" hint={`Weeks start on ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][s.weekStartDay]} for this client.`}><input type="date" value={entry.weekStart} onChange={(e) => setEntry({ ...entry, weekStart: e.target.value })} /></Field>
        <Field label="Sales"><Money value={entry.revenueCents} onChange={(v) => setEntry({ ...entry, revenueCents: v ?? 0 })} /></Field>
        <Field label="Non-labor direct costs"><Money value={entry.cogsCents} onChange={(v) => setEntry({ ...entry, cogsCents: v ?? 0 })} /></Field>
        <Field label="Direct labor"><Money value={entry.directLaborCents} onChange={(v) => setEntry({ ...entry, directLaborCents: v ?? 0 })} /></Field>
        <Field label="Office and management payroll (optional)" hint="Everyone not in direct labor. Needed for all-labor efficiency in the sales and productivity report."><Money nullable value={entry.otherLaborCents} onChange={(v) => setEntry({ ...entry, otherLaborCents: v })} /></Field>
        <Field label="Bank balance at week end (optional)"><Money nullable value={entry.cashBalanceCents} onChange={(v) => setEntry({ ...entry, cashBalanceCents: v })} /></Field>
        <ErrorNote error={err} /><button className="btn btn-primary" onClick={saveEntry}>Save</button></Drawer>}
    </>; }}</Async>;
}
const SECTIONS: [string, string][] = [['performance', "This Week's Performance"], ['improved', 'What Improved'], ['attention', 'What Needs Attention'], ['actions', 'Recommended Actions'], ['watch', 'What to Watch Next Week']];
function WeeklyReport({ id, onBack }: { id: string; onBack: () => void }) {
  const t = useT(); const r = useLoad(() => get(`${t.base}/weekly/reports/${id}`), [id]); const [edit, setEdit] = useState<any>(null); const [err, setErr] = useState<string | null>(null); const [comment, setComment] = useState(''); const [internal, setInternal] = useState(false);
  return <Async r={r}>{(d) => { const e = edit ?? { briefing: d.briefing, nextSteps: d.nextSteps, internalNotes: d.internalNotes ?? '' }; const canEdit = d.status === 'draft' && t.can('weekly_entry'); const row = d.snapshot.row;
    const save = async (publish: boolean) => { setErr(null); try { await put(`${t.base}/weekly/reports/${id}`, { ...e, publish }); setEdit(null); r.reload(); } catch (x) { setErr((x as Error).message); } };
    const send = async () => { if (!comment.trim()) return; await post(`${t.base}/comments`, { entity: 'weekly_report', entityId: id, body: comment, visibility: internal ? 'internal' : 'client' }); setComment(''); r.reload(); };
    return <div className="report">
      <div className="page-h no-print"><button className="btn btn-ghost" onClick={onBack}>← Weekly Pulse</button><div className="controls"><button className="btn" onClick={() => window.print()}>Download PDF (print)</button></div></div>
      <Card><h1>Weekly Business Briefing</h1><p className="meta">{t.tenant.name} · Week of <b>{dateLabel(d.weekStart)}</b> · <StatusPill status={d.status} />{d.publishedAt && <> · Published {dateLabel(d.publishedAt)}</>}{d.acknowledgedAt && <> · Acknowledged {dateLabel(d.acknowledgedAt)}</>}</p>
        <Note>Operational estimates from weekly sales, payroll and bank data — not reconciled to the monthly close. This report is a snapshot of the week as published and is not rewritten later.</Note>
        <div className="kpis kpis-5">{[['Sales', fmtMoney(row.revenueCents)], ['Gross profit', fmtMoney(row.grossProfitCents)], ['Gross margin', fmtPct(row.grossMarginPct.value)], ['Direct LER', fmtRatio(row.dLER.value)], ['Lowest cash, next 13 weeks', d.snapshot.cash ? fmtMoney(d.snapshot.cash.lowestCents) : 'N/A']].map(([l, v]) => <div key={l} className="kpi static"><span className="kpi-l">{l}</span><span className="kpi-v">{v}</span></div>)}</div>
        {SECTIONS.map(([k, label]) => <section key={k}><h3>{label}</h3>{canEdit ? <textarea rows={3} value={e.briefing[k] ?? ''} onChange={(x) => setEdit({ ...e, briefing: { ...e.briefing, [k]: x.target.value } })} /> : <p>{d.briefing[k]}</p>}</section>)}
        <section><h3>Next steps</h3>
          {canEdit ? <>{e.nextSteps.map((s: any, i: number) => <div key={i} className="row step"><input placeholder="Specific next step" value={s.text} onChange={(x) => setEdit({ ...e, nextSteps: e.nextSteps.map((y: any, j: number) => (j === i ? { ...y, text: x.target.value } : y)) })} /><input placeholder="Owner" value={s.owner ?? ''} onChange={(x) => setEdit({ ...e, nextSteps: e.nextSteps.map((y: any, j: number) => (j === i ? { ...y, owner: x.target.value } : y)) })} /><input type="date" value={s.due ?? ''} onChange={(x) => setEdit({ ...e, nextSteps: e.nextSteps.map((y: any, j: number) => (j === i ? { ...y, due: x.target.value || null } : y)) })} /><button className="btn btn-sm btn-ghost" onClick={() => setEdit({ ...e, nextSteps: e.nextSteps.filter((_: any, j: number) => j !== i) })}>Remove</button></div>)}
            <button className="btn btn-sm" onClick={() => setEdit({ ...e, nextSteps: [...e.nextSteps, { text: '', owner: '', due: null }] })}>Add next step</button></>
            : d.nextSteps.length ? <ol>{d.nextSteps.map((s: any, i: number) => <li key={i}>{s.text}{s.owner && <> — <b>{s.owner}</b></>}{s.due && <>, due {dateLabel(s.due)}</>}</li>)}</ol> : <p className="muted">None recorded.</p>}</section>
        {canEdit && <section className="no-print"><Field label="Internal notes (never shown to the client)"><textarea rows={2} value={e.internalNotes} onChange={(x) => setEdit({ ...e, internalNotes: x.target.value })} /></Field>
          <p className="muted small">The draft above was generated from this week's figures. Review and edit it before publishing; once published it is archived as-is.</p>
          <ErrorNote error={err} /><div className="row"><button className="btn" onClick={() => save(false)}>Save draft</button>{t.can('publish') ? <button className="btn btn-primary" onClick={() => save(true)}>Publish to client</button> : <span className="muted">An advisor must review and publish.</span>}</div></section>}
        {d.status === 'published' && t.can('view_internal') && d.internalNotes && <Note tone="warn"><b>Internal note:</b> {d.internalNotes}</Note>}
      </Card>
      {d.status === 'published' && <Card title="Discussion" className="no-print">
        {d.comments.length ? <ul className="thread">{d.comments.map((m: any) => <li key={m.id} className={m.visibility === 'internal' ? 'internal' : ''}><b>{m.author}</b> <span className="muted">{m.from_advisor ? 'Advisor' : 'Client'} · {dateLabel(m.created_at)}{m.visibility === 'internal' && ' · internal only'}</span><p>{m.body}</p></li>)}</ul> : <p className="muted">No comments yet.</p>}
        {t.can('comment') && <div className="row"><input placeholder="Add a comment or question" value={comment} onChange={(x) => setComment(x.target.value)} />{t.can('view_internal') && <label className="chk"><input type="checkbox" checked={internal} onChange={(x) => setInternal(x.target.checked)} /> Internal only</label>}<button className="btn" onClick={send}>Post</button></div>}
        {t.can('acknowledge') && !d.acknowledgedAt && <button className="btn btn-primary" onClick={async () => { await post(`${t.base}/weekly/reports/${id}/acknowledge`); r.reload(); }}>Acknowledge report</button>}
      </Card>}
    </div>; }}</Async>;
}

// ---------------------------------------------------------------- Cash Flow
const blankItem = () => ({ name: '', direction: 'out', category: 'vendor', amountCents: 0, cadence: 'once', anchorDate: new Date().toISOString().slice(0, 10), endDate: null, secondDay: null, active: true });
export function CashFlow() {
  const t = useT(); const r = useLoad(() => get(`${t.base}/cash`), [t.tid]);
  const [wi, setWi] = useState<{ delayId: string; days: number; salesPct: number; extraName: string; extraCents: number; extraDate: string }>({ delayId: '', days: 30, salesPct: 0, extraName: '', extraCents: 0, extraDate: '' });
  const [scen, setScen] = useState<any>(null); const [edit, setEdit] = useState<any>(null); const [openWeek, setOpenWeek] = useState<number | null>(null); const [err, setErr] = useState<string | null>(null);
  const run = async () => { setErr(null); try { const body: any = { delays: wi.delayId ? [{ itemId: wi.delayId, days: wi.days }] : [], scaleInflowsPct: wi.salesPct ? wi.salesPct : undefined, extra: wi.extraCents > 0 && wi.extraDate ? [{ name: wi.extraName || 'What-if payment', direction: 'out', category: 'other_out', amountCents: wi.extraCents, cadence: 'once', anchorDate: wi.extraDate }] : [] }; setScen((await post(`${t.base}/cash/what-if`, body)).scenario); } catch (e) { setErr((e as Error).message); } };
  const saveItem = async () => { setErr(null); try { if (edit.id) await put(`${t.base}/cash/items/${edit.id}`, edit); else await post(`${t.base}/cash/items`, edit); setEdit(null); setScen(null); r.reload(); } catch (e) { setErr((e as Error).message); } };
  return <Async r={r}>{(d) => { const f = d.forecast; const cc = d.coreCapital; const show = scen ?? f;
    return <>
      <div className="page-h"><div><h1>Cash Flow</h1><p className="meta">13-week forecast from <b>{dateLabel(d.startDate)}</b> · Starting cash: {d.position.source}</p></div></div>
      {!f && <FourForcesCard />}
      {!f ? <Empty>No cash balance is on file. Import a balance sheet or enter a bank balance in Weekly Pulse to start the forecast.</Empty> : <>
        <div className="kpis kpis-5">
          <div className="kpi static"><span className="kpi-l">Current available cash</span><span className="kpi-v">{fmtMoney(f.beginCents, { compact: true })}</span><span className="kpi-m muted">as of {d.position.asOf?.length === 7 ? P(d.position.asOf) : dateLabel(d.position.asOf)}</span></div>
          <div className="kpi static"><span className="kpi-l">Forecast lowest cash</span><span className="kpi-v">{fmtMoney(f.lowestCents, { compact: true })}</span><span className="kpi-m">{f.weeksBelowFloor ? <span className="bad">Below minimum in {f.weeksBelowFloor} week(s)</span> : <span className="good">Stays above minimum</span>} <span className="muted">· week of {dateLabel(f.lowestWeek)}</span></span></div>
          <div className="kpi static"><span className="kpi-l"><Term name="Core Capital">Required core capital</Term></span><span className="kpi-v">{fmtMoney(cc?.target ?? null, { compact: true })}</span><span className="kpi-m muted">{cc?.basisLabel}</span></div>
          <div className="kpi static"><span className="kpi-l">Reserve surplus (shortfall)</span><span className="kpi-v">{fmtMoney(cc?.surplus ?? null, { compact: true })}</span><span className="kpi-m muted">{cc?.monthsCovered.value != null ? `${cc.monthsCovered.value.toFixed(1)} months of expenses covered` : cc?.monthsCovered.reason}</span></div>
          <div className="kpi static"><span className="kpi-l">Line of credit in use</span><span className="kpi-v">{fmtMoney(cc?.locBalance ?? null, { compact: true })}</span><span className="kpi-m muted">Planned non-P&amp;L payments {fmtMoney(d.nonPnlMonthlyCents, { compact: true })}/mo</span></div>
        </div>
        <CashReportsCard onSaved={() => { setScen(null); r.reload(); }} />
        <FourForcesCard />
        <Card title="Projected cash balance by week" right={scen ? <Pill tone="warn">What-if — not saved</Pill> : null}>
          <Chart labels={f.weeks.map((w: any) => dateLabel(w.weekStart).replace(/, \d{4}/, ''))} kind="money" bars zeroBased series={scen ? [{ name: 'Current plan', values: f.weeks.map((w: any) => w.endCents), color: C.neutral }, { name: 'What-if', values: scen.weeks.map((w: any) => w.endCents) }] : [{ name: 'Ending cash', values: f.weeks.map((w: any) => w.endCents) }]} reference={{ value: d.floorCents, label: `Minimum cash ${fmtMoney(d.floorCents, { compact: true })}` }} highlight={(i) => show.weeks[i].belowFloor} />
          <p className="muted small">Bars in red fall below the minimum cash level set for this business. The forecast places each receipt and payment on its expected date — it is not monthly profit spread evenly.</p></Card>
        <Card title="What if…" className="no-print">
          <div className="form-grid">
            <Field label="A receipt arrives late"><select value={wi.delayId} onChange={(e) => setWi({ ...wi, delayId: e.target.value })}><option value="">— none —</option>{d.items.filter((i: any) => i.direction === 'in').map((i: any) => <option key={i.id} value={i.id}>{i.name} ({fmtMoney(i.amountCents, { compact: true })})</option>)}</select></Field>
            <Field label="Days late"><Num value={wi.days} onChange={(v) => setWi({ ...wi, days: v ?? 0 })} min={-60} max={180} suffix="days" /></Field>
            <Field label="Change in all receipts" hint="For example −15% for a sales decline"><Num pct value={wi.salesPct} onChange={(v) => setWi({ ...wi, salesPct: v ?? 0 })} step={5} /></Field>
            <Field label="One-time payment (equipment, tax, hire)"><Money value={wi.extraCents} onChange={(v) => setWi({ ...wi, extraCents: v ?? 0 })} /></Field>
            <Field label="Payment date"><input type="date" value={wi.extraDate} onChange={(e) => setWi({ ...wi, extraDate: e.target.value })} /></Field>
          </div><ErrorNote error={err} />
          <div className="row"><button className="btn btn-primary" onClick={run}>Show impact by week</button>{scen && <button className="btn" onClick={() => setScen(null)}>Reset to current plan</button>}{scen && <span className={scen.lowestCents < d.floorCents ? 'bad' : 'good'}>Lowest cash becomes {fmtMoney(scen.lowestCents)} (week of {dateLabel(scen.lowestWeek)}), a change of {fmtMoney(scen.lowestCents - f.lowestCents)}.</span>}</div>
        </Card>
        <Card title={`Week-by-week detail${scen ? ' (what-if)' : ''}`}><div className="tbl-wrap"><table className="tbl"><thead><tr><th>Week of</th><th className="num">Beginning cash</th><th className="num">Cash in</th><th className="num">Cash out</th><th className="num">Ending cash</th><th></th></tr></thead><tbody>
          {show.weeks.map((w: any) => <React.Fragment key={w.index}><tr className={w.belowFloor ? 'row-bad' : ''}><td>{dateLabel(w.weekStart)}</td><td className="num">{fmtMoney(w.beginCents)}</td><td className="num">{fmtMoney(w.inflowCents)}</td><td className="num">{fmtMoney(w.outflowCents)}</td><td className="num"><b>{fmtMoney(w.endCents)}</b>{w.belowFloor && <div className="sub bad">below minimum</div>}</td><td><button className="btn btn-sm btn-ghost" onClick={() => setOpenWeek(openWeek === w.index ? null : w.index)} aria-expanded={openWeek === w.index}>{openWeek === w.index ? 'Hide' : 'Daily detail'}</button></td></tr>
            {openWeek === w.index && <tr className="detail"><td colSpan={6}>{w.lines.length ? <table className="tbl"><tbody>{w.lines.map((l: any, i: number) => <tr key={i}><td>{dateLabel(l.date)}</td><td>{l.name}{l.dueDate && <span className="sub">due {dateLabel(l.dueDate)}, paid in the weekly bill run</span>}</td><td className="muted">{l.category.replace(/_/g, ' ')}</td><td className="num">{l.direction === 'in' ? fmtMoney(l.amountCents) : fmtMoney(-l.amountCents)}</td></tr>)}</tbody></table> : <span className="muted">No scheduled receipts or payments.</span>}</td></tr>}</React.Fragment>)}</tbody></table></div></Card></>}
      <Card title="Cash rhythms" right={t.can('weekly_entry') ? <button className="btn" onClick={() => setEdit(blankItem())}>Add cash event</button> : null}>
        <p className="muted">The recurring and one-time receipts and payments that drive the forecast: payroll cycles, rent, loan payments, quarterly taxes, expected customer payments.</p>
        {d.items.length ? <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Event</th><th>Direction</th><th>Category</th><th className="num">Amount</th><th>Cadence</th><th>Next / first date</th><th></th></tr></thead><tbody>
          {d.items.map((i: any) => <tr key={i.id} className={i.active ? '' : 'muted'}><td>{i.name}</td><td>{i.direction === 'in' ? 'Cash in' : 'Cash out'}</td><td>{i.category.replace(/_/g, ' ')}</td><td className="num">{fmtMoney(i.amountCents)}</td><td>{i.cadence}</td><td>{dateLabel(i.anchorDate)}</td><td>{t.can('weekly_entry') && <button className="btn btn-sm btn-ghost" onClick={() => setEdit(i)}>Edit</button>}</td></tr>)}</tbody></table></div> : <Empty>No cash events yet.</Empty>}
      </Card>
      {edit && <Drawer title={edit.id ? 'Edit cash event' : 'Add cash event'} onClose={() => setEdit(null)}>
        <Field label="Name"><input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
        <Field label="Direction"><select value={edit.direction} onChange={(e) => setEdit({ ...edit, direction: e.target.value, category: (CASH_CATEGORIES as any)[e.target.value][0] })}><option value="in">Cash in</option><option value="out">Cash out</option></select></Field>
        <Field label="Category"><select value={edit.category} onChange={(e) => setEdit({ ...edit, category: e.target.value })}>{(CASH_CATEGORIES as any)[edit.direction].map((c: string) => <option key={c} value={c}>{c.replace(/_/g, ' ')}</option>)}</select></Field>
        <Field label="Amount"><Money value={edit.amountCents} onChange={(v) => setEdit({ ...edit, amountCents: v ?? 0 })} /></Field>
        <Field label="Cadence"><select value={edit.cadence} onChange={(e) => setEdit({ ...edit, cadence: e.target.value })}>{CADENCES.map((c) => <option key={c}>{c}</option>)}</select></Field>
        <Field label="First date"><input type="date" value={edit.anchorDate} onChange={(e) => setEdit({ ...edit, anchorDate: e.target.value })} /></Field>
        <Field label="End date (optional)"><input type="date" value={edit.endDate ?? ''} onChange={(e) => setEdit({ ...edit, endDate: e.target.value || null })} /></Field>
        <label className="chk"><input type="checkbox" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} /> Include in forecast</label>
        <ErrorNote error={err} /><div className="row"><button className="btn btn-primary" onClick={saveItem}>Save</button>{edit.id && <button className="btn" onClick={async () => { await del(`${t.base}/cash/items/${edit.id}`); setEdit(null); r.reload(); }}>Delete</button>}</div></Drawer>}
    </>; }}</Async>;
}

// ---------------------------------------------------------------- Reports
export function Reports() {
  const t = useT(); const w = useLoad(() => get(`${t.base}/weekly`), [t.tid]); const s = useLoad(() => get(`${t.base}/scorecard`), [t.tid]);
  return <><div className="page-h"><div><h1>Reports</h1><p className="meta">Published reports are archived as they were issued.</p></div>{t.can('export') && <div className="controls"><button className="btn" onClick={() => download(`${t.base}/export/pnl.csv`, 'management-pnl.csv')}>Export management P&amp;L (CSV)</button></div>}</div>
    <div className="grid-2">
      <Card title="Weekly briefings"><Async r={w}>{(d) => d.reports.length ? <table className="tbl"><tbody>{d.reports.map((x: any) => <tr key={x.id}><td>Week of {dateLabel(x.week_start)}</td><td><StatusPill status={x.status} /></td><td>{x.acknowledged_at ? 'Acknowledged' : ''}</td><td><button className="btn btn-sm" onClick={() => t.go('weekly', x.id)}>Open</button></td></tr>)}</tbody></table> : <Empty>No weekly briefings published yet.</Empty>}</Async></Card>
      <Card title="Monthly scorecards"><Async r={s}>{(d) => d.history.length ? <table className="tbl"><tbody>{d.history.map((x: any) => <tr key={x.period}><td>{P(x.period)}</td><td><StatusPill status={x.status ?? 'published'} /></td><td>{x.published_at ? `Published ${dateLabel(x.published_at)}` : ''}</td><td><button className="btn btn-sm" onClick={() => t.go('scorecard')}>Open</button></td></tr>)}</tbody></table> : <Empty>No scorecards published yet.</Empty>}</Async></Card>
    </div>
    <Note>PDF copies are produced with your browser's print dialog (choose "Save as PDF") from any report page. Email notifications are planned for the reporting service in Phase 3.</Note></>;
}

// ---------------------------------------------------------------- Goals & Actions
export function Actions() {
  const t = useT(); const r = useLoad(() => get(`${t.base}/actions`), [t.tid]); const [edit, setEdit] = useState<any>(null); const [err, setErr] = useState<string | null>(null); const [msg, setMsg] = useState<string | null>(null); const [q, setQ] = useState('');
  const manage = t.can('actions_manage'); const update = t.can('actions_update') || manage;
  const patch = async (id: string, b: any) => { setErr(null); try { await put(`${t.base}/actions/${id}`, b); r.reload(); } catch (e) { setErr((e as Error).message); } };
  const save = async () => { setErr(null); try { if (edit.id) await put(`${t.base}/actions/${edit.id}`, { ...edit, dueDate: edit.due_date ?? null, clientVisible: !!edit.client_visible }); else await post(`${t.base}/actions`, { ...edit, dueDate: edit.due_date ?? null, clientVisible: !!edit.client_visible }); setEdit(null); r.reload(); } catch (e) { setErr((e as Error).message); } };
  return <Async r={r}>{(d) => { const sug = d.actions.filter((a: any) => a.status === 'suggested'); const rest = d.actions.filter((a: any) => a.status !== 'suggested');
    return <>
      <div className="page-h"><div><h1>Goals &amp; Actions</h1><p className="meta">What we agreed to do, who owns it, and where it stands.</p></div>
        <div className="controls">{manage && <><button className="btn" onClick={async () => { const x = await post(`${t.base}/actions/generate`); setMsg(x.created ? `${x.created} new suggestion(s) drafted for your review.` : 'No new suggestions: every measure below target already has an open item.'); r.reload(); }}>Draft suggestions from results</button><button className="btn btn-primary" onClick={() => setEdit({ title: '', observation: '', cause: '', impact: '', recommendation: '', owner: '', priority: 2, due_date: null, client_visible: 1 })}>New action</button></>}</div></div>
      <ErrorNote error={err} />{msg && <Note tone="good">{msg}</Note>}
      {manage && sug.length > 0 && <Card title="Suggested by the analysis — advisor review required" right={<Pill tone="info">Not visible to client</Pill>}>
        <p className="muted">Each suggestion follows Observation → Cause → Impact → Action and cites the figures it is based on. Approve, edit, or dismiss.</p>
        {sug.map((a: any) => <ActionBody key={a.id} a={a}><div className="row"><button className="btn btn-primary btn-sm" onClick={() => patch(a.id, { status: 'open', clientVisible: true })}>Approve &amp; share with client</button><button className="btn btn-sm" onClick={() => setEdit(a)}>Edit</button><button className="btn btn-sm btn-ghost" onClick={() => patch(a.id, { status: 'dismissed' })}>Dismiss</button></div></ActionBody>)}</Card>}
      <Card title="Action register">{rest.length ? rest.map((a: any) => <ActionBody key={a.id} a={a}>
        <div className="row">{update && <label>Status <select value={a.status} onChange={(e) => patch(a.id, { status: e.target.value })}>{['open', 'in_progress', 'done', ...(manage ? ['dismissed'] : [])].map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}</select></label>}
          {update && <label>Owner <input defaultValue={a.owner} onBlur={(e) => e.target.value !== a.owner && patch(a.id, { owner: e.target.value })} /></label>}{update && <label>Due <input type="date" defaultValue={a.due_date ?? ''} onBlur={(e) => (e.target.value || null) !== a.due_date && patch(a.id, { dueDate: e.target.value || null })} /></label>}
          {manage && <button className="btn btn-sm" onClick={() => setEdit(a)}>Edit</button>}{manage && !a.client_visible && <Pill tone="warn">Internal</Pill>}</div>
        {a.history.length > 0 && <p className="muted small">History: {a.history.map((h: any) => `${dateLabel(h.at)} ${h.by} moved ${h.from.replace('_', ' ')} → ${h.to.replace('_', ' ')}`).join(' · ')}</p>}</ActionBody>) : <Empty>No actions yet.</Empty>}</Card>
      {t.can('comment') && !t.tenant.isStaff && <Card title="Ask your CFO advisor"><p className="muted">Send a question or request a financial strategy review.</p><div className="row"><input value={q} placeholder="Your question" onChange={(e) => setQ(e.target.value)} /><button className="btn" onClick={async () => { if (!q.trim()) return; await post(`${t.base}/comments`, { entity: 'question', body: q }); setQ(''); setMsg('Sent to your advisor.'); }}>Send</button><button className="btn" onClick={async () => { await post(`${t.base}/comments`, { entity: 'question', body: 'Client requested a financial strategy review.' }); setMsg('Strategy review requested.'); }}>Request a strategy review</button></div></Card>}
      {edit && <Drawer title={edit.id ? 'Edit action' : 'New action'} onClose={() => setEdit(null)} wide>
        {(['title', 'observation', 'cause', 'impact', 'recommendation'] as const).map((k) => <Field key={k} label={{ title: 'Title', observation: 'Observation', cause: 'Financial cause', impact: 'Business impact', recommendation: 'Recommended action' }[k]}>{k === 'title' ? <input value={edit[k]} onChange={(e) => setEdit({ ...edit, [k]: e.target.value })} /> : <textarea rows={2} value={edit[k]} onChange={(e) => setEdit({ ...edit, [k]: e.target.value })} />}</Field>)}
        {!edit.id && <><Field label="Estimated financial impact (optional)" hint="Leave blank unless it can be supported. A basis is required."><Money nullable value={edit.impactCents ?? null} onChange={(v) => setEdit({ ...edit, impactCents: v })} /></Field><Field label="How the impact was calculated"><input value={edit.impactBasis ?? ''} onChange={(e) => setEdit({ ...edit, impactBasis: e.target.value })} /></Field></>}
        <div className="form-grid"><Field label="Owner"><input value={edit.owner} onChange={(e) => setEdit({ ...edit, owner: e.target.value })} /></Field><Field label="Due date"><input type="date" value={edit.due_date ?? ''} onChange={(e) => setEdit({ ...edit, due_date: e.target.value || null })} /></Field><Field label="Priority"><select value={edit.priority} onChange={(e) => setEdit({ ...edit, priority: Number(e.target.value) })}><option value={1}>1 — highest</option><option value={2}>2</option><option value={3}>3</option></select></Field></div>
        <label className="chk"><input type="checkbox" checked={!!edit.client_visible} onChange={(e) => setEdit({ ...edit, client_visible: e.target.checked ? 1 : 0 })} /> Visible to the client</label>
        <ErrorNote error={err} /><button className="btn btn-primary" onClick={save}>Save</button></Drawer>}
    </>; }}</Async>;
}
function ActionBody({ a, children }: { a: any; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return <article className="action"><header><b>{a.title}</b> <StatusPill status={a.status} /> <span className="muted">Priority {a.priority}{a.owner && ` · ${a.owner}`}{a.due_date && ` · due ${dateLabel(a.due_date)}`}</span></header>
    <p>{a.observation}</p><p><span className="lbl">Recommended action</span> {a.recommendation}</p>
    {a.impact_cents !== null && <p><span className="lbl">Estimated impact</span> {fmtMoney(a.impact_cents)} <span className="muted">— {a.impact_basis}</span></p>}
    <button className="btn btn-sm btn-ghost" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? 'Hide evidence' : 'Why? Show cause and evidence'}</button>
    {open && <div className="evidence">{a.cause && <p><span className="lbl">Financial cause</span> {a.cause}</p>}{a.impact && <p><span className="lbl">Business impact</span> {a.impact}</p>}{a.evidence.length > 0 && <table className="tbl"><tbody>{a.evidence.map((e: any) => <tr key={e.label}><td>{e.label}</td><td className="num">{e.value}</td></tr>)}</tbody></table>}<p className="muted small">Source: {a.source === 'generated' ? 'drafted by the rules engine from the figures above, reviewed by your advisor' : 'written by your advisor'}.</p></div>}
    {children}</article>;
}

// ---------------------------------------------------------------- Industry KPIs
export function IndustryKpis() {
  const t = useT(); const r = useLoad(() => get(`${t.base}/kpis`), [t.tid]); const [vals, setVals] = useState<Record<string, string>>({}); const [err, setErr] = useState<string | null>(null); const [cfg, setCfg] = useState<any>(null);
  return <Async r={r}>{(d) => { const needed = [...new Set(d.kpis.flatMap((k: any) => k.inputsNeeded))] as string[]; const have = (k: string) => d.inputs.find((i: any) => i.key === k && i.period === d.period)?.value;
    const saveInputs = async () => { setErr(null); try { const inputs = Object.entries(vals).filter(([, v]) => v !== '').map(([key, v]) => ({ key, period: d.period, value: Number(v) })); await put(`${t.base}/kpi-inputs`, { inputs }); setVals({}); r.reload(); } catch (e) { setErr((e as Error).message); } };
    return <>
      <div className="page-h"><div><h1>Industry KPIs</h1><p className="meta">{d.period ? <>Period <b>{P(d.period)}</b> · </> : null}Measures specific to this kind of business, alongside the core financials.</p></div></div>
      {!d.kpis.length ? <Empty>No industry KPIs are assigned to this client yet.</Empty> : <div className="kpi-tiles">{d.kpis.map((k: any) => <div key={k.id} className="card kpi-tile">
        <header><h3>{k.name}</h3><Pill tone={k.status === 'on_target' ? 'good' : k.status === 'alert' ? 'bad' : k.status === 'watch' ? 'warn' : 'neutral'}>{{ on_target: 'On target', watch: 'Below target', alert: 'Needs attention', 'n/a': k.value === null ? 'N/A' : 'No target set' }[k.status as string]}</Pill></header>
        <div className="kpi-v">{fmtKpi(k.value, k.unit)}</div>
        <p className="muted small">{k.value === null ? k.reason : <>Target {k.target === null ? 'not set' : fmtKpi(k.target, k.unit)} · {k.direction === 'higher' ? 'higher is better' : 'lower is better'} · {k.basis === 'r12' ? 'rolling 12' : 'monthly'}</>}</p>
        <Spark values={k.history.map((h: any) => h.value)} width={220} height={36} />
        <p>{k.description}</p>{k.status !== 'on_target' && k.status !== 'n/a' && k.recommendedAction && <p><span className="lbl">Suggested action</span> {k.recommendedAction}</p>}
        <p className="muted small mono">= {k.formula}<br />Source: {k.dataSource || 'not specified'}</p>{t.tenant.isStaff && k.benchmarkSource && <p className="muted small">{k.benchmarkSource}</p>}
        {t.can('kpi_assign') && <button className="btn btn-sm btn-ghost" onClick={() => setCfg({ ...k })}>Target &amp; visibility</button>}</div>)}</div>}
      {t.can('kpi_inputs') && needed.length > 0 && <Card title={`Operational inputs for ${d.period ? P(d.period) : ''}`} right={<Pill tone="info">Advisor only</Pill>}>
        <p className="muted">These figures come from outside the accounting system (job tracking, timekeeping, scheduling). A KPI shows N/A until its inputs are entered.</p>
        <div className="form-grid">{needed.map((k) => <Field key={k} label={k.replace(/_/g, ' ')}><input type="number" placeholder={have(k) !== undefined ? String(have(k)) : 'not entered'} value={vals[k] ?? ''} onChange={(e) => setVals({ ...vals, [k]: e.target.value })} /></Field>)}</div>
        <ErrorNote error={err} /><button className="btn btn-primary" onClick={saveInputs}>Save inputs</button></Card>}
      {t.can('kpi_assign') && d.packs.length > 0 && <Card title="Apply an industry KPI pack" right={<Pill tone="info">Advisor only</Pill>}><div className="row"><select id="addpack" defaultValue="">{<option value="" disabled>Choose an industry…</option>}{d.packs.map((p: any) => <option key={p.id} value={p.id}>{p.name} — {p.kpis} KPIs</option>)}</select><button className="btn" onClick={async () => { const v = (document.getElementById('addpack') as HTMLSelectElement).value; if (v) { await post(`${t.base}/kpis/apply-pack`, { industryId: v }); r.reload(); } }}>Apply pack to this client</button></div><p className="muted small">A client can carry more than one pack (for example a contractor that also manages property). Remove any KPI that does not apply from its "Target &amp; visibility" panel.</p></Card>}
      {t.can('kpi_assign') && d.available.length > 0 && <Card title="Add a KPI from the library"><div className="row"><select id="addkpi" defaultValue="">{<option value="" disabled>Choose a KPI…</option>}{d.available.map((k: any) => <option key={k.id} value={k.id}>{k.industry} — {k.name}</option>)}</select><button className="btn" onClick={async () => { const v = (document.getElementById('addkpi') as HTMLSelectElement).value; if (v) { await put(`${t.base}/kpis/${v}`, {}); r.reload(); } }}>Assign to this client</button></div><p className="muted small">New KPI definitions are created in the KPI Library — no code change needed.</p></Card>}
      {cfg && <Drawer title={cfg.name} onClose={() => setCfg(null)}>
        <Field label="Target for this client" hint="Set from this client's own goals. No industry average is assumed."><Num nullable value={cfg.target} onChange={(v) => setCfg({ ...cfg, target: v })} step={0.01} /></Field>
        <Field label="Alert threshold"><Num nullable value={cfg.alert} onChange={(v) => setCfg({ ...cfg, alert: v })} step={0.01} /></Field>
        <label className="chk"><input type="checkbox" checked={cfg.clientVisible} onChange={(e) => setCfg({ ...cfg, clientVisible: e.target.checked })} /> Visible to the client</label>
        <div className="row"><button className="btn btn-primary" onClick={async () => { await put(`${t.base}/kpis/${cfg.id}`, { target: cfg.target, alertThreshold: cfg.alert, clientVisible: cfg.clientVisible }); setCfg(null); r.reload(); }}>Save</button><button className="btn" onClick={async () => { await put(`${t.base}/kpis/${cfg.id}`, { remove: true }); setCfg(null); r.reload(); }}>Remove from client</button></div></Drawer>}
    </>; }}</Async>;
}
void useMemo;
