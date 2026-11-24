// Cash Flow Waterfall: taxes → debt → operating reserve → distributions, plus "where did the cash go?".
import React, { useState } from 'react';
import { get, put } from './api.ts';
import { useT } from './App.tsx';
import { Async, Card, ErrorNote, Money, Note, P, Pill, StatusPill, dateLabel, useLoad } from './ui.tsx';
import { fmtMoney, fmtPct } from '../engine/core.ts';

export function FourForcesCard() {
  const t = useT(); const r = useLoad(() => get(`${t.base}/four-forces`), [t.tid]); const [paid, setPaid] = useState<number | null>(null); const [proj, setProj] = useState<number | null | undefined>(undefined); const [err, setErr] = useState<string | null>(null);
  return <Card title="Cash Flow Waterfall" right={r.data?.available ? <StatusPill status={r.data.status} /> : null}>
    <Async r={r}>{(d) => { if (!d.available) return <p className="muted">{d.reason}</p>;
      const f = d.forces; const max = Math.max(f.cashCents, 1);
      const save = async () => { setErr(null); try { await put(`${t.base}/four-forces/taxes-paid`, { fiscalYear: Number(d.fiscalYear), cents: paid ?? d.taxesPaidCents, ...(proj !== undefined ? { projectedCents: proj } : {}) }); setPaid(null); setProj(undefined); r.reload(); } catch (e) { setErr((e as Error).message); } };
      return <>
        <p className="meta">Cash on hand at the end of <b>{P(d.asOf)}</b>, committed in order. Year to date from {P(d.ytdFrom)}{!d.ytdComplete && ' (some months missing)'}.</p>
        <div className="tbl-wrap"><table className="tbl forces"><thead><tr><th>Step</th><th></th><th className="num">Needed</th><th className="num">Covered by cash</th><th className="num">Cash left after</th><th style={{ width: '22%' }}></th></tr></thead><tbody>
          <tr className="tot"><td></td><td>Cash on hand</td><td></td><td></td><td className="num">{fmtMoney(f.cashCents)}</td><td><i className="fbar"><b style={{ width: '100%' }} /></i></td></tr>
          {f.steps.map((s: any) => <tr key={s.key} className={s.force === 4 ? 'tot strong' : ''}><td>{s.force === 4 ? '4' : s.key === 'debt' ? '' : s.force}</td><td>{s.label}<span className="sub">{s.note}</span></td>
            <td className="num">{s.force === 4 ? '' : fmtMoney(s.needCents)}</td><td className="num">{s.force === 4 ? '' : <>{fmtMoney(s.fundedCents)}{s.shortCents > 0 && <span className="sub bad">{fmtMoney(s.shortCents)} short</span>}</>}</td>
            <td className={`num ${s.remainingCents < 0 ? 'bad' : ''}`}>{s.force === 4 ? <b>{fmtMoney(f.availableForDistributionCents)}</b> : fmtMoney(s.remainingCents)}</td>
            <td><i className="fbar"><b className={s.remainingCents < 0 ? 'neg' : ''} style={{ width: `${Math.min(100, (Math.abs(s.force === 4 ? f.availableForDistributionCents : s.remainingCents) / max) * 100)}%` }} /></i></td></tr>)}
        </tbody></table></div>
        {f.flags.map((x: any) => <Note key={x.text} tone={x.severity === 'good' ? 'good' : 'warn'}>{x.text}</Note>)}
        {f.shortfallCents > 0 && <p>{f.monthsOfProfitToFund !== null ? <>At the last three months' average profit, keeping {fmtPct(1 - d.taxRate, 0)} after tax, it takes about <b>{f.monthsOfProfitToFund.toFixed(1)} months</b> of retained profit to fund the {fmtMoney(f.shortfallCents)} shortfall.</> : <>The business is not currently producing profit to retain, so the {fmtMoney(f.shortfallCents)} shortfall cannot be funded from operations yet.</>}</p>}
        <div className="grid-2">
          <div><h4>Where did the cash go? — year to date</h4>{d.walk ? <table className="tbl"><tbody>
            <tr><td>Beginning cash</td><td className="num">{fmtMoney(d.walk.beginningCashCents)}</td></tr><tr><td>Pretax profit</td><td className="num">{fmtMoney(d.walk.pretaxCents)}</td></tr>
            <tr className="tot"><td>Cash available</td><td className="num">{fmtMoney(d.walk.beginningCashCents + d.walk.pretaxCents)}</td></tr>
            <tr><td>Timing: receivables, payables, depreciation</td><td className="num">{fmtMoney(d.walk.timingCents)}</td></tr><tr><td>Equipment and other asset purchases</td><td className="num">{fmtMoney(d.walk.assetPurchasesCents)}</td></tr>
            <tr><td>Debt principal (net of new borrowing)</td><td className="num">{fmtMoney(d.walk.debtCents)}</td></tr><tr><td>Distributions and other equity (includes tax distributions)</td><td className="num">{fmtMoney(d.walk.distributionsCents)}</td></tr>
            <tr className="tot"><td>Cash at {P(d.walk.to)}</td><td className="num">{fmtMoney(d.walk.endingCashCents)}</td></tr>
            {Math.abs(d.walk.differenceCents) > 100 && <tr><td className="bad">Does not tie to the balance sheet by</td><td className="num bad">{fmtMoney(d.walk.differenceCents)}</td></tr>}</tbody></table> : <p className="muted">Needs a balance sheet for every month of the year to date and the month before it.</p>}</div>
          <div><h4>Tax set-aside</h4>
            <table className="tbl"><tbody><tr><td>Planning rate × year-to-date profit</td><td className="num">{fmtPct(d.taxRate, 0)} = {fmtMoney(d.rateBasedTaxCents)}</td></tr>
              <tr><td>Projected tax for {d.fiscalYear} from tax planning<span className="sub">{d.projectedTaxCents === null ? 'Optional. When entered, this amount is reserved instead of the rate.' : 'In use. Clear the field to return to the planning rate.'}</span></td><td className="num">{t.can('adjust') ? <Money nullable placeholder="not entered" value={proj === undefined ? d.projectedTaxCents : proj} onChange={(v) => setProj(v)} /> : fmtMoney(d.projectedTaxCents)}</td></tr><tr><td>Taxes paid or distributed for tax, {d.fiscalYear}</td><td className="num">{t.can('adjust') ? <Money value={paid ?? d.taxesPaidCents} onChange={(v) => setPaid(v ?? 0)} /> : fmtMoney(d.taxesPaidCents)}</td></tr>
              <tr><td>Still to set aside</td><td className="num"><b>{fmtMoney(f.taxReserveNeededCents)}</b></td></tr><tr><td>On the last three months' profit alone</td><td className="num">{fmtMoney(d.quarterSetAsideCents)}</td></tr><tr><td>Next typical estimated-payment date</td><td className="num">{dateLabel(d.nextTaxDate)}</td></tr></tbody></table>
            {t.can('adjust') && (paid !== null || proj !== undefined) && <div className="row"><button className="btn btn-primary btn-sm" onClick={save}>Save tax figures</button></div>}<ErrorNote error={err} />
            <p className="muted small">Move the set-aside to a separate account each quarter, whenever it is actually due. The rate is a planning assumption set in Client Settings, and the date is the usual federal schedule for individuals — the tax preparer determines what is owed and when.</p></div>
        </div>
        <p className="muted small">Order of claims on cash: taxes, then debt, then the operating reserve target ({d.coreCapitalBasis}, with nothing drawn on the line of credit), then profit distributions. Owner salary is not a distribution — it is pay for work and is already in labor cost.</p>
      </>; }}</Async>
  </Card>;
}
