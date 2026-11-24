// What-if forecast (Crabtree ch. 10): a handful of levers, a thin P&L, and the road from profit to cash. Built for a client to use alone.
import React, { useEffect, useRef, useState } from 'react';
import { del, get, post, put } from './api.ts';
import { useT } from './App.tsx';
import { Card, ErrorNote, Field, Money, Note, Num, P, Pill, StatusPill, dateLabel, useLoad } from './ui.tsx';
import { C, Chart } from './charts.tsx';
import { fmtMoney, fmtPct, fmtRatio } from '../engine/core.ts';

const signed = (c: number) => `${c >= 0 ? '+' : '−'}${fmtMoney(Math.abs(c))}`;
const same = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);

export function WhatIfForecast() {
  const t = useT(); const [d, setD] = useState<any>(null); const [lv, setLv] = useState<any>(null); const [err, setErr] = useState<string | null>(null); const [msg, setMsg] = useState<string | null>(null);
  const [name, setName] = useState(''); const [id, setId] = useState<string | null>(null); const list = useLoad(() => get(`${t.base}/scenarios`), [t.tid]); const seq = useRef(0); const canSave = t.can('scenario_write');
  useEffect(() => { get(`${t.base}/what-if`).then((x) => { setD(x); if (x.available) setLv(x.levers); }).catch((e) => setErr(e.message)); }, [t.tid]);
  // Recalculate shortly after the last change, and ignore answers that arrive out of order.
  useEffect(() => { if (!lv || !d?.available || same(lv, d.levers)) return; const n = ++seq.current; const h = setTimeout(() => post(`${t.base}/what-if`, { levers: lv }).then((x) => { if (n === seq.current) { setD(x); setErr(null); } }).catch((e) => setErr(e.message)), 250); return () => clearTimeout(h); }, [lv]);
  if (!d) return <Card title="What-if forecast"><ErrorNote error={err} />{!err && <p className="muted">Loading…</p>}</Card>;
  if (!d.available) return <Card title="What-if forecast"><p className="muted">{d.reason}</p></Card>;
  const s = d.summary, df = d.defaults, n12 = s.next12, fy = s.fiscalYear, v = s.vsBaseline; const set = (p: any) => { setLv({ ...lv, ...p }); setMsg(null); }; const changed = !same(lv, df);
  const saved = (list.data?.scenarios ?? []).filter((x: any) => x.type === 'forecast');
  const presets: [string, any][] = [['Sales up 10%', { salesChangePct: lv.salesChangePct + 0.1 }], ['Gross profit up 2 points', { grossProfitPct: Math.min(1, lv.grossProfitPct + 0.02) }], ['Add $5,000 a month of payroll', { payrollChangeMonthlyCents: lv.payrollChangeMonthlyCents + 500000 }], ...(lv.dsoDays !== null ? [['Collect 10 days faster', { dsoDays: Math.max(0, lv.dsoDays - 10) }] as [string, any]] : []), ['Pay down $2,000 of debt a month', { debtPaydownMonthlyCents: lv.debtPaydownMonthlyCents + 200000 }]];
  const save = async () => { setErr(null); try { const nm = name.trim() || 'What-if forecast'; const x = id ? await put(`${t.base}/scenarios/${id}`, { name: nm, inputs: lv }) : await post(`${t.base}/scenarios`, { type: 'forecast', name: nm, inputs: lv }); setId(x.id); setName(nm); setMsg('Saved. Your advisor can see it too.'); list.reload(); } catch (e) { setErr((e as Error).message); } };
  const open = async (sid: string) => { const x = await get(`${t.base}/scenarios/${sid}`); setId(x.id); setName(x.name); setLv({ ...df, ...x.inputs }); setMsg(null); window.scrollTo(0, 0); };
  const labels = d.months.map((m: any) => P(m.period)); const row = (label: React.ReactNode, f: (m: any) => React.ReactNode, cls = '') => <tr className={cls}><td>{label}</td>{d.months.map((m: any) => <td key={m.period} className="num">{f(m)}</td>)}</tr>; const $ = (c: number) => fmtMoney(c, { compact: Math.abs(c) >= 100_000_00 });
  return <>
    <Card title="What-if forecast" right={<Pill tone="warn">Forecast — not actuals</Pill>}>
      <p className="meta">Starts from your results through <b>{P(d.basePeriod)}</b> ({d.baseStatus}) and looks twelve months ahead. Change a number and everything updates. Nothing here changes your accounting records.</p>
      {d.basis === 'cash' && <Note tone="warn">These books are kept on the cash basis, so receivables and the timing of profit are less reliable here.</Note>}
      <div className="row wrap no-print"><span className="muted small">Try:</span>{presets.map(([l, p]) => <button key={l} className="btn btn-sm" onClick={() => set(p)}>{l}</button>)}{changed && <button className="btn btn-sm btn-ghost" onClick={() => { setLv(df); setId(null); setName(''); }}>Back to "change nothing"</button>}</div>
      <div className="form-grid">
        <Field label="Sales compared with last year" hint="Month by month, so busy and slow seasons stay where they are."><Num pct value={lv.salesChangePct} onChange={(x) => set({ salesChangePct: x ?? 0 })} min={-90} max={300} step={1} /></Field>
        <Field label="Gross profit on each sales dollar" hint={`Before labor. The last twelve months: ${fmtPct(df.grossProfitPct)}.`}><Num pct value={lv.grossProfitPct} onChange={(x) => set({ grossProfitPct: x ?? 0 })} min={0} max={100} step={0.5} /></Field>
        <Field label="Payroll added or cut, per month" hint="A hire or a raise is a plus; use a minus to cut. Payroll taxes and benefits follow."><Money value={lv.payrollChangeMonthlyCents} onChange={(x) => set({ payrollChangeMonthlyCents: x ?? 0 })} /></Field>
        <Field label="Other expenses added or cut, per month" hint="Marketing, rent and everything else."><Money value={lv.overheadChangeMonthlyCents} onChange={(x) => set({ overheadChangeMonthlyCents: x ?? 0 })} /></Field>
        {lv.dsoDays !== null && <Field label="Days customers take to pay" hint={`Now: ${df.dsoDays} days.`}><Num value={lv.dsoDays} onChange={(x) => set({ dsoDays: Math.max(0, Math.round(x ?? df.dsoDays)) })} min={0} max={365} step={1} suffix="days" /></Field>}
        <Field label="Debt paid down, per month" hint="Beyond what the current payments already cover. Line of credit first."><Money value={lv.debtPaydownMonthlyCents} onChange={(x) => set({ debtPaydownMonthlyCents: Math.max(0, x ?? 0) })} /></Field>
        <Field label="Equipment and other purchases, per month"><Money value={lv.purchasesMonthlyCents} onChange={(x) => set({ purchasesMonthlyCents: Math.max(0, x ?? 0) })} /></Field>
        <Field label="Owner distributions"><select value={lv.distributionPolicy} onChange={(e) => set({ distributionPolicy: e.target.value })}><option value="tax_only">For taxes only</option><option value="tax_then_excess">Taxes, plus anything above the core capital target</option><option value="none">None</option></select></Field>
      </div>
      <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))' }}>
        <div><span>True pretax profit, next 12 months</span><b>{fmtMoney(n12.truePretax)}</b><small>{fmtPct(n12.pretaxPct.value)} of sales · target {fmtPct(fy.targetPct, 0)}{changed ? ` · ${signed(v.pretax)} vs changing nothing` : ''}</small></div>
        <div><span>Cash in 12 months</span><b>{n12.endCash === null ? 'N/A' : fmtMoney(n12.endCash)}</b><small>{n12.endCash === null ? 'Needs a balance sheet' : `Today ${fmtMoney(n12.startCash)}${changed ? ` · ${signed(v.endCash)} vs changing nothing` : ''}`}</small></div>
        <div><span>Lowest cash on the way</span><b className={n12.minCash !== null && n12.minCash < 0 ? 'bad' : ''}>{n12.minCash === null ? 'N/A' : fmtMoney(n12.minCash)}</b><small>{n12.minCashPeriod ? `End of ${P(n12.minCashPeriod)}` : ''}</small></div>
        <div><span>Core capital in 12 months</span><b>{n12.endCoreCapital === null ? 'N/A' : fmtMoney(n12.endCoreCapital)}</b><small>Target {fmtMoney(n12.endTarget)}{n12.coreCapitalReached ? ` · reached ${P(n12.coreCapitalReached)}` : n12.endCoreCapital !== null ? ' · not reached' : ''}</small></div>
        <div><span>Where this fiscal year lands</span><b>{fmtMoney(fy.truePretax)}</b><small>{fmtPct(fy.pretaxPct.value)} on {fmtMoney(fy.revenue, { compact: true })} of sales · {fy.actualMonths} months actual + {fy.forecastMonths} forecast</small></div>
        <div><span>Labor efficiency</span><b>{fmtRatio(n12.ler.value)}</b><small>Gross profit per payroll dollar</small></div>
      </div>
      {d.flags.map((f: any) => <Note key={f.text} tone={f.severity}>{f.text}</Note>)}
      {d.cashReason && <Note>{d.cashReason}</Note>}
      {d.cashAvailable ? <Chart title="Cash at the end of each month" labels={labels} kind="money" series={[{ name: changed ? 'This what-if' : 'Change nothing', values: d.months.map((m: any) => m.cashEnd), color: C.s1 }, ...(changed ? [{ name: 'Change nothing', values: d.baseline.map((b: any) => b.cashEnd), color: C.neutral, dashed: true }] : []), { name: 'Core capital target', values: d.months.map((m: any) => m.coreCapitalTarget + m.locEnd), color: C.s3, dashed: true }]} />
        : <Chart title="True pretax profit by month" labels={labels} kind="money" bars series={[{ name: 'True pretax profit', values: d.months.map((m: any) => m.truePretax), color: C.s1 }]} />}
      <details><summary>Month by month: profit, and how it turns into cash</summary><div className="tbl-wrap"><table className="tbl pnl r12"><thead><tr><th></th>{d.months.map((m: any) => <th key={m.period} className="num">{P(m.period)}</th>)}</tr></thead><tbody>
        {row('Sales', (m) => $(m.revenue))}{row('Gross profit before labor', (m) => $(m.grossProfit), 'tot')}{row('as % of sales', (m) => fmtPct(m.gpPct.value, 0), 'sub-row')}
        {row('Payroll — all', (m) => $(m.labor))}{row('Marketing', (m) => $(m.marketing))}{row('Facilities', (m) => $(m.facilities))}{row('Payroll taxes & benefits', (m) => $(m.payrollTaxesBenefits))}{row('Other operating expenses', (m) => $(m.otherOpex))}
        {d.months.some((m: any) => m.otherNet) && row('Other income, depreciation, interest', (m) => $(m.otherNet))}
        {row('Pretax profit', (m) => <b>{$(m.pretax)}</b>, 'tot')}{d.months.some((m: any) => m.truePretax !== m.pretax) && row('True pretax profit, owner at market wage', (m) => $(m.truePretax))}
        {d.cashAvailable && <>
          {d.months.some((m: any) => m.nonCash) && row('Add back depreciation (not cash)', (m) => $(m.nonCash))}
          {row('Customers owing more (−) or less (+)', (m) => $(m.arChange))}{row('Bills owed: more (+) or less (−)', (m) => $(m.apChange))}{row('Debt borrowed (+) or repaid (−)', (m) => $(m.debtChange))}
          {row('Owner distributions for tax', (m) => $(-m.taxDistribution))}{d.months.some((m: any) => m.profitDistribution) && row('Owner profit distributions', (m) => $(-m.profitDistribution))}{d.months.some((m: any) => m.purchases) && row('Equipment and other purchases', (m) => $(-m.purchases))}
          {row('Change in cash', (m) => <b>{$(m.netChange)}</b>, 'tot')}{row('Cash at end of month', (m) => <b className={m.cashEnd < 0 ? 'bad' : ''}>{$(m.cashEnd)}</b>, 'tot')}
          {row('Core capital (cash less line of credit)', (m) => $(m.coreCapital))}{row('Core capital target', (m) => $(m.coreCapitalTarget))}{lv.dsoDays !== null && row('Days to collect', (m) => (m.dso.value === null ? 'N/A' : Math.round(m.dso.value)))}</>}
        {row('Labor efficiency, month', (m) => fmtRatio(m.ler.value))}{row('Labor efficiency, year to date', (m) => fmtRatio(m.lerYtd.value))}
      </tbody></table></div></details>
      <details><summary>What this forecast assumes</summary><ul className="plain">{d.assumptions.map((a: string) => <li key={a}>{a}</li>)}</ul></details>
      <ErrorNote error={err} />{msg && <Note tone="good">{msg}</Note>}
      {canSave && <div className="row no-print"><input aria-label="Name this what-if" placeholder="Name this what-if" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} style={{ maxWidth: 320 }} /><button className="btn btn-primary" onClick={save}>{id ? 'Save changes' : 'Save'}</button>{id && <button className="btn" onClick={() => { setId(null); setName(''); }}>Save as new</button>}<button className="btn" onClick={() => window.print()}>Print / PDF</button></div>}
    </Card>
    {saved.length > 0 && <Card title="Saved what-if forecasts"><div className="tbl-wrap"><table className="tbl"><thead><tr><th>Name</th><th>Status</th><th className="num">Profit vs changing nothing</th><th className="num">Cash in 12 months</th><th className="num">Lowest cash</th><th>By</th><th>Updated</th><th></th></tr></thead><tbody>
      {saved.map((x: any) => <tr key={x.id}><td><b>{x.name}</b></td><td><StatusPill status={x.status} /></td><td className="num">{x.summary ? signed(x.summary.pretaxDelta) : '—'}</td><td className="num">{x.summary?.endCash == null ? '—' : fmtMoney(x.summary.endCash)}</td><td className={`num ${x.summary?.minCash < 0 ? 'bad' : ''}`}>{x.summary?.minCash == null ? '—' : fmtMoney(x.summary.minCash)}</td><td>{x.created_by}</td><td>{dateLabel(x.updated_at)}</td>
        <td><div className="row"><button className="btn btn-sm" onClick={() => open(x.id)}>Open</button>{canSave && <button className="btn btn-sm btn-ghost" onClick={async () => { if (confirm(`Delete "${x.name}"?`)) { try { await del(`${t.base}/scenarios/${x.id}`); if (id === x.id) { setId(null); setName(''); } list.reload(); } catch (e) { setErr((e as Error).message); } } }}>Delete</button>}</div></td></tr>)}</tbody></table></div>
      <p className="muted small">Saved figures are as of the day they were saved. Open one to rerun it on the latest results.</p></Card>}
  </>;
}
