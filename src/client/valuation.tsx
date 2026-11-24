// Estimated business value (Crabtree ch. 9): blended valuation, fundability, rule-of-thumb comparisons and the five elements of value.
import React, { useEffect, useState } from 'react';
import { del, get, post, put } from './api.ts';
import { useT } from './App.tsx';
import { Card, ErrorNote, Field, Money, Note, Num, P, Pill, useLoad } from './ui.tsx';
import { fmtMoney, fmtPct } from '../engine/core.ts';
import { VALUE_ELEMENTS, defaultValuation, profitLevels, valuation, type ProfitLevelsInput, type ValuationBase, type ValuationInput } from '../engine/valuation.ts';
import { C, Chart } from './charts.tsx';

export function ValuationCard({ base, taxRate, ler }: { base: ValuationBase | null; taxRate: number; ler: number | null }) {
  const t = useT(); const list = useLoad(() => get(`${t.base}/scenarios`), [t.tid]);
  const [inp, setInp] = useState<ValuationInput | null>(null); const [id, setId] = useState<string | null>(null); const [open, setOpen] = useState(false); const [msg, setMsg] = useState<string | null>(null); const [err, setErr] = useState<string | null>(null);
  useEffect(() => { const s = list.data?.scenarios.find((x: any) => x.type === 'valuation'); if (s && !id) get(`${t.base}/scenarios/${s.id}`).then((x) => { setId(x.id); setInp({ ...defaultValuation(taxRate), ...x.inputs }); setOpen(true); }); }, [list.data]);
  const canWrite = t.can('scenario_write');
  if (!base) return null;
  if (!open) return <Card title="Estimated business value" className="no-print"><p className="muted">Estimate what the business is worth to its owners: the last three years of true pretax profit plus equity. Useful for knowing when the business is underperforming, and as a starting point for a buy-sell agreement or bringing in a partner.</p>{canWrite && <button className="btn" onClick={() => { setInp(defaultValuation(taxRate)); setOpen(true); }}>Estimate business value</button>}</Card>;
  if (!inp) return null;
  const r = valuation(base, inp); const set = (p: Partial<ValuationInput>) => { setInp({ ...inp, ...p }); setMsg(null); };
  const setEl = (k: string, p: any) => set({ elements: { ...inp.elements, [k]: { rating: null, note: '', ...(inp.elements as any)[k], ...p } } });
  const save = async () => { setErr(null); try { const x = id ? await put(`${t.base}/scenarios/${id}`, { name: 'Estimated business value', inputs: inp }) : await post(`${t.base}/scenarios`, { type: 'valuation', name: 'Estimated business value', inputs: inp }); setId(x.id); setMsg('Estimate saved.'); } catch (e) { setErr((e as Error).message); } };
  const remove = async () => { if (id) await del(`${t.base}/scenarios/${id}`); setId(null); setInp(null); setOpen(false); list.reload(); };
  const auto: Record<string, string> = { core_capital: base.coreCapitalSurplusCents === null ? 'Operating reserve not available (no balance sheet).' : base.coreCapitalSurplusCents >= 0 ? `Operating reserve is ${fmtMoney(base.coreCapitalSurplusCents)} above target.` : `Operating reserve is ${fmtMoney(-base.coreCapitalSurplusCents)} short of target.`, employees: ler === null ? '' : `Labor yield, rolling 12: ${ler.toFixed(2)}x.` };
  return <Card title="Estimated business value" right={<Pill tone="warn">Management estimate — not an appraisal</Pill>}>
    {!r.available ? <p className="muted">{r.reason}</p> : <>
      <p className="meta">As of <b>{P(base.asOf)}</b> · {r.method === 'blended' ? 'Blended method: three years of true pretax profit plus equity' : 'Net assets: there is no profit stream to value'}</p>
      <div className="stat-grid">
        <div><span>Three years of true pretax profit</span><b>{fmtMoney(r.threeYearPretaxCents)}</b><small>{r.estimated ? `Estimated from ${base.monthsUsed} months` : 'Last 36 months'} · {fmtMoney(r.avgAnnualPretaxCents)} a year</small></div>
        <div><span>Equity{inp.equityAdjustmentCents !== 0 ? ', adjusted' : ''}</span><b>{fmtMoney(r.adjustedEquityCents)}</b><small>Assets minus liabilities{inp.equityAdjustmentCents !== 0 ? ` · book ${fmtMoney(base.equityCents)}` : ''}</small></div>
        <div><span>Estimated business value</span><b>{fmtMoney(r.valueCents)}</b><small>{r.method === 'blended' ? 'Profit plus equity' : 'Equity only'}</small></div>
        <div><span>{fmtPct(inp.stakePct, 0)} interest</span><b>{fmtMoney(r.stakePriceCents)}</b><small>{r.stakeBasis === 'discounted' ? `On the discounted value · ${fmtMoney(r.stakeIfWholeBusinessSoldCents)} if the whole business sells` : 'On the undiscounted value'}</small></div>
      </div>
      {r.flags.map((f) => <Note key={f.text} tone={f.severity === 'warn' ? 'warn' : 'info'}>{f.text}</Note>)}
      <div className="grid-2">
        <div><h4>Value and discounts</h4><table className="tbl"><tbody>
          <tr><td>Three years of true pretax profit</td><td className="num">{fmtMoney(r.threeYearPretaxCents)}</td></tr><tr><td>Equity{inp.equityAdjustmentCents !== 0 ? ', adjusted' : ''}</td><td className="num">{fmtMoney(r.adjustedEquityCents)}</td></tr>
          <tr className="tot"><td>Value before discounts</td><td className="num">{fmtMoney(r.valueCents)}</td></tr>
          <tr><td>Less lack of marketability, {fmtPct(inp.marketabilityDiscount, 0)}</td><td className="num">{fmtMoney(-r.marketabilityDiscountCents)}</td></tr><tr><td>Less lack of control, {fmtPct(inp.controlDiscount, 0)}</td><td className="num">{fmtMoney(-r.controlDiscountCents)}</td></tr>
          <tr className="tot"><td>Value after discounts<span className="sub">For an interest under half, and for an owner who leaves before a sale</span></td><td className="num">{fmtMoney(r.discountedValueCents)}</td></tr>
          <tr><td>Value as a multiple of EBITDA / of revenue</td><td className="num">{r.impliedEbitdaMultiple.value === null ? 'N/A' : `${r.impliedEbitdaMultiple.value.toFixed(2)}×`} / {r.impliedRevenueMultiple.value === null ? 'N/A' : `${r.impliedRevenueMultiple.value.toFixed(2)}×`}</td></tr></tbody></table>
          <p className="muted small">The book cites 10–20% for each discount as the general range; the right figures depend on the facts and need a qualified appraiser. Half or more of the business is priced without discounts.</p></div>
        <div><h4>Can the business pay for it?</h4><table className="tbl"><tbody>
          <tr><td>Price of a {fmtPct(inp.stakePct, 0)} interest</td><td className="num">{fmtMoney(r.stakePriceCents)}</td></tr>
          <tr><td>Annual payment, {inp.noteYears} years at {fmtPct(inp.noteRate)}</td><td className="num">{fmtMoney(r.note.annualPaymentCents)}</td></tr>
          <tr><td>After-tax profit available each year<span className="sub">Three-year average of {fmtMoney(r.avgAnnualPretaxCents)} less {fmtPct(inp.taxRate, 0)} tax</span></td><td className="num">{fmtMoney(r.note.availableCents)}</td></tr>
          <tr className="tot"><td>Excess (shortfall)</td><td className={`num ${r.note.excessCents < 0 ? 'bad' : ''}`}>{fmtMoney(r.note.excessCents)}{r.note.variance.value !== null && ` · ${(r.note.variance.value * 100).toFixed(1)}%`}</td></tr>
          <tr><td>Years to pay for the whole business at {fmtPct(inp.noteRate)}</td><td className="num">{r.yearsToRepayWhole.value === null ? 'N/A' : r.yearsToRepayWhole.value.toFixed(1)}</td></tr></tbody></table>
          <p className="muted small">{r.note.variance.reason ?? r.yearsToRepayWhole.reason ?? 'A deal is balanced when the payment is within 10% of the after-tax profit available, either way. This assumes the business is fully capitalized and needs no more working capital.'}</p></div>
      </div>
      <div className="grid-2">
        <div><h4>Assumptions</h4><div className="form-grid">
          <Field label="Interest being valued"><Num pct value={inp.stakePct} onChange={(v) => set({ stakePct: v ?? 0.5 })} min={1} max={100} step={5} /></Field>
          <Field label="Tax rate on profit"><Num pct value={inp.taxRate} onChange={(v) => set({ taxRate: v ?? 0 })} min={0} max={95} /></Field>
          <Field label="Discount, lack of marketability"><Num pct value={inp.marketabilityDiscount} onChange={(v) => set({ marketabilityDiscount: v ?? 0 })} min={0} max={60} step={5} /></Field>
          <Field label="Discount, lack of control"><Num pct value={inp.controlDiscount} onChange={(v) => set({ controlDiscount: v ?? 0 })} min={0} max={60} step={5} /></Field>
          <Field label="Note interest rate"><Num pct value={inp.noteRate} onChange={(v) => set({ noteRate: v ?? 0 })} min={0} max={50} step={0.5} /></Field>
          <Field label="Note term, years"><Num value={inp.noteYears} onChange={(v) => set({ noteYears: Math.max(1, Math.round(v ?? 5)) })} min={1} max={30} step={1} /></Field>
          <Field label="Adjustment to book equity" hint="Only for an asset or liability that is materially over- or under-stated."><Money value={inp.equityAdjustmentCents} onChange={(v) => set({ equityAdjustmentCents: v ?? 0 })} /></Field>
          <Field label="Reason for the adjustment"><input value={inp.equityAdjustmentNote} maxLength={500} onChange={(e) => set({ equityAdjustmentNote: e.target.value })} /></Field>
          <Field label="EBITDA multiple (comparison)"><Num value={inp.ebitdaMultiple} onChange={(v) => set({ ebitdaMultiple: v ?? 0 })} min={0} max={50} step={0.5} suffix="×" /></Field>
          <Field label="Revenue multiple (comparison)"><Num value={inp.revenueMultiple} onChange={(v) => set({ revenueMultiple: v ?? 0 })} min={0} max={50} step={0.25} suffix="×" /></Field></div></div>
        <div><h4>Rules of thumb, for comparison only</h4><table className="tbl"><tbody>
          <tr className="tot"><td>Blended method</td><td className="num">{fmtMoney(r.valueCents)}</td><td></td></tr>
          {r.comparisons.map((c) => <tr key={c.label}><td>{c.label}</td><td className="num">{fmtMoney(c.valueCents)}</td><td className="muted small">{c.caution}</td></tr>)}</tbody></table>
          <p className="muted small">The multiples and the 7% note rate are editable assumptions, not market data. Whatever rule is used, value is what a willing buyer and a willing seller agree to. Discounted cash-flow projections are left out on purpose: they rest on forecasts rather than results.</p></div>
      </div>
      <h4>Five elements of value</h4>
      <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Element</th><th>What to look at</th><th>Assessment</th><th>Notes</th></tr></thead><tbody>
        {VALUE_ELEMENTS.map(([k, label, what]) => { const e = (inp.elements as any)[k] ?? { rating: null, note: '' }; return <tr key={k}><td><b>{label}</b></td><td className="small">{what}{auto[k] && <span className="sub">{auto[k]}</span>}</td>
          <td>{canWrite ? <select aria-label={`Assessment for ${label}`} value={e.rating ?? ''} onChange={(ev) => setEl(k, { rating: ev.target.value || null })}><option value="">Not assessed</option><option value="strong">Strong</option><option value="adequate">Adequate</option><option value="weak">Weak</option></select> : e.rating ?? 'Not assessed'}</td>
          <td>{canWrite ? <input aria-label={`Notes for ${label}`} value={e.note} maxLength={500} onChange={(ev) => setEl(k, { note: ev.target.value })} /> : e.note}</td></tr>; })}</tbody></table></div>
      <p className="muted small">The assessments are the advisor's and owner's judgment and do not change the number above. They explain why a buyer might pay more or less than the formula. A real sale, buy-sell agreement or partner admission needs a qualified valuation and legal and tax advice.</p>
    </>}
    <ErrorNote error={err} />{msg && <Note tone="good">{msg}</Note>}
    {canWrite && <div className="row no-print"><button className="btn btn-primary" onClick={save}>Save estimate</button><button className="btn btn-ghost" onClick={remove}>{id ? 'Delete' : 'Close'}</button></div>}
  </Card>;
}

const LC = [C.neutral, C.s1, C.s3, C.s2];
export function ProfitLevelsCard({ base, s, currentPct }: { base: ValuationBase | null; s: any; currentPct: number | null }) {
  const t = useT(); const list = useLoad(() => get(`${t.base}/scenarios`), [t.tid]);
  const [inp, setInp] = useState<ProfitLevelsInput | null>(null); const [growth, setGrowth] = useState(0); const [id, setId] = useState<string | null>(null); const [open, setOpen] = useState(false); const [msg, setMsg] = useState<string | null>(null); const [err, setErr] = useState<string | null>(null);
  useEffect(() => { const sc = list.data?.scenarios.find((x: any) => x.type === 'profit_levels'); if (sc && !id) get(`${t.base}/scenarios/${sc.id}`).then((x) => { setId(x.id); setInp(x.inputs); setOpen(true); }); }, [list.data]);
  if (!base) return null; const canWrite = t.can('scenario_write');
  const path = (g: number, n = 5) => Array.from({ length: n }, (_, k) => Math.round((base.revenue12Cents * Math.pow(1 + g, k)) / 100) * 100);
  const start = (): ProfitLevelsInput => { const lv = [...new Set([0.05, s.pretaxTargetPct, s.stretchPretaxPct].map((x: number) => Math.round(x * 1000) / 1000))].sort((a, b) => a - b); return { startEquityCents: Math.round((base.equityCents ?? 0) / 100) * 100, revenueCents: path(0), levels: lv, taxRate: s.taxReserveRate, coreCapitalMonths: s.coreCapitalMonths, firstProfitDistributionYear: 3, marketabilityDiscount: 0.2, controlDiscount: 0.2 }; };
  if (!open) return <Card title="What each profit tier does to value and distributions" className="no-print"><p className="muted">Compare the same revenue at different pretax profit percentages over five years: what the owners can take out after taxes and operating reserve, and what the business is worth at the end.</p>{canWrite && <button className="btn" onClick={() => { setInp(start()); setOpen(true); }}>Compare profit tiers</button>}</Card>;
  if (!inp) return null;
  const res = profitLevels(inp); const set = (p: Partial<ProfitLevelsInput>) => { setInp({ ...inp, ...p }); setMsg(null); }; const yrs = inp.revenueCents.map((_, k) => `Year ${k + 1}`);
  const save = async () => { setErr(null); try { const x = id ? await put(`${t.base}/scenarios/${id}`, { name: 'Profit tiers', inputs: inp }) : await post(`${t.base}/scenarios`, { type: 'profit_levels', name: 'Profit tiers', inputs: inp }); setId(x.id); setMsg('Comparison saved.'); } catch (e) { setErr((e as Error).message); } };
  const remove = async () => { if (id) await del(`${t.base}/scenarios/${id}`); setId(null); setInp(null); setOpen(false); list.reload(); };
  return <Card title="What each profit tier does to value and distributions" right={<Pill tone="warn">Illustration — not a forecast</Pill>}>
    {currentPct !== null && <p className="meta">True pretax profit is currently <b>{fmtPct(currentPct)}</b> of revenue over the last twelve months.</p>}
    <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Pretax profit tier</th><th className="num">Profit distributions, {yrs.length} years</th><th className="num">Tax distributions</th><th className="num">Ending equity</th><th className="num">Operating reserve target reached</th><th className="num">Value at end</th><th className="num">After discounts</th></tr></thead><tbody>
      {res.map((r, k) => { const last = r.years[r.years.length - 1]; return <tr key={r.level}><td><span className="dot" style={{ background: LC[k % 4] }} /> <b>{fmtPct(r.level)}</b></td><td className="num"><b>{fmtMoney(r.totalProfitDistributionsCents)}</b></td><td className="num">{fmtMoney(r.totalTaxDistributionsCents)}</td><td className="num">{fmtMoney(last.equityCents)}</td><td className="num">{r.yearCoreCapitalReached === null ? <span className="bad">Not within {yrs.length} years</span> : `Year ${r.yearCoreCapitalReached}`}</td><td className="num"><b>{fmtMoney(r.endingValueCents)}</b></td><td className="num">{fmtMoney(last.discountedValueCents)}</td></tr>; })}</tbody></table></div>
    <div className="grid-2">
      <div><h4>Value of the business by year</h4><Chart labels={yrs} kind="money" zeroBased series={res.map((r, k) => ({ name: `${fmtPct(r.level)} pretax`, values: r.years.map((y) => y.valueCents), color: LC[k % 4] }))} /></div>
      <div><h4>Profit distributions by year</h4><Chart labels={yrs} kind="money" zeroBased series={res.map((r, k) => ({ name: `${fmtPct(r.level)} pretax`, values: r.years.map((y) => y.profitDistributionCents), color: LC[k % 4] }))} /></div>
    </div>
    {res.map((r) => <details key={r.level}><summary>Year by year at {fmtPct(r.level)}</summary><div className="tbl-wrap"><table className="tbl"><thead><tr><th></th>{yrs.map((y) => <th key={y} className="num">{y}</th>)}</tr></thead><tbody>
      {([['Revenue', 'revenueCents'], ['Pretax profit', 'pretaxCents'], ['Tax distributions (on prior year)', 'taxDistributionCents'], ['Profit distributions (above operating reserve target)', 'profitDistributionCents'], ['Equity at year end', 'equityCents'], ['Operating reserve target', 'coreCapitalTargetCents'], ['Value before discounts', 'valueCents']] as const).map(([l, key]) => <tr key={key} className={key === 'valueCents' || key === 'equityCents' ? 'tot' : ''}><td>{l}</td>{r.years.map((y) => <td key={y.year} className="num">{fmtMoney(y[key])}</td>)}</tr>)}
      <tr><td>Return on investment</td>{r.years.map((y) => <td key={y.year} className="num">{y.returnOnInvestment.value === null ? 'N/A' : fmtPct(y.returnOnInvestment.value, 0)}</td>)}</tr></tbody></table></div></details>)}
    <h4>Assumptions</h4>
    <div className="form-grid">
      <Field label="Starting equity" hint="From the latest balance sheet."><Money value={inp.startEquityCents} onChange={(v) => set({ startEquityCents: v ?? 0 })} /></Field>
      <Field label="Revenue growth per year" hint="Fills the five years from the last twelve months of revenue. Starts at no growth."><Num pct value={growth} onChange={(v) => { setGrowth(v ?? 0); set({ revenueCents: path(v ?? 0, inp.revenueCents.length) }); }} min={-50} max={200} step={1} /></Field>
      <Field label="Tax rate on profit"><Num pct value={inp.taxRate} onChange={(v) => set({ taxRate: v ?? 0 })} min={0} max={95} /></Field>
      <Field label="Operating reserve target, months of costs"><Num value={inp.coreCapitalMonths} onChange={(v) => set({ coreCapitalMonths: v ?? 2 })} min={0} max={24} step={0.5} /></Field>
      {inp.levels.map((lv, k) => <Field key={k} label={`Profit tier ${k + 1}`} hint={k === 0 ? 'Pretax profit as a share of sales. Set each tier to whatever you want to compare.' : undefined}><div className="row"><Num pct value={lv} onChange={(v) => set({ levels: inp.levels.map((x, j) => (j === k ? v ?? 0 : x)) })} min={-50} max={90} step={1} />{inp.levels.length > 1 && <button className="btn btn-sm btn-ghost" aria-label={`Remove profit tier ${k + 1}`} onClick={() => set({ levels: inp.levels.filter((_, j) => j !== k) })}>Remove</button>}</div></Field>)}
      {inp.levels.length < 4 && <Field label="Another tier"><button className="btn btn-sm" onClick={() => set({ levels: [...inp.levels, Math.min(0.9, Math.round((Math.max(...inp.levels) + 0.05) * 100) / 100)] })}>Add a profit tier</button></Field>}
      {inp.revenueCents.map((rv, k) => <Field key={k} label={`Year ${k + 1} revenue`}><Money value={rv} onChange={(v) => set({ revenueCents: inp.revenueCents.map((x, j) => (j === k ? v ?? 0 : x)) })} /></Field>)}
    </div>
    <p className="muted small">How it works: taxes are distributed the year after the profit is earned; profit is distributed only from year {inp.firstProfitDistributionYear} and only the amount equity stood above the operating reserve target at the end of the year before; value each year is three times the average of up to the last three years' profit, plus equity. It assumes owners draw a market wage throughout and that revenue is the same at every profit tier. The revenue path is your assumption, not a prediction.</p>
    <ErrorNote error={err} />{msg && <Note tone="good">{msg}</Note>}
    {canWrite && <div className="row no-print"><button className="btn btn-primary" onClick={save}>Save comparison</button><button className="btn" onClick={() => { setGrowth(0); setInp(start()); }}>Reset</button><button className="btn btn-ghost" onClick={remove}>{id ? 'Delete' : 'Close'}</button></div>}
  </Card>;
}
