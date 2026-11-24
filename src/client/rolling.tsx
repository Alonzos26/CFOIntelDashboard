// Rolling-twelve P&L with salary cap chart and expense category checks; weekly sales and productivity report (Crabtree ch. 8).
import React, { useState } from 'react';
import { get } from './api.ts';
import { useT } from './App.tsx';
import { Async, Card, Drawer, Note, P, Pill, dateLabel, useLoad } from './ui.tsx';
import { C, Chart } from './charts.tsx';
import { fmtMoney, fmtPct, fmtRatio } from '../engine/core.ts';

const R = (r: { value: number | null }) => fmtRatio(r.value);

function LineDrill({ line, to, periods, onClose }: { line: string; to: string; periods: string[]; onClose: () => void }) {
  const t = useT(); const [end, setEnd] = useState(to); const r = useLoad(() => get(`${t.base}/financials/line-accounts?line=${line}&to=${end}`), [t.tid, line, end]);
  return <Drawer wide title="Accounts behind this line" onClose={onClose}>
    <label className="check">Twelve months ended <select value={end} onChange={(e) => setEnd(e.target.value)}>{[...periods].reverse().map((p) => <option key={p} value={p}>{P(p)}</option>)}</select></label>
    <Async r={r}>{(d) => <>
      <p className="meta"><b>{d.label}</b> · {P(d.from)} – {P(d.to)} · {d.accounts.length} account(s){!d.complete && ` · only ${d.monthsIncluded} months available`}</p>
      <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Account as imported</th><th className="num">12 months</th><th className="num">Share</th><th className="num">Monthly average</th><th className="num">{P(d.to)}</th></tr></thead><tbody>
        {d.accounts.map((a: any) => <tr key={a.name}><td>{a.name}</td><td className="num">{fmtMoney(a.totalCents)}</td><td className="num muted">{d.totalCents ? fmtPct(a.totalCents / d.totalCents, 0) : ''}</td><td className="num">{fmtMoney(Math.round(a.totalCents / d.monthsIncluded))}</td><td className={`num ${Math.abs(a.latestCents) > Math.abs(a.totalCents / d.monthsIncluded) * 1.5 && Math.abs(a.latestCents) > 50000 ? 'bad' : ''}`}>{fmtMoney(a.latestCents)}</td></tr>)}
        <tr className="tot"><td>Total</td><td className="num">{fmtMoney(d.totalCents)}</td><td></td><td className="num">{fmtMoney(Math.round(d.totalCents / d.monthsIncluded))}</td><td className="num">{fmtMoney(d.accounts.reduce((x: number, a: any) => x + a.latestCents, 0))}</td></tr></tbody></table></div>
      <p className="muted small">Account names are as they appear in the imported books. The latest month is shown in red when it is more than one and a half times that account's monthly average. To move an account to a different line, change its mapping under Data Sources.</p></>}</Async>
  </Drawer>;
}

export function RollingTab({ rows, checks, recent }: { rows: any[]; checks: any[]; recent?: any }) {
  const [drill, setDrill] = useState<string | null>(null);
  if (!rows.length) return <Card><p className="muted">A rolling-twelve view needs at least twelve months of history. It is never shown on fewer.</p></Card>;
  const last = rows[rows.length - 1]; const hasPtb = rows.some((r) => r.payrollTaxesBenefits !== null); const lab = rows.map((r) => P(r.period));
  const line = (label: React.ReactNode, f: (r: any) => React.ReactNode, cls = '', neg?: (r: any) => boolean) => <tr className={cls}><td>{label}</td>{rows.map((r) => <td key={r.period} className={`num ${neg?.(r) ? 'bad' : ''}`}>{f(r)}</td>)}</tr>;
  const $ = (v: number) => fmtMoney(v, { compact: Math.abs(v) >= 100_000_00 });
  const dl = (label: string, key: string) => <button className="linkish" title="Show the accounts behind this line" onClick={() => setDrill(key)}>{label}</button>;
  return <>
    <Note>Each column is the twelve months ending in that month, so every column has been through all four seasons. A single month is too short to judge; compare the columns side by side.</Note>
    <RecentCard recent={recent} />
    <Card title="Rolling-twelve P&L"><div className="tbl-wrap"><table className="tbl pnl r12"><thead><tr><th>12 months ended</th>{rows.map((r) => <th key={r.period} className="num">{P(r.period)}</th>)}</tr></thead><tbody>
      {line(dl('Revenue', 'revenue'), (r) => $(r.revenue))}{line(dl('Non-labor cost of goods sold', 'cogs'), (r) => $(r.cogs))}{line('Gross profit before labor', (r) => $(r.grossProfit), 'tot')}{line('as % of revenue', (r) => fmtPct(r.gpPct.value, 0), 'sub-row')}
      {line(dl(hasPtb ? 'Labor — all, owner at market wage' : 'Labor — all, incl. payroll taxes & benefits', 'labor'), (r) => $(r.labor))}{line(dl('Marketing', 'marketing'), (r) => $(r.marketing))}{line(dl('Facilities', 'facilities'), (r) => $(r.facilities))}
      {hasPtb && line(dl('Payroll taxes & benefits', 'payroll_taxes_benefits'), (r) => $(r.payrollTaxesBenefits))}{line(dl('Other operating expenses', 'other_opex'), (r) => $(r.otherOpex))}{rows.some((r) => r.otherNet !== 0) && line(dl('Other income, depreciation, interest', 'other_net'), (r) => $(r.otherNet))}
      {line('True pretax profit', (r) => <b>{$(r.pretax)}</b>, 'tot', (r) => r.pretax < 0)}{line('as % of revenue', (r) => fmtPct(r.pretaxPct.value), 'sub-row')}
      {line(`Pretax profit target`, (r) => $(r.targetCents))}{line('Above (below) target', (r) => $(r.aboveBelowCents), '', (r) => r.aboveBelowCents < 0)}
      {line('Salary cap', (r) => $(r.salaryCap), 'tot')}{line('Labor yield (gross profit ÷ labor)', (r) => R(r.ler))}{line('Labor yield needed for target', (r) => R(r.lerTarget))}
    </tbody></table></div>
      {drill && <LineDrill line={drill} to={last.period} periods={rows.map((r) => r.period)} onClose={() => setDrill(null)} />}
      <p className="muted small">Select an underlined line to see the accounts behind it. Above (below) target is also the amount labor is under (over) the salary cap: closing a shortfall means that much less labor, or that much more gross profit from the same labor.</p></Card>
    <div className="grid-2">
      <Card title="Gross profit, labor and salary cap — rolling twelve"><Chart labels={lab} kind="money" zeroBased series={[{ name: 'Gross profit', values: rows.map((r) => r.grossProfit), color: C.s1 }, { name: 'Labor — all', values: rows.map((r) => r.labor), color: C.s2 }, { name: 'Salary cap', values: rows.map((r) => r.salaryCap), color: C.neutral, dashed: true }]} />
        <p className="muted small">When the labor line is above the salary cap line, the business is below its profit target. The gap closes by raising gross profit or by lowering labor.</p></Card>
      <Card title={`Reaching ${fmtPct(last.stretchPct, 0)} pretax profit`} right={<Pill>{P(last.period)}</Pill>}>
        {last.additionalGpForStretchCents === 0 ? <p className="good">True pretax profit is already at or above {fmtPct(last.stretchPct, 0)} of revenue for the twelve months.</p> : <>
          <div className="stat-grid"><div><span>Additional gross profit needed</span><b>{fmtMoney(last.additionalGpForStretchCents)}</b><small>With costs and labor held where they are</small></div>
            <div><span>Productivity increase required</span><b>{fmtPct(last.productivityIncrease.value)}</b><small>More gross profit from the same staff</small></div></div>
          <p className="muted small">Getting this from productivity is usually more realistic than cutting the same percentage out of operating expenses. The stretch level is set in Client Settings.</p></>}
        <table className="tbl"><tbody><tr><td>True pretax profit, 12 months</td><td className="num">{fmtMoney(last.pretax)} · {fmtPct(last.pretaxPct.value)}</td></tr><tr><td>Labor yield now / needed for target</td><td className="num">{R(last.ler)} / {R(last.lerTarget)}</td></tr></tbody></table>
        {last.lerTarget.reason && <p className="muted small">{last.lerTarget.reason}</p>}</Card>
    </div>
    {checks.length > 0 && <Card title="Operating expense categories — what to look at">
      <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Category</th><th className="num">Latest</th><th>Observation</th></tr></thead><tbody>
        {checks.map((c) => <tr key={c.key}><td><b>{c.label}</b> {c.tone === 'warn' && <Pill tone="warn">Look into</Pill>}</td><td className="num">{c.value}</td><td>{c.text}</td></tr>)}</tbody></table></div>
      <p className="muted small">These are observations from the imported figures, not grades. Facilities and other expenses normally hold steady, and payroll taxes and benefits normally move with payroll, so a departure is worth explaining once and then fixing.</p></Card>}
  </>;
}

export function ProductivityCard({ p }: { p: any }) {
  if (!p || !p.rows.length) return null; const hasTarget = p.targetLER !== null;
  return <Card title="Sales and productivity report" right={hasTarget ? <Pill>Target {fmtRatio(p.targetLER)}</Pill> : null}>
    <p className="meta">Gross profit per payroll dollar, by week, month to date and year to date. Fiscal year from {P(p.fiscalYearStart)}.</p>
    <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Period</th><th className="num">GP %</th><th className="num">Sales</th><th className="num">Gross profit</th><th className="num">Payroll — all</th>{hasTarget && <th className="num">Payroll the GP supports</th>}{hasTarget && <th className="num">Over (under)</th>}<th className="num">Week</th><th className="num">Month to date</th><th className="num">Year to date</th></tr></thead><tbody>
      {p.rows.map((r: any) => <tr key={r.key} className={r.kind === 'month_total' ? 'tot' : r.kind === 'month' ? 'muted-row' : ''}><td>{r.kind === 'week' ? <>{r.label}<span className="sub">{dateLabel(r.key).replace(/, \d{4}/, '')}</span></> : r.label}</td>
        <td className="num">{fmtPct(r.gpPct.value)}</td><td className="num">{fmtMoney(r.salesCents)}</td><td className="num">{fmtMoney(r.gpCents)}</td><td className="num">{r.laborCents === null ? <span className="muted">not entered</span> : fmtMoney(r.laborCents)}</td>
        {hasTarget && <td className="num">{fmtMoney(r.supportedLaborCents)}</td>}{hasTarget && <td className={`num ${r.laborOverUnderCents > 0 ? 'bad' : ''}`}>{r.laborOverUnderCents === null ? '—' : fmtMoney(r.laborOverUnderCents)}</td>}
        <td className="num">{r.weekLER ? R(r.weekLER) : ''}</td><td className="num">{R(r.mtdLER)}</td><td className="num"><b>{R(r.ytdLER)}</b></td></tr>)}</tbody></table></div>
    {p.weeksMissingLabor > 0 && <Note tone="warn">{p.weeksMissingLabor} week(s) have no office and management payroll entered, so all-labor yield is shown as N/A for them rather than overstated from direct labor alone. Add it under "Enter weekly figures".</Note>}
    <p className="muted small">Closed months come from the accounting P&amp;L; the open month comes from weekly entries. Payroll here is wages as paid for everyone, without payroll taxes or the owner market-wage adjustment, so it runs higher than labor yield on the Scorecard. {hasTarget ? 'The target is the ratio at which the last twelve months would have met the pretax profit target. ' : 'A target appears once twelve months of history exist. '}One weak week may be an anomaly; a weak month to date is a trend to act on.</p>
  </Card>;
}

const TONE: Record<string, [string, string]> = { better: ['good', 'Improving'], worse: ['bad', 'Slipping'], in_line: ['', 'In line'], seasonal: ['info', 'Seasonal'], mixed: ['warn', 'No clear direction'] };
const rv = (v: number | null, kind: string) => (v === null ? 'N/A' : kind === 'pct' ? fmtPct(v) : kind === 'ratio' ? fmtRatio(v) : fmtMoney(v, { compact: Math.abs(v) >= 100_000_00 }));
export function RecentPill({ s }: { s: any }) { if (!s?.status) return null; const [tone, label] = TONE[s.status]; return <Pill tone={tone as any}>{label}{(s.status === 'better' || s.status === 'worse') && !s.confirmed ? ' (unchecked)' : ''}</Pill>; }
/** Rolling three beside the rolling twelve: direction only. Grades and targets stay on twelve months. */
export function RecentCard({ recent }: { recent: any }) {
  if (!recent) return <Card title="Last three months: which way is it heading?"><p className="muted">Available once twelve months of history are imported.</p></Card>;
  return <Card title="Last three months: which way is it heading?" right={<Pill>{P(recent.from)} – {P(recent.period)}</Pill>}>
    <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Measure</th><th className="num">Last 3 months</th><th className="num">Same 3 months last year</th><th className="num">Rolling 12</th><th>Direction</th><th>Reading</th></tr></thead><tbody>
      {recent.signals.map((x: any) => <tr key={x.key}><td><b>{x.label}</b></td><td className="num"><b>{rv(x.r3, x.kind)}</b></td><td className="num">{x.lastYear === null ? <span className="muted">not yet</span> : rv(x.lastYear, x.kind)}</td><td className="num">{x.key === 'sales' ? <span className="muted">—</span> : rv(x.r12, x.kind)}</td><td><RecentPill s={x} /></td><td className="small">{x.text}</td></tr>)}</tbody></table></div>
    <p className="muted small">The rolling twelve is the number of record: it has been through every season. Three months show a turn sooner, but they carry the season with them, so a gap only counts as a change when the same three months last year do not explain it. Sales are compared with last year only.{!recent.lastYearAvailable && ' Fewer than fifteen months are imported, so the seasonal check is not available yet and directions are marked unchecked.'}</p>
  </Card>;
}
