// Decision Lab (hiring scenarios, contractor vs employee, comparison) and Profit Planner.
// Results are recomputed in the browser with the same engine the server uses, so every change shows instantly.
// The server recomputes from the saved inputs on save; its figures are the ones stored.
import { WhatIfForecast } from './whatif.tsx';
import React, { useEffect, useMemo, useState } from 'react';
import { del, get, post, put } from './api.ts';
import { useT } from './App.tsx';
import { Async, Card, Drawer, Empty, ErrorNote, Field, Money, Note, Num, P, Pill, Slider, StatusPill, Term, dateLabel, fmt, useLoad } from './ui.tsx';
import { C, Chart } from './charts.tsx';
import { type MonthData, type Settings, addMonths, fmtMoney, fmtPct, fmtRatio, rolling12 } from '../engine/core.ts';
import { type HiringBaseline, type HiringInputs, type WorkerType, costOfHire, defaultHiringInputs, evaluateHire } from '../engine/hiring.ts';
import { profitPlan, type ProfitNeedsInput } from '../engine/profitplan.ts';

const WORKER: Record<WorkerType, string> = { salaried: 'Salaried employee', hourly: 'Hourly employee', contractor_fixed: 'Fixed-fee contractor', contractor_hourly: 'Hourly contractor' };
const METRICS: [string, string, string][] = [['revenue', 'Revenue (12 mo)', 'money'], ['grossProfit', 'Gross profit (12 mo)', 'money'], ['pretax', 'Pretax profit (12 mo)', 'money'], ['marginPct', 'Profit margin (adjusted)', 'pct'], ['endCash', 'Cash balance after 12 mo', 'money'], ['minCash', 'Minimum forecast cash', 'money'], ['dLER', 'Direct labor efficiency', 'ratio'], ['tLER', 'Total labor efficiency', 'ratio'], ['investment', 'Required first-year investment', 'money'], ['breakEven', 'Break-even month', 'period']];

export function DecisionLab() {
  const t = useT(); const list = useLoad(() => get(`${t.base}/scenarios`), [t.tid]); const [open, setOpen] = useState<string | null>(t.sub); const [picked, setPicked] = useState<string[]>([]);
  if (open) return <HiringEditor id={open === 'new' ? null : open} onClose={() => { setOpen(null); list.reload(); }} onOpen={setOpen} />;
  return <Async r={list}>{(d) => { const hires = d.scenarios.filter((s: any) => s.type === 'hiring'); const cmp = hires.filter((s: any) => picked.includes(s.id) && s.summary);
    return <>
      <div className="page-h"><div><h1>Decision Lab</h1><p className="meta">Change an assumption and see what it does to profit, cash, labor efficiency and reserves — before you commit.</p></div>
        <div className="controls">{t.can('scenario_write') && <button className="btn btn-primary" onClick={() => setOpen('new')}>New hiring scenario</button>}</div></div>
      <WhatIfForecast />
      <h2>Can we afford another employee?</h2>
      <Note>A hiring scenario works through one specific hire in detail: pay, timing, ramp-up and what it does to labor efficiency and cash. Like the what-if forecast, it never changes your accounting records.</Note>
      <Card title="Saved hiring scenarios">{hires.length ? <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Compare</th><th>Scenario</th><th>Status</th><th className="num">Profit impact (12 mo)</th><th className="num">Minimum cash</th><th>Created by</th><th>Updated</th><th></th></tr></thead><tbody>
        {hires.map((s: any) => <tr key={s.id}><td><input type="checkbox" aria-label={`Compare ${s.name}`} checked={picked.includes(s.id)} disabled={!picked.includes(s.id) && picked.length >= 4} onChange={(e) => setPicked(e.target.checked ? [...picked, s.id] : picked.filter((x) => x !== s.id))} /></td>
          <td><b>{s.name}</b></td><td><StatusPill status={s.status} /></td><td className="num">{s.summary ? fmtMoney(s.summary.pretax - s.summary.baseline.pretax) : '—'}</td><td className="num">{s.summary ? fmtMoney(s.summary.minCash) : '—'}</td><td>{s.created_by}</td><td>{dateLabel(s.updated_at)}</td><td><button className="btn btn-sm" onClick={() => setOpen(s.id)}>Open</button></td></tr>)}</tbody></table></div>
        : <Empty>No hiring scenarios yet.</Empty>}</Card>
      {cmp.length > 0 && <Card title="Side-by-side comparison"><div className="tbl-wrap"><table className="tbl"><thead><tr><th></th><th className="num">Baseline (no change)</th>{cmp.map((s: any) => <th key={s.id} className="num">{s.name}</th>)}</tr></thead><tbody>
        {METRICS.map(([k, label, kind]) => <tr key={k}><td>{label}</td><td className="num">{k === 'investment' ? fmtMoney(0) : k === 'breakEven' ? '—' : fmt(cmp[0].summary.baseline[k], kind)}</td>{cmp.map((s: any) => <td key={s.id} className="num">{kind === 'period' ? (s.summary[k] ? P(s.summary[k]) : 'Not within forecast') : fmt(s.summary[k], kind)}</td>)}</tr>)}</tbody></table></div>
        <Chart title="Minimum forecast cash vs pretax profit — a scenario can be profitable and still strain cash" labels={['Baseline', ...cmp.map((s: any) => s.name)]} kind="money" bars series={[{ name: 'Pretax profit (12 mo)', values: [cmp[0].summary.baseline.pretax, ...cmp.map((s: any) => s.summary.pretax)], color: C.s1 }, { name: 'Minimum forecast cash', values: [cmp[0].summary.baseline.minCash, ...cmp.map((s: any) => s.summary.minCash)], color: C.s3 }]} /></Card>}
      {hires.length > 0 && cmp.length === 0 && <p className="muted">Tick up to four scenarios to compare them side by side with the baseline.</p>}
    </>; }}</Async>;
}

function HiringEditor({ id, onClose, onOpen }: { id: string | null; onClose: () => void; onOpen: (id: string) => void }) {
  const t = useT(); const base = useLoad(() => get<{ baseline: HiringBaseline; settings: Settings }>(`${t.base}/scenarios/baseline`), [t.tid]);
  const saved = useLoad(() => (id ? get(`${t.base}/scenarios/${id}`) : Promise.resolve(null)), [id]);
  const [inp, setInp] = useState<HiringInputs | null>(null); const [name, setName] = useState('New hire'); const [err, setErr] = useState<string | null>(null); const [msg, setMsg] = useState<string | null>(null); const [dirty, setDirty] = useState(false); const [showTax, setShowTax] = useState(false); const [comment, setComment] = useState('');
  useEffect(() => { if (base.data && !inp) { if (id && saved.data) { setInp(saved.data.inputs); setName(saved.data.name); } else if (!id) setInp(defaultHiringInputs(addMonths(base.data.baseline.asOf, 2))); } }, [base.data, saved.data]);
  const res = useMemo(() => (inp && base.data ? evaluateHire(inp, base.data.baseline, base.data.settings) : null), [inp, base.data]);
  if (base.error) return <><button className="btn btn-ghost" onClick={onClose}>← Decision Lab</button><ErrorNote error={base.error} /></>;
  if (!inp || !res || !base.data) return <div className="loading">Loading…</div>;
  const s = base.data.settings; const b = base.data.baseline; const set = (p: Partial<HiringInputs>) => { setInp({ ...inp, ...p }); setDirty(true); setMsg(null); };
  const status = saved.data?.status ?? 'draft'; const locked = status === 'approved' || (!!id && !t.tenant.isStaff && saved.data && !saved.data.mine); const canWrite = t.can('scenario_write') && !locked;
  const emp = inp.workerType === 'salaried' || inp.workerType === 'hourly';
  const save = async () => { setErr(null); try { const x = id ? await put(`${t.base}/scenarios/${id}`, { name, inputs: inp }) : await post(`${t.base}/scenarios`, { type: 'hiring', name, inputs: inp }); setDirty(false); setMsg('Scenario saved.'); if (!id) onOpen(x.id); else saved.reload(); } catch (e) { setErr((e as Error).message); } };
  const setStatus = async (st: string) => { setErr(null); try { await post(`${t.base}/scenarios/${id}/status`, { status: st }); saved.reload(); setMsg({ shared: 'Shared with your advisor.', approval_requested: 'Approval requested from your advisor.', approved: 'Scenario approved.', declined: 'Scenario declined.', draft: 'Returned to draft.' }[st] ?? 'Updated.'); } catch (e) { setErr((e as Error).message); } };
  const tl = res.timeline.slice(0, 18); const lab = tl.map((m) => P(m.period));
  const months = Array.from({ length: 13 }, (_, k) => addMonths(b.asOf, k + 1));
  const alt = (Object.keys(WORKER) as WorkerType[]).map((w) => ({ w, c: costOfHire({ ...inp, workerType: w }) }));
  return <div className="lab">
    <div className="page-h"><div><button className="btn btn-ghost" onClick={onClose}>← Decision Lab</button><h1><input className="title-inp" aria-label="Scenario name" value={name} disabled={!canWrite} onChange={(e) => { setName(e.target.value); setDirty(true); }} /></h1>
      <p className="meta">Hiring scenario · baseline: forecast from actuals through <b>{P(b.asOf)}</b> · <StatusPill status={id ? status : 'draft'} />{dirty && <> · <Pill tone="warn">Unsaved changes</Pill></>}</p></div>
      <div className="controls">{canWrite && <button className="btn btn-primary" onClick={save}>{id ? 'Save' : 'Save scenario'}</button>}
        {id && t.can('scenario_write') && <button className="btn" onClick={async () => { const x = await post(`${t.base}/scenarios/${id}/duplicate`); onOpen(x.id); setInp(null); }}>Duplicate</button>}
        {canWrite && <button className="btn" onClick={() => { setInp(defaultHiringInputs(addMonths(b.asOf, 2))); setDirty(true); }}>Reset to baseline</button>}
        {id && canWrite && saved.data?.mine && status === 'draft' && <button className="btn" onClick={() => setStatus('shared')}>Share with CFO</button>}
        {id && canWrite && saved.data?.mine && ['draft', 'shared'].includes(status) && <button className="btn" onClick={() => setStatus('approval_requested')}>Request approval</button>}
        {id && t.can('scenario_approve') && status !== 'approved' && <button className="btn" onClick={() => setStatus('approved')}>Approve</button>}{id && t.can('scenario_approve') && status === 'approval_requested' && <button className="btn" onClick={() => setStatus('declined')}>Decline</button>}
        {id && canWrite && <button className="btn btn-ghost" onClick={async () => { if (confirm('Delete this scenario?')) { await del(`${t.base}/scenarios/${id}`); onClose(); } }}>Delete</button>}</div></div>
    <ErrorNote error={err} />{msg && <Note tone="good">{msg}</Note>}{locked && <Note tone="warn">{status === 'approved' ? 'This scenario is approved and locked.' : 'This scenario belongs to someone else.'} Duplicate it to explore changes.</Note>}
    <div className="lab-grid">
      <fieldset className="card inputs" disabled={!canWrite}><legend>Your assumptions <span className="muted">— editable</span></legend>
        <Field label="Position title"><input value={inp.title} onChange={(e) => set({ title: e.target.value })} /></Field>
        <div className="form-grid">
          <Field label="Proposed start"><select value={inp.startPeriod} onChange={(e) => set({ startPeriod: e.target.value })}>{months.map((m) => <option key={m} value={m}>{P(m)}</option>)}</select></Field>
          <Field label="Type of worker"><select value={inp.workerType} onChange={(e) => set({ workerType: e.target.value as WorkerType })}>{(Object.keys(WORKER) as WorkerType[]).map((w) => <option key={w} value={w}>{WORKER[w]}</option>)}</select></Field>
          <Field label="Role"><select value={inp.roleType} onChange={(e) => set({ roleType: e.target.value as 'direct' | 'management' })}><option value="direct">Does the work (direct labor)</option><option value="management">Management / admin</option></select></Field>
          <Field label="Adding or replacing?"><select value={inp.replacing ? 'r' : 'a'} onChange={(e) => set({ replacing: e.target.value === 'r' })}><option value="a">Adding capacity</option><option value="r">Replacing someone</option></select></Field>
        </div>
        {inp.replacing && <Field label="Monthly cost of the person being replaced"><Money value={inp.replacedMonthlyCostCents} onChange={(v) => set({ replacedMonthlyCostCents: v ?? 0 })} /></Field>}
        <h4>Compensation</h4>
        {inp.workerType === 'salaried' && <Field label="Annual salary"><Money value={inp.annualSalaryCents} onChange={(v) => set({ annualSalaryCents: v ?? 0 })} /><Slider value={inp.annualSalaryCents} min={2_500_000} max={20_000_000} step={100_000} onChange={(v) => set({ annualSalaryCents: v })} format={(v) => fmtMoney(v)} /></Field>}
        {(inp.workerType === 'hourly' || inp.workerType === 'contractor_hourly') && <div className="form-grid"><Field label="Hourly rate"><Money value={inp.hourlyRateCents} onChange={(v) => set({ hourlyRateCents: v ?? 0 })} /></Field><Field label="Hours per week" hint={inp.hoursPerWeek >= 35 ? 'Full-time' : 'Part-time'}><Num value={inp.hoursPerWeek} onChange={(v) => set({ hoursPerWeek: v ?? 0 })} min={0} max={80} /></Field>
          {inp.workerType === 'hourly' && <><Field label="Overtime hours per week"><Num value={inp.overtimeHoursPerWeek} onChange={(v) => set({ overtimeHoursPerWeek: v ?? 0 })} min={0} max={40} /></Field><Field label="Overtime multiplier"><Num value={inp.overtimeMultiplier} onChange={(v) => set({ overtimeMultiplier: v ?? 1.5 })} step={0.1} min={1} max={3} suffix="x" /></Field></>}</div>}
        {inp.workerType === 'contractor_fixed' && <Field label="Monthly fee"><Money value={inp.contractMonthlyFeeCents} onChange={(v) => set({ contractMonthlyFeeCents: v ?? 0 })} /></Field>}
        {inp.workerType === 'salaried' && <Field label="Hours per week" hint={inp.hoursPerWeek >= 35 ? 'Full-time' : 'Part-time'}><Num value={inp.hoursPerWeek} onChange={(v) => set({ hoursPerWeek: v ?? 0 })} min={0} max={80} /></Field>}
        {emp && <><h4>Employer taxes and benefits</h4>
          <Note tone="warn">Tax rates and wage bases are planning assumptions. They change every year and vary by state — confirm them with your payroll provider.</Note>
          <button type="button" className="btn btn-sm" onClick={() => setShowTax(!showTax)} aria-expanded={showTax}>{showTax ? 'Hide' : 'Review'} payroll tax assumptions ({fmtPct(res.cost.annualWagesCents ? res.cost.annualTaxesCents / res.cost.annualWagesCents : 0)} of pay)</button>
          {showTax && <table className="tbl"><thead><tr><th>Tax</th><th className="num">Rate</th><th className="num">Wage base</th></tr></thead><tbody>{inp.taxes.map((x, i) => <tr key={i}><td>{x.name}</td><td className="num"><Num pct step={0.05} value={x.rate} onChange={(v) => set({ taxes: inp.taxes.map((y, j) => (j === i ? { ...y, rate: v ?? 0 } : y)) })} /></td><td className="num"><Money nullable placeholder="no limit" value={x.wageBaseCents} onChange={(v) => set({ taxes: inp.taxes.map((y, j) => (j === i ? { ...y, wageBaseCents: v } : y)) })} /></td></tr>)}</tbody></table>}
          <div className="form-grid"><Field label="Workers' compensation"><Num pct step={0.25} value={inp.workersCompPct} onChange={(v) => set({ workersCompPct: v ?? 0 })} /></Field><Field label="Health benefits per month"><Money value={inp.healthMonthlyCents} onChange={(v) => set({ healthMonthlyCents: v ?? 0 })} /></Field><Field label="Retirement match"><Num pct value={inp.retirementMatchPct} onChange={(v) => set({ retirementMatchPct: v ?? 0 })} /></Field><Field label="Other benefits per month"><Money value={inp.otherBenefitsMonthlyCents} onChange={(v) => set({ otherBenefitsMonthlyCents: v ?? 0 })} /></Field>
            <Field label="PTO days per year"><Num value={inp.ptoDays} onChange={(v) => set({ ptoDays: v ?? 0 })} min={0} /></Field><Field label="Paid holidays"><Num value={inp.paidHolidays} onChange={(v) => set({ paidHolidays: v ?? 0 })} min={0} /></Field></div></>}
        <h4>Tools and one-time costs</h4>
        <div className="form-grid"><Field label="Software per month"><Money value={inp.softwareMonthlyCents} onChange={(v) => set({ softwareMonthlyCents: v ?? 0 })} /></Field><Field label="Equipment (one time)"><Money value={inp.equipmentOneTimeCents} onChange={(v) => set({ equipmentOneTimeCents: v ?? 0 })} /></Field><Field label="Recruiting (one time)"><Money value={inp.recruitingOneTimeCents} onChange={(v) => set({ recruitingOneTimeCents: v ?? 0 })} /></Field><Field label="Onboarding (one time)"><Money value={inp.onboardingOneTimeCents} onChange={(v) => set({ onboardingOneTimeCents: v ?? 0 })} /></Field></div>
        <h4>What the role brings in</h4>
        <Field label="Expected additional revenue per month, once fully productive"><Money value={inp.expectedMonthlyRevenueCents} onChange={(v) => set({ expectedMonthlyRevenueCents: v ?? 0 })} /><Slider value={inp.expectedMonthlyRevenueCents} min={0} max={6_000_000} step={50_000} onChange={(v) => set({ expectedMonthlyRevenueCents: v })} format={(v) => fmtMoney(v)} /></Field>
        <div className="form-grid"><Field label="Gross margin on that revenue" hint={inp.grossMarginPct === null ? `Using your forecast margin (${fmtPct(res.marginUsed)})` : 'Entered'}><Num pct nullable value={inp.grossMarginPct} onChange={(v) => set({ grossMarginPct: v })} min={0} max={100} /></Field><Field label="Bill rate per hour (optional)"><Money nullable value={inp.billRateCents} onChange={(v) => set({ billRateCents: v })} /></Field>
          <Field label="Training period" hint="No revenue yet"><Num value={inp.trainingMonths} onChange={(v) => set({ trainingMonths: Math.round(v ?? 0) })} min={0} max={12} suffix="mo" /></Field><Field label="Ramp-up to full productivity"><Num value={inp.rampMonths} onChange={(v) => set({ rampMonths: Math.round(v ?? 0) })} min={0} max={24} suffix="mo" /></Field></div>
        <h4>Your guardrail</h4>
        <Field label="Do not let cash fall below" hint={inp.guardrailMinCashCents === null ? `Using your core capital target (${fmtMoney(b.coreCapitalTargetCents)})` : 'Your own limit'}><Money nullable placeholder="core capital target" value={inp.guardrailMinCashCents} onChange={(v) => set({ guardrailMinCashCents: v })} /></Field>
      </fieldset>
      <div className="results">
        <Card className="calc" title={<>Decision summary <span className="muted">— calculated</span></>}>
          <p className="summary">{res.decisionSummary}</p>
          {res.guardrailBreached === true && <Note tone="bad">With a {P(inp.startPeriod)} start, projected cash falls to {fmtMoney(res.scenario.minCash)} — below your {fmtMoney(res.guardrailCents)} guardrail. {res.earliestSupportableStart ? `The earliest start that stays above it is ${P(res.earliestSupportableStart)}.` : res.earliestNote} The hire lowers the low point by {fmtMoney((res.baseline.minCash ?? 0) - (res.scenario.minCash ?? 0))}.</Note>}
          {res.guardrailBreached === false && <Note tone="good">Projected cash stays above your {fmtMoney(res.guardrailCents)} guardrail. Earliest financially supportable start: <b>{res.earliestSupportableStart ? P(res.earliestSupportableStart) : 'none in the forecast window'}</b>.</Note>}
          {res.guardrailBreached === null && <Note tone="warn">{res.earliestNote}</Note>}
          <div className="stat-grid">
            {[['First-month cost', fmtMoney(res.cost.firstMonthCents)], ['Monthly fully loaded cost', fmtMoney(res.cost.monthlyLoadedCents)], ['Annual fully loaded cost', fmtMoney(res.cost.annualLoadedCents)], ['Cost per dollar of pay', res.cost.loadFactor.value ? `${res.cost.loadFactor.value.toFixed(2)}x` : 'N/A'],
              ['Break-even gross profit / month', fmtMoney(res.breakEvenGrossProfitCents)], ['Break-even sales / month', fmtMoney(res.breakEvenRevenueCents)], [`Gross profit / month to hold ${fmtPct(s.pretaxTargetPct, 0)} profit`, fmtMoney(res.gpToHoldTargetCents)], ['Break-even billable hours / month', res.breakEvenBillableHours === null ? 'Enter a bill rate' : res.breakEvenBillableHours.toFixed(0)],
              ['First month with positive contribution', res.firstPositiveMonth ? P(res.firstPositiveMonth) : 'Not within forecast'], ['Investment recovered by', res.paybackMonth ? P(res.paybackMonth) : 'Not within forecast'], ['Profit impact, first 12 months', fmtMoney(res.profitImpact12Cents)], ['Earliest supportable start', res.earliestSupportableStart ? P(res.earliestSupportableStart) : res.guardrailCents === null ? 'Needs a cash balance' : 'None under this guardrail']].map(([l, v]) => <div key={l}><span>{l}</span><b>{v}</b></div>)}
          </div>
        </Card>
        <Card className="calc" title="Before and after — next 12 months">
          <div className="tbl-wrap"><table className="tbl"><thead><tr><th></th><th className="num">Without the hire</th><th className="num">With the hire</th><th className="num">Change</th></tr></thead><tbody>
            {([['Revenue', 'revenue', 'money'], ['Gross profit', 'grossProfit', 'money'], ['Pretax profit', 'pretax', 'money']] as const).map(([l, k, kind]) => <tr key={k}><td>{l}</td><td className="num">{fmt(res.baseline[k], kind)}</td><td className="num">{fmt(res.scenario[k], kind)}</td><td className={`num ${res.scenario[k] - res.baseline[k] < 0 ? 'bad' : 'good'}`}>{fmtMoney(res.scenario[k] - res.baseline[k])}</td></tr>)}
            <tr><td>Profit margin (after owner-pay adjustment)</td><td className="num">{fmtPct(res.baseline.adjustedPretaxPct.value)}</td><td className="num">{fmtPct(res.scenario.adjustedPretaxPct.value)}</td><td className="num">{res.baseline.adjustedPretaxPct.value !== null && res.scenario.adjustedPretaxPct.value !== null ? `${((res.scenario.adjustedPretaxPct.value - res.baseline.adjustedPretaxPct.value) * 100).toFixed(1)} pts` : '—'}</td></tr>
            <tr><td><Term name="Direct LER">Direct labor efficiency</Term></td><td className="num">{fmtRatio(res.baseline.dLER.value)}</td><td className="num">{fmtRatio(res.scenario.dLER.value)}</td><td className="num">{res.baseline.dLER.value !== null && res.scenario.dLER.value !== null ? (res.scenario.dLER.value - res.baseline.dLER.value).toFixed(2) : '—'}</td></tr>
            <tr><td><Term name="Total LER">Total labor efficiency</Term></td><td className="num">{fmtRatio(res.baseline.tLER.value)}</td><td className="num">{fmtRatio(res.scenario.tLER.value)}</td><td className="num">{res.baseline.tLER.value !== null && res.scenario.tLER.value !== null ? (res.scenario.tLER.value - res.baseline.tLER.value).toFixed(2) : '—'}</td></tr>
            <tr><td>Lowest cash balance</td><td className="num">{fmtMoney(res.baseline.minCash)}</td><td className="num">{fmtMoney(res.scenario.minCash)}</td><td className="num bad">{res.baseline.minCash !== null && res.scenario.minCash !== null ? fmtMoney(res.scenario.minCash - res.baseline.minCash) : '—'}</td></tr>
          </tbody></table></div>
          {b.startingCashCents !== null && <Chart title="Projected cash balance" labels={lab} kind="money" series={[{ name: 'Without the hire', values: tl.map((m) => m.baselineCashCents), color: C.neutral }, { name: 'With the hire', values: tl.map((m) => m.scenarioCashCents), color: C.s1 }]} reference={res.guardrailCents !== null ? { value: res.guardrailCents, label: `Guardrail ${fmtMoney(res.guardrailCents, { compact: true })}` } : undefined} />}
          <Chart title="Monthly profit" labels={lab} kind="money" bars series={[{ name: 'Without the hire', values: tl.map((m) => m.baselinePretaxCents), color: C.neutral }, { name: 'With the hire', values: tl.map((m) => m.scenarioPretaxCents), color: C.s1 }]} />
          <Chart title="Cost of the role vs gross profit it brings in" labels={lab} kind="money" bars series={[{ name: 'Monthly cost', values: tl.map((m) => (m.active ? m.costCents : null)), color: C.s2 }, { name: 'Added gross profit', values: tl.map((m) => (m.active ? m.addedGrossProfitCents : null)), color: C.s3 }]} />
        </Card>
        <Card className="calc" title="Contractor vs employee — same role, four ways">
          <div className="tbl-wrap"><table className="tbl cmp"><thead><tr><th></th>{alt.map((a) => <th key={a.w} className="num">{WORKER[a.w]}{a.w === inp.workerType && <div className="sub">selected</div>}</th>)}</tr></thead><tbody>
            <tr><td>Pay or fees per year</td>{alt.map((a) => <td key={a.w} className="num">{fmtMoney(a.c.annualWagesCents)}</td>)}</tr>
            <tr><td>Employer taxes and workers' comp</td>{alt.map((a) => <td key={a.w} className="num">{fmtMoney(a.c.annualTaxesCents + a.c.annualWorkersCompCents)}</td>)}</tr>
            <tr><td>Benefits</td>{alt.map((a) => <td key={a.w} className="num">{fmtMoney(a.c.annualBenefitsCents)}</td>)}</tr>
            <tr className="tot"><td>Monthly fully loaded cost</td>{alt.map((a) => <td key={a.w} className="num">{fmtMoney(a.c.monthlyLoadedCents)}</td>)}</tr>
            <tr><td>Cost per productive hour</td>{alt.map((a) => <td key={a.w} className="num">{a.c.costPerProductiveHourCents === null ? 'N/A' : `$${(a.c.costPerProductiveHourCents / 100).toFixed(2)}`}</td>)}</tr>
            <tr><td>Flexibility to scale down</td><td className="num">Lower</td><td className="num">Moderate</td><td className="num">Higher (contract term)</td><td className="num">Highest</td></tr>
            <tr><td>Control over how work is done</td><td className="num">Yes</td><td className="num">Yes</td><td className="num">Limited by contract</td><td className="num">Limited by contract</td></tr>
          </tbody></table></div>
          <p className="muted small">Each column uses the pay inputs for its own type (salary, hourly rate and hours, or monthly fee) from the form.</p>
          <Note tone="warn"><b>This compares cost only.</b> Whether a worker is legally an employee or a contractor is determined by the applicable federal and state rules and by the actual working relationship — not by which option costs less. This tool does not classify workers. Get professional advice before engaging a contractor.</Note>
        </Card>
        <Card title="Assumptions behind these numbers"><ul>{res.assumptions.map((a) => <li key={a}>{a}</li>)}</ul></Card>
        {id && saved.data && <Card title="Discussion with your advisor">{saved.data.comments.length ? <ul className="thread">{saved.data.comments.map((m: any) => <li key={m.id}><b>{m.author}</b> <span className="muted">{dateLabel(m.created_at)}</span><p>{m.body}</p></li>)}</ul> : <p className="muted">No comments yet.</p>}
          {t.can('comment') && <div className="row"><input value={comment} placeholder="Add a comment" onChange={(e) => setComment(e.target.value)} /><button className="btn" onClick={async () => { if (comment.trim()) { await post(`${t.base}/comments`, { entity: 'scenario', entityId: id, body: comment }); setComment(''); saved.reload(); } }}>Post</button></div>}</Card>}
      </div>
    </div>
  </div>;
}

// ---------------------------------------------------------------- Profit Planner
export function ProfitPlanner() {
  const t = useT(); const fin = useLoad(() => get(`${t.base}/financials`), [t.tid]); const list = useLoad(() => get(`${t.base}/scenarios`), [t.tid]);
  const [inp, setInp] = useState<ProfitNeedsInput>({ debtPrincipalCents: 0, assetPurchasesCents: 0, savingsGoalCents: 0, ownerDistributionsCents: 0, estimatedTaxRate: 0.25, marketOwnerPayCents: 0 }); const [id, setId] = useState<string | null>(null); const [msg, setMsg] = useState<string | null>(null); const [err, setErr] = useState<string | null>(null);
  useEffect(() => { const s = list.data?.scenarios.find((x: any) => x.type === 'profit_plan'); if (s && !id) get(`${t.base}/scenarios/${s.id}`).then((x) => { setId(x.id); setInp(x.inputs); }); }, [list.data]);
  useEffect(() => { if (fin.data && !id && !list.data?.scenarios.some((x: any) => x.type === 'profit_plan')) setInp((i) => ({ ...i, estimatedTaxRate: fin.data.settings.taxReserveRate })); }, [fin.data, list.data]);
  return <Async r={fin}>{(d) => { if (d.months.length < 1) return <><h1>Profit Planner</h1><Empty>No approved financial periods yet.</Empty></>;
    const months: MonthData[] = d.months.map((m: any) => ({ period: m.period, pnl: m.pnl.lines, bs: m.bs, ownerAdj: m.pnl.ownerAdj, status: m.status })); const r12 = rolling12(months, months.length - 1, d.settings)!; const plan = profitPlan(inp, r12);
    const set = (p: Partial<ProfitNeedsInput>) => { setInp({ ...inp, ...p }); setMsg(null); };
    const save = async () => { setErr(null); try { const x = id ? await put(`${t.base}/scenarios/${id}`, { name: 'Annual profit plan', inputs: inp }) : await post(`${t.base}/scenarios`, { type: 'profit_plan', name: 'Annual profit plan', inputs: inp }); setId(x.id); setMsg('Plan saved.'); } catch (e) { setErr((e as Error).message); } };
    const q: [string, keyof ProfitNeedsInput, string][] = [['What debt principal needs to be repaid this year?', 'debtPrincipalCents', 'Principal only. Interest is already an expense on the P&L.'], ['What investments or equipment purchases are planned?', 'assetPurchasesCents', 'Capital purchases are a cash use, not an expense.'], ['How much do you want to add to cash reserves?', 'savingsGoalCents', 'For example, the gap to your core capital target.'], ['What owner distributions do you want beyond your salary?', 'ownerDistributionsCents', 'Distributions come out of after-tax profit.']];
    return <>
      <div className="page-h"><div><h1>Profit Planner</h1><p className="meta">How much profit does the business need — and what sales does that take? Based on the rolling 12 months through <b>{P(r12.to)}</b>{!r12.complete && ` (${r12.monthsIncluded} months available)`}.</p></div><div className="controls">{t.can('scenario_write') && <button className="btn btn-primary" onClick={save}>Save plan</button>}</div></div>
      <ErrorNote error={err} />{msg && <Note tone="good">{msg}</Note>}
      <div className="lab-grid">
        <fieldset className="card inputs" disabled={!t.can('scenario_write')}><legend>What profit needs to cover <span className="muted">— editable</span></legend>
          {q.map(([label, k, hint]) => <Field key={k} label={label} hint={hint}><Money value={inp[k] as number} onChange={(v) => set({ [k]: v ?? 0 })} /></Field>)}
          <Field label="Estimated income tax rate on profit" hint="A planning assumption supplied by you or your advisor — not a tax calculation."><Num pct value={inp.estimatedTaxRate} onChange={(v) => set({ estimatedTaxRate: v ?? 0 })} min={0} max={90} /></Field>
          <Note>Debt principal, equipment, savings and distributions are paid from cash left after tax. They do not appear as expenses on your P&amp;L, which is why profit has to be planned to cover them.</Note>
        </fieldset>
        <div className="results">
          <Card className="calc" title={<>Profit the business needs <span className="muted">— calculated</span></>}>
            <div className="stat-grid">{[['Cash uses to fund', fmtMoney(plan.cashUsesCents)], ['Set aside for estimated taxes', fmtMoney(plan.taxReserveCents)], ['Required pretax profit (year)', fmtMoney(plan.requiredPretaxCents)], ['Required pretax profit (month)', fmtMoney(plan.monthlyRequiredPretaxCents)], ['Current true profit (rolling 12)', fmtMoney(plan.currentPretaxCents)], ['Profit gap', fmtMoney(plan.gapCents)], ['Revenue needed at current cost structure', fmtMoney(plan.requiredRevenueCents)], ['Contribution needed (fixed costs + profit)', fmtMoney(plan.requiredContributionCents)]].map(([l, v]) => <div key={l}><span>{l}</span><b>{v}</b></div>)}</div>
            <Chart labels={['Current true profit', 'Required profit']} kind="money" bars zeroBased series={[{ name: 'Pretax profit', values: [plan.currentPretaxCents, plan.requiredPretaxCents] }]} height={180} />
          </Card>
          <Card className="calc" title="Ways to close the gap">{plan.gapCents === 0 ? <Note tone="good">Current true profit already covers this plan.</Note> : <>
            <p>You need <b>{fmtMoney(plan.gapCents)}</b> more annual pretax profit. Any one of these would do it on its own; in practice it is usually a mix:</p>
            <table className="tbl"><tbody>
              <tr><td><b>Raise prices</b><div className="sub">with no loss of volume</div></td><td className="num">{fmtPct(plan.priceIncreasePct.value)} across the board</td></tr>
              <tr><td><b>Sell more</b><div className="sub">at today's margins and labor efficiency; fixed costs unchanged</div></td><td className="num">{plan.volumeIncreasePct.value === null ? 'N/A' : `${fmtPct(plan.volumeIncreasePct.value)} more volume (${fmtMoney(plan.requiredRevenueCents)} of sales)`}</td></tr>
              <tr><td><b>Cut expenses</b><div className="sub">with no loss of sales</div></td><td className="num">{fmtMoney(plan.expenseReductionCents)} per year</td></tr>
              <tr><td><b>Improve productivity</b><div className="sub">same gross profit from less direct labor</div></td><td className="num">{plan.requiredDirectLER.value === null || plan.requiredDirectLER.value < 0 ? 'Not achievable from labor alone' : `Direct LER of ${fmtRatio(plan.requiredDirectLER.value)} (now ${fmtRatio(r12.dLER.value)})`}</td></tr>
            </tbody></table>
            <p className="muted">Price increases fall straight to profit but risk volume. More volume needs capacity — and often labor — so it helps less than it looks. Expense cuts are certain but limited. Test combinations in the Decision Lab.</p></>}
          </Card>
          <Card title="How this is calculated"><ul>{plan.notes.map((n) => <li key={n}>{n}</li>)}</ul><p className="muted small">Cost behavior assumed: non-labor COGS, direct labor, marketing and payroll burden move with sales ({fmtPct(plan.contributionRate.value)} of each sales dollar is left after them); facilities, management labor and other operating expenses ({fmtMoney(plan.fixedCostsCents)}) stay fixed for the year. Step-variable costs, seasonality and Minimum / Target / Stretch plans arrive in Phase 2.</p></Card>
        </div>
      </div>
    </>; }}</Async>;
}
