// Annual budget: set once in round numbers during budget season, locked when finalized, then tracked monthly (budget to actual)
// beside an adjustable outlook that shows where the year is now expected to land.
import React, { useEffect, useState } from 'react';
import { del, get, post, put } from './api.ts';
import { useT } from './App.tsx';
import { Card, Empty, ErrorNote, Field, Money, Note, Num, P, Pill, dateLabel, useLoad } from './ui.tsx';
import { fmtMoney, fmtPct } from '../engine/core.ts';
import { AcctRows, ExpandAll, Toggle, sumAcct, useExpand } from './expand.tsx';
import { addMonths } from '../engine/core.ts';
import { BUDGET_ROWS, type BudgetData, type BudgetLine, budgetTotals, roundBudget, spreadAnnual } from '../engine/budget.ts';

const $ = (c: number) => fmtMoney(c, { compact: Math.abs(c) >= 1_000_000_00 });
const tone = (f: boolean | null) => (f === null ? '' : f ? 'good' : 'bad');
const MONTHS = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th', '11th', '12th'];

/** A budget figure in whole dollars. Rounds to the nearest hundred when you leave the box. */
function Cell({ cents, onCommit, label }: { cents: number; onCommit: (c: number) => void; label: string }) {
  const [txt, setTxt] = useState<string | null>(null);
  const commit = () => { if (txt === null) return; const n = Number(txt.replace(/[$,\s]/g, '')); if (txt.trim() !== '' && Number.isFinite(n)) { const v = roundBudget(Math.round(n * 100)); if (v !== cents) onCommit(v); } setTxt(null); };
  return <input className="bcell" inputMode="numeric" aria-label={label} value={txt ?? Math.round(cents / 100).toLocaleString('en-US')} onFocus={(e) => { setTxt(String(Math.round(cents / 100))); requestAnimationFrame(() => e.target.select()); }} onChange={(e) => setTxt(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />;
}

export function BudgetPage() {
  const t = useT(); const ls = useLoad(() => get(`${t.base}/budgets`), [t.tid]); const [fy, setFy] = useState<string | null>(null);
  if (ls.error) return <><h1>Budget</h1><ErrorNote error={ls.error} /></>; if (!ls.data) return <h1>Budget</h1>;
  const cur = fy ?? ls.data.open; const s = ls.data.season;
  return <>
    <div className="page-h"><div><h1>Budget</h1><p className="meta">The plan for the year, set once and kept as it was. Actual results are measured against it every month, and the outlook shows where the year is now heading.</p></div>
      <label className="check">Fiscal year <select value={cur} onChange={(e) => setFy(e.target.value)}>{ls.data.years.map((y: any) => <option key={y.fiscalYear} value={y.fiscalYear}>{y.label}{y.status === 'final' ? ' · finalized' : y.status === 'draft' ? ' · draft' : ' · not started'}</option>)}</select></label></div>
    {s.inSeason && <Note>It is budget season: the last quarter of the fiscal year, when the budget for {ls.data.years.find((y: any) => y.fiscalYear === s.nextFy)?.label} is prepared.</Note>}
    <BudgetYear key={cur} fy={cur} onChanged={ls.reload} />
  </>;
}

function BudgetYear({ fy, onChanged }: { fy: string; onChanged: () => void }) {
  const t = useT(); const [d, setD] = useState<any>(null); const [err, setErr] = useState<string | null>(null); const [msg, setMsg] = useState<string | null>(null); const [tab, setTab] = useState<string | null>(null);
  const load = (q = '') => get(`${t.base}/budgets/${fy}${q}`).then((x) => { setD(x); setErr(null); }).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, [t.tid, fy]);
  if (!d) return <ErrorNote error={err} />;
  if (!d.exists) return <StartBudget d={d} fy={fy} onCreated={(x) => { setD(x); onChanged(); }} />;
  const cur = tab ?? (d.status === 'final' && d.bva ? 'bva' : 'plan'); const done = (x: any, m: string) => { setD(x); setMsg(m); setErr(null); onChanged(); };
  return <>
    <div className="tabs" role="tablist">{[['plan', d.status === 'final' ? 'The budget' : 'Build the budget'], ['bva', 'Budget to actual'], ['outlook', 'Outlook: next 3 and 12 months']].map(([k, l]) => <button key={k} role="tab" aria-selected={cur === k} className={cur === k ? 'on' : ''} onClick={() => { setTab(k); setMsg(null); }}>{l}</button>)}</div>
    <ErrorNote error={err} />{msg && <Note tone="good">{msg}</Note>}
    {cur === 'plan' && <Plan d={d} fy={fy} done={done} fail={setErr} onDeleted={() => { setD(null); load(); onChanged(); }} />}
    {cur === 'bva' && <Bva d={d} reload={(through) => load(`?through=${through}`)} />}
    {cur === 'outlook' && <OutlookTab d={d} reload={() => load()} fail={setErr} />}
  </>;
}

function StartBudget({ d, fy, onCreated }: { d: any; fy: string; onCreated: (x: any) => void }) {
  const t = useT(); const sc = useLoad(() => get(`${t.base}/scenarios`), [t.tid]); const [source, setSource] = useState('history'); const [err, setErr] = useState<string | null>(null);
  const saved = (sc.data?.scenarios ?? []).filter((x: any) => x.type === 'forecast');
  if (!d.canCreate) return <Empty>No budget has been started for {d.label}. Your advisor or the business owner can start one.</Empty>;
  return <Card title={`Start the ${d.label} budget`}>
    <p>The budget starts from the what-if forecast, so you are adjusting a sensible first draft, not filling in a blank sheet. Every figure is rounded to the nearest $100. You then change any line, month by month, and add the specific things you plan to spend on.</p>
    {!d.hasHistory && <Note tone="warn">Fewer than three months of results are available, so the forecast cannot be built. The budget will start blank.</Note>}
    <Field label="Start from"><select value={source} onChange={(e) => setSource(e.target.value)}><option value="history">Carry on as now: last year's pattern, nothing changed</option><option value="outlook">The current outlook your advisor maintains</option>{saved.map((x: any) => <option key={x.id} value={x.id}>Saved what-if: {x.name}</option>)}</select></Field>
    <p className="muted small">Figures are due by {dateLabel(d.defaultDeadline)} unless your advisor sets a different date. After the budget is finalized it cannot be changed.</p>
    <ErrorNote error={err} /><div className="row"><button className="btn btn-primary" onClick={async () => { try { onCreated(await post(`${t.base}/budgets`, { fiscalYear: fy, source })); } catch (e) { setErr((e as Error).message); } }}>Create the first draft</button></div>
  </Card>;
}

function Plan({ d, fy, done, fail, onDeleted }: { d: any; fy: string; done: (x: any, m: string) => void; fail: (m: string) => void; onDeleted: () => void }) {
  const t = useT(); const [data, setData] = useState<BudgetData>(d.data); const [dirty, setDirty] = useState(false); const [deadline, setDeadline] = useState(d.deadline); const ed = d.editable;
  useEffect(() => { setData(d.data); setDirty(false); setDeadline(d.deadline); }, [d]);
  const change = (next: BudgetData) => { setData(next); setDirty(true); }; const tot = budgetTotals(data, d.settings);
  const setCell = (k: BudgetLine, i: number, v: number) => change({ ...data, base: { ...data.base, [k]: data.base[k].map((x, j) => (j === i ? v : x)) } });
  const baseTotal = (k: BudgetLine) => data.base[k].reduce((a, b) => a + b, 0); const itemTotal = (k: string) => data.items.filter((x) => x.line === k).reduce((a, x) => a + x.monthlyCents * (x.toMonth - x.fromMonth + 1), 0);
  const save = async () => { try { done(await put(`${t.base}/budgets/${fy}`, { data }), 'Budget saved.'); return true; } catch (e) { fail((e as Error).message); return false; } };
  const finalize = async () => { if (!confirm(`Finalize the ${d.label} budget? It will be locked permanently as the record of what was planned. This cannot be undone.`)) return; if (dirty && !(await save())) return; try { done(await post(`${t.base}/budgets/${fy}/finalize`), 'Budget finalized and locked.'); } catch (e) { fail((e as Error).message); } };
  const ex = useExpand(); const XK = BUDGET_ROWS.filter((r) => r.kind !== 'subtotal' && r.key !== 'owner_adj').map((r) => r.key); const lastYear = d.periods.map((p: string) => addMonths(p, -12));
  const lineOpts = BUDGET_ROWS.filter((r) => r.kind !== 'subtotal'); const hideOwner = !ed && tot.year.owner_adj === 0;
  return <>
    <Card title={`${d.label} budget`} right={<><ExpandAll ex={ex} keys={XK} /> <Pill tone={d.status === 'final' ? 'good' : d.pastDeadline ? 'warn' : 'info'}>{d.status === 'final' ? 'Finalized · locked' : d.pastDeadline ? 'Draft · past deadline' : 'Draft'}</Pill></>}>
      {d.status === 'final' ? <p className="meta">Finalized by <b>{d.finalizedBy}</b> on {dateLabel(d.finalizedAt.slice(0, 10))}. It stays as it was, to show what was planned with what was known then. Changes in expectations go in the outlook.</p>
        : <p className="meta">Figures due by <b>{dateLabel(d.deadline)}</b>. {ed ? 'Type over any figure; it rounds to the nearest $100. Change a line\'s total to re-spread it over the months in the same pattern.' : d.pastDeadline ? 'The deadline has passed, so figures are closed to changes. Ask your advisor if it needs extending.' : 'You can view this draft.'}</p>}
      {d.seededFrom && <p className="muted small">First draft: {d.seededFrom.source}{d.seededFrom.basedOnMonthsThrough ? `, on results through ${P(d.seededFrom.basedOnMonthsThrough)}` : ''}{d.seededFrom.actualMonthsUsed ? `; ${d.seededFrom.actualMonthsUsed} month(s) already closed started from actuals` : ''}. Last changed by {d.updatedBy ?? d.createdBy} on {dateLabel(d.updatedAt.slice(0, 10))}.</p>}
      <div className="tbl-wrap"><table className="tbl pnl r12 budget"><thead><tr><th>Line</th>{d.periods.map((p: string) => <th key={p} className="num">{P(p)}</th>)}<th className="num">Base, year</th><th className="num">Planned items</th><th className="num">Budget</th></tr></thead><tbody>
        {BUDGET_ROWS.map((r) => { if (hideOwner && (r.key === 'owner_adj' || r.key === 'true_pretax')) return null; const sub = r.kind === 'subtotal'; const k = r.key as BudgetLine;
          return <React.Fragment key={r.key}><tr className={sub ? 'tot' : ''}><td>{sub ? <b>{r.label}</b> : XK.includes(r.key) ? <Toggle ex={ex} k={r.key}>{r.label}</Toggle> : r.label}</td>
            {d.periods.map((p: string, i: number) => <td key={p} className="num">{sub ? <b>{$(tot.months[i][r.key])}</b> : ed ? <Cell cents={data.base[k][i]} label={`${r.label}, ${P(p)}`} onCommit={(v) => setCell(k, i, v)} /> : $(data.base[k][i])}</td>)}
            <td className="num">{sub ? '' : ed ? <Cell cents={baseTotal(k)} label={`${r.label}, year`} onCommit={(v) => change({ ...data, base: { ...data.base, [k]: spreadAnnual(data.base[k], v) } })} /> : $(baseTotal(k))}</td>
            <td className="num muted">{sub || !itemTotal(r.key) ? '' : $(itemTotal(r.key))}</td><td className="num"><b>{$(tot.year[r.key])}</b></td></tr>
            {!sub && <AcctRows ex={ex} k={r.key} span={15} cells={(a) => <>{lastYear.map((p: string) => <td key={p} className="num">{a.byMonth[p] === undefined ? '—' : $(a.byMonth[p])}</td>)}<td className="num">{$(sumAcct(a, lastYear))}</td><td></td><td></td></>} />}</React.Fragment>; })}
        <tr className="sub-row"><td>True pretax profit as % of revenue</td>{d.periods.map((p: string, i: number) => <td key={p} className="num">{tot.months[i].revenue ? fmtPct(tot.months[i].true_pretax / tot.months[i].revenue) : ''}</td>)}<td></td><td></td><td className="num">{tot.year.revenue ? fmtPct(tot.year.true_pretax / tot.year.revenue) : ''}</td></tr>
      </tbody></table></div>
      <p className="muted small">Select a line to see the accounts inside it with what each actually ran in the same month a year earlier. The budget itself is set at the line. Target: {fmtPct(d.settings.pretaxTargetPct, 0)} true pretax profit. All figures are in whole hundreds of dollars.{hideOwner ? '' : ' True pretax profit is after paying the owner a market wage.'}</p>
    </Card>
    <Card title="What we are planning for this year">
      <p className="meta">Specific things expected next year that the first draft does not know about: a hire, a lease, a price change, a new contract. Each is added on top of the base figures, so the reasoning stays visible later.</p>
      {data.items.length === 0 && !ed && <p className="muted">No planned items were recorded.</p>}
      {data.items.length > 0 && <div className="tbl-wrap"><table className="tbl"><thead><tr><th>What</th><th>Budget line</th><th className="num">Per month</th><th>From</th><th>Through</th><th className="num">For the year</th>{ed && <th></th>}</tr></thead><tbody>
        {data.items.map((x, n) => { const up = (p: any) => change({ ...data, items: data.items.map((y, j) => (j === n ? { ...y, ...p } : y)) });
          return <tr key={x.id}><td>{ed ? <input aria-label="Description" value={x.description} maxLength={200} onChange={(e) => up({ description: e.target.value })} /> : x.description}</td>
            <td>{ed ? <select aria-label="Budget line" value={x.line} onChange={(e) => up({ line: e.target.value })}>{lineOpts.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}</select> : BUDGET_ROWS.find((r) => r.key === x.line)?.label}</td>
            <td className="num">{ed ? <Cell cents={x.monthlyCents} label="Amount per month" onCommit={(v) => up({ monthlyCents: v })} /> : $(x.monthlyCents)}</td>
            <td>{ed ? <select aria-label="From month" value={x.fromMonth} onChange={(e) => up({ fromMonth: Number(e.target.value), toMonth: Math.max(x.toMonth, Number(e.target.value)) })}>{d.periods.map((p: string, i: number) => <option key={p} value={i}>{P(p)}</option>)}</select> : P(d.periods[x.fromMonth])}</td>
            <td>{ed ? <select aria-label="Through month" value={x.toMonth} onChange={(e) => up({ toMonth: Math.max(x.fromMonth, Number(e.target.value)) })}>{d.periods.map((p: string, i: number) => <option key={p} value={i} disabled={i < x.fromMonth}>{P(p)}</option>)}</select> : P(d.periods[x.toMonth])}</td>
            <td className="num">{$(x.monthlyCents * (x.toMonth - x.fromMonth + 1))}</td>{ed && <td><button className="btn btn-sm btn-ghost" onClick={() => change({ ...data, items: data.items.filter((_, j) => j !== n) })}>Remove</button></td>}</tr>; })}</tbody></table></div>}
      {ed && <div className="row"><button className="btn btn-sm" onClick={() => change({ ...data, items: [...data.items, { id: `i${Date.now().toString(36)}`, line: 'other_opex', description: 'New planned item', monthlyCents: 0, fromMonth: 0, toMonth: 11 }] })}>Add a planned item</button></div>}
      <p className="muted small">Use a minus for something that reduces a line, such as a cost you expect to drop.</p>
    </Card>
    {(ed || d.canFinalize) && <Card title="Save, deadline and sign-off" className="no-print">
      <div className="row wrap">{ed && <button className="btn btn-primary" disabled={!dirty} onClick={save}>{dirty ? 'Save changes' : 'Saved'}</button>}
        {d.canSetDeadline && <><label className="check">Figures due by <input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} /></label><button className="btn" disabled={deadline === d.deadline} onClick={async () => { try { done(await put(`${t.base}/budgets/${fy}/deadline`, { deadline }), 'Deadline updated.'); } catch (e) { fail((e as Error).message); } }}>Set deadline</button></>}
        {d.canFinalize && <button className="btn" onClick={finalize}>Finalize and lock</button>}
        {d.canFinalize && <button className="btn btn-ghost" onClick={async () => { if (confirm('Delete this draft and start again?')) { try { await del(`${t.base}/budgets/${fy}`); onDeleted(); } catch (e) { fail((e as Error).message); } } }}>Delete draft</button>}</div>
      <p className="muted small">{d.canFinalize ? 'The business enters figures until the deadline; you can adjust them until you finalize. Move the deadline to give departments more time. Finalizing is permanent.' : 'You can change figures until the deadline. Your advisor finalizes the budget, after which it is locked.'}</p>
    </Card>}
  </>;
}

function Bva({ d, reload }: { d: any; reload: (through: string) => void }) {
  const b = d.bva;
  if (d.status !== 'final') return <Empty>Budget to actual starts once this budget is finalized. Until then the figures can still change, so there is nothing fixed to measure against.</Empty>;
  if (!b) return <Empty>No results for {d.label} have been {d.canFinalize ? 'imported' : 'approved'} yet. Budget to actual appears with the first month.</Empty>;
  const ex = useExpand(); const XK = BUDGET_ROWS.filter((r) => r.kind !== 'subtotal' && r.key !== 'owner_adj').map((r) => r.key); const ytdP = d.periods.filter((p: string) => p <= b.through);
  const opts = d.periods.filter((p: string) => d.lastActual && p <= d.lastActual); const cols = (c: any) => <><td className="num">{$(c.actual)}</td><td className="num">{$(c.budget)}</td><td className={`num ${tone(c.favorable)}`}>{$(c.variance)}</td></>;
  return <>
    <Card title="Why actual differs from the plan" right={<label className="check no-print">Through <select value={b.through} onChange={(e) => reload(e.target.value)}>{opts.map((p: string) => <option key={p} value={p}>{P(p)}</option>)}</select></label>}>
      <p><b>{b.headline}</b></p>
      {b.drivers.length ? <ul className="plain">{b.drivers.map((x: string) => <li key={x}>{x}</li>)}</ul> : <p className="muted">No line is far enough from budget to call out.</p>}
      <p className="muted small">A variance says where to look, not what happened. Open Profit &amp; Performance, Rolling 12 &amp; 3, and select a line to see the accounts behind it.</p>
    </Card>
    <Card title={`Budget to actual · ${P(b.through)} and year to date`} right={<ExpandAll ex={ex} keys={XK} />}>
      <div className="tbl-wrap"><table className="tbl pnl"><thead><tr><th rowSpan={2}>Line</th><th colSpan={3} className="num">{P(b.through)}</th><th colSpan={4} className="num">Year to date ({b.monthsElapsed} month{b.monthsElapsed === 1 ? '' : 's'})</th><th rowSpan={2} className="num">Full-year budget</th></tr>
        <tr><th className="num">Actual</th><th className="num">Budget</th><th className="num">Difference</th><th className="num">Actual</th><th className="num">Budget</th><th className="num">Difference</th><th className="num">%</th></tr></thead><tbody>
        {b.rows.filter((r: any) => !(r.key === 'owner_adj' && !r.ytd.actual && !r.fullYearBudget)).map((r: any) => <React.Fragment key={r.key}><tr className={r.kind === 'subtotal' ? 'tot' : ''}><td>{r.kind === 'subtotal' ? <b>{r.label}</b> : XK.includes(r.key) ? <Toggle ex={ex} k={r.key}>{r.label}</Toggle> : r.label}{r.drifting && <> <Pill tone="warn">Drifting</Pill></>}</td>
          {cols(r.month)}{cols(r.ytd)}<td className={`num ${tone(r.ytd.favorable)}`}>{r.ytd.pct.value === null ? '' : fmtPct(r.ytd.pct.value)}</td><td className="num muted">{$(r.fullYearBudget)}</td></tr>
          <AcctRows ex={ex} k={r.key} span={8} cells={(a) => <><td className="num">{$(a.byMonth[b.through] ?? 0)}</td><td></td><td></td><td className="num">{$(sumAcct(a, ytdP))}</td><td></td><td></td><td></td><td></td></>} /></React.Fragment>)}</tbody></table></div>
      <p className="muted small">Select a line to see the actual accounts inside it; the budget is set at the line, so accounts show actuals only. Difference is actual less budget. Green helps profit and red hurts it: for revenue, more is green; for costs, less is green. "Drifting" marks a line that has moved further from budget in each of the last three months. Year to date counts only months that have actual results.</p>
    </Card>
  </>;
}

function OutlookTab({ d, reload, fail }: { d: any; reload: () => void; fail: (m: string) => void }) {
  const t = useT(); const o = d.outlook; const ol = d.outlookLevers; const [lv, setLv] = useState<any>(ol.levers); const [note, setNote] = useState<string>(ol.note); const [saved, setSaved] = useState(false);
  useEffect(() => { setLv(ol.levers); setNote(ol.note); }, [d]);
  if (!o) return <Empty>The outlook needs at least three months of results.</Empty>;
  const set = (p: any) => { const n = { ...lv, ...p }; for (const k of Object.keys(n)) if (n[k] === null || n[k] === undefined) delete n[k]; setLv(n); setSaved(false); };
  const H = ({ h, title }: { h: any; title: string }) => <div><span>{title}</span><b>{h ? $(h.truePretax) : 'N/A'}</b><small>{h ? `True pretax profit on ${$(h.revenue)} of sales (${h.truePretaxPct.value === null ? 'n/a' : fmtPct(h.truePretaxPct.value)}) · ${P(h.from)} – ${P(h.to)}` : 'Needs more history'}</small></div>;
  const tp = o.rows.find((r: any) => r.key === 'true_pretax');
  return <>
    <Card title="Where things are heading now" right={<Pill tone="warn">Forecast — not actuals</Pill>}>
      <p><b>{o.headline}</b></p>
      <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}><H h={o.next3} title="Next 3 months" /><H h={o.next12} title="Next 12 months" />
        <div><span>{d.label} projected</span><b>{$(tp.projected)}</b><small className={tone(tp.favorable)}>{tp.variance === 0 ? 'On budget' : `${$(Math.abs(tp.variance))} ${tp.variance > 0 ? 'above' : 'below'} the budget of ${$(tp.budget)}`}</small></div></div>
      <p className="muted small">The budget does not move. The outlook does: it is rebuilt from the latest results every month, and your advisor adjusts it as plans change, so this is the current best estimate.{ol.custom ? ` Last adjusted by ${ol.updatedBy ?? 'your advisor'} on ${dateLabel(ol.updatedAt.slice(0, 10))}.` : ' It currently assumes the business carries on as it has been.'}</p>
      {ol.note && <Note>{ol.note}</Note>}
    </Card>
    <Card title={`${d.label}: budget against the projected year`}>
      <div className="tbl-wrap"><table className="tbl pnl"><thead><tr><th>Line</th><th className="num">Actual so far ({o.actualMonths} mo.)</th><th className="num">Forecast for the rest ({o.forecastMonths} mo.)</th><th className="num">Projected year</th><th className="num">Budget</th><th className="num">Difference</th></tr></thead><tbody>
        {o.rows.filter((r: any) => !(r.key === 'owner_adj' && !r.projected && !r.budget)).map((r: any) => <tr key={r.key} className={r.kind === 'subtotal' ? 'tot' : ''}><td>{r.kind === 'subtotal' ? <b>{r.label}</b> : r.label}</td><td className="num">{$(r.actualYtd)}</td><td className="num">{$(r.forecastRest)}</td><td className="num"><b>{$(r.projected)}</b></td><td className="num">{$(r.budget)}</td><td className={`num ${tone(r.favorable)}`}>{$(r.variance)}</td></tr>)}</tbody></table></div>
      {o.uncoveredMonths.length > 0 && <Note tone="warn">{o.uncoveredMonths.length} month(s) of this budget year are beyond what the forecast covers yet, so the projected year is incomplete.</Note>}
    </Card>
    {d.canEditOutlook && <Card title="Adjust the outlook" className="no-print">
      <p className="meta">Change these as the year unfolds. They apply to every forecast month from here on. Leave a box empty to follow the business's own history.</p>
      <div className="form-grid">
        <Field label="Sales compared with last year"><Num pct nullable value={lv.salesChangePct ?? null} onChange={(x) => set({ salesChangePct: x })} min={-90} max={300} step={1} /></Field>
        <Field label="Gross profit on each sales dollar" hint="Before labor."><Num pct nullable value={lv.grossProfitPct ?? null} onChange={(x) => set({ grossProfitPct: x })} min={0} max={100} step={0.5} /></Field>
        <Field label="Payroll added or cut, per month"><Money nullable value={lv.payrollChangeMonthlyCents ?? null} onChange={(x) => set({ payrollChangeMonthlyCents: x })} /></Field>
        <Field label="Other expenses added or cut, per month"><Money nullable value={lv.overheadChangeMonthlyCents ?? null} onChange={(x) => set({ overheadChangeMonthlyCents: x })} /></Field>
      </div>
      <Field label="What changed, in a sentence" hint="Shown to the client beside the outlook."><textarea rows={2} maxLength={1000} value={note} onChange={(e) => { setNote(e.target.value); setSaved(false); }} /></Field>
      <div className="row"><button className="btn btn-primary" onClick={async () => { try { await put(`${t.base}/outlook`, { levers: lv, note }); setSaved(true); reload(); } catch (e) { fail((e as Error).message); } }}>{saved ? 'Saved' : 'Save outlook'}</button><button className="btn btn-ghost" onClick={() => { setLv({}); setNote(''); setSaved(false); }}>Clear adjustments</button></div>
    </Card>}
  </>;
}
