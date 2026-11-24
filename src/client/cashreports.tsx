// Reporting rhythms (Crabtree ch. 8): the daily cash report and the two-week cash flow forecast report.
import React, { useState } from 'react';
import { get, put } from './api.ts';
import { useT } from './App.tsx';
import { Async, Card, Drawer, ErrorNote, Field, Money, Note, P, Pill, dateLabel, useLoad } from './ui.tsx';
import { fmtMoney } from '../engine/core.ts';

const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const short = (iso: string) => dateLabel(iso).replace(/, \d{4}/, '');
const AGING: [string, string][] = [['d0_30', '0–30 days'], ['d31_60', '31–60 days'], ['d61_90', '61–90 days'], ['over90', 'Over 90 days']];

export function CashReportsCard({ onSaved }: { onSaved: () => void }) {
  const t = useT(); const r = useLoad(() => get(`${t.base}/cash-reports`), [t.tid]); const [edit, setEdit] = useState<any>(null); const [err, setErr] = useState<string | null>(null);
  const blank = (d: any) => ({ date: today(), cashBalanceCents: d.position?.cents ?? 0, deposits: [{ payer: '', cents: 0 }], withAging: false, aging: d.aging ? { d0_30: d.aging.d0_30, d31_60: d.aging.d31_60, d61_90: d.aging.d61_90, over90: d.aging.over90 } : { d0_30: 0, d31_60: 0, d61_90: 0, over90: 0 }, missedOwnerPayCents: null });
  const save = async () => { setErr(null); try { await put(`${t.base}/daily-cash`, { date: edit.date, cashBalanceCents: edit.cashBalanceCents, deposits: edit.deposits.filter((x: any) => x.payer.trim() && x.cents > 0), aging: edit.withAging ? edit.aging : undefined, missedOwnerPayCents: edit.missedOwnerPayCents }); setEdit(null); r.reload(); onSaved(); } catch (e) { setErr((e as Error).message); } };
  return <Async r={r}>{(d) => { const tw = d.twoWeek; const agingTotal = d.aging ? AGING.reduce((a, [k]) => a + d.aging[k], 0) : 0; const latest = d.days[0];
    return <>
      <Card title="Two-week cash flow forecast" right={<Pill>Weekly report</Pill>}>
        {!tw ? <p className="muted">Needs a starting cash balance.</p> : <div className="grid-2">
          <div><div className="tbl-wrap"><table className="tbl"><thead><tr><th></th>{tw.weeks.map((w: any) => <th key={w.weekStart} className="num">Week of {short(w.weekStart)}</th>)}</tr></thead><tbody>
            <tr className="tot"><td>Cash at start of week</td>{tw.weeks.map((w: any) => <td key={w.weekStart} className="num">{fmtMoney(w.beginCents)}</td>)}</tr>
            <tr><td>Expected receipts</td>{tw.weeks.map((w: any) => <td key={w.weekStart} className="num">{fmtMoney(w.receiptsCents)}</td>)}</tr>
            {tw.weeks[0].payables.map((p: any, i: number) => tw.weeks.some((w: any) => w.payables[i].cents) ? <tr key={p.group}><td>{p.group}</td>{tw.weeks.map((w: any) => <td key={w.weekStart} className="num">{fmtMoney(-w.payables[i].cents)}</td>)}</tr> : null)}
            <tr><td>Total payables</td>{tw.weeks.map((w: any) => <td key={w.weekStart} className="num">{fmtMoney(-w.payablesCents)}</td>)}</tr>
            <tr className="tot strong"><td>Cash at end of week</td>{tw.weeks.map((w: any) => <td key={w.weekStart} className={`num ${w.endCents < 0 ? 'bad' : ''}`}><b>{fmtMoney(w.endCents)}</b></td>)}</tr>
          </tbody></table></div>
            {tw.weeks.some((w: any) => w.shortCents > 0) && <Note tone="bad">Cash runs short by {fmtMoney(Math.max(...tw.weeks.map((w: any) => w.shortCents)))} within two weeks{d.loc.availableCents !== null ? `. ${fmtMoney(d.loc.availableCents)} is available on the line of credit` : ''}. Decide today which payments move, rather than on the day they are due.</Note>}
            <p className="muted small">Starting cash: {d.position.source}, as of {d.position.asOf?.length === 7 ? P(d.position.asOf) : dateLabel(d.position.asOf)}. Receipts and payables come from the cash rhythms below.</p></div>
          <div><table className="tbl"><tbody>
            <tr><td>Line of credit limit</td><td className="num">{d.loc.limitCents === null ? <span className="muted">not set</span> : fmtMoney(d.loc.limitCents)}</td></tr>
            <tr><td>Line of credit balance{d.loc.asOf && <span className="sub">balance sheet, {P(d.loc.asOf)}</span>}</td><td className="num">{fmtMoney(d.loc.balanceCents)}</td></tr>
            <tr className="tot"><td>Available to draw</td><td className="num">{d.loc.availableCents === null ? 'N/A' : fmtMoney(d.loc.availableCents)}</td></tr></tbody></table>
            {d.loc.limitCents === null && <p className="muted small">Set the line of credit limit in Client Settings to show what is left to draw.</p>}
            <h4>Receivables aging{d.aging && <span className="muted"> · as of {dateLabel(d.aging.asOf)}</span>}</h4>
            {d.aging ? <table className="tbl"><tbody>{AGING.map(([k, l]) => <tr key={k}><td>{l}</td><td className="num">{fmtMoney(d.aging[k])}</td><td className="num muted">{agingTotal ? `${Math.round((d.aging[k] / agingTotal) * 100)}%` : ''}</td></tr>)}
              <tr className="tot"><td>Total</td><td className="num">{fmtMoney(agingTotal)}</td><td></td></tr></tbody></table> : <p className="muted">Not entered. Add the aging totals from the accounting system with a daily cash report. Receivables on the latest balance sheet: {fmtMoney(d.receivablesOnBooksCents)}.</p>}
            {d.missedOwnerPay && d.missedOwnerPay.cents > 0 && <Note tone="warn">Owner paychecks missed: <b>{fmtMoney(d.missedOwnerPay.cents)}</b> as of {dateLabel(d.missedOwnerPay.asOf)}. Unpaid owner wages are a debt the business owes, and a sign cash is tighter than the bank balance shows.</Note>}</div>
        </div>}
      </Card>
      <Card title="Daily cash report" right={t.can('daily_cash') && (!t.tenant.isStaff || d.consent.allowed) ? <button className="btn no-print" onClick={() => { setErr(null); setEdit(blank(d)); }}>Enter today's report</button> : null}>
        <div className={`note note-${d.consent.allowed ? 'good' : 'info'}`}><b>SJATS access to bank information: {d.consent.allowed ? 'allowed' : 'not allowed'}.</b> {d.consent.allowed ? `Allowed by ${d.consent.decidedBy} on ${dateLabel(d.consent.decidedAt.slice(0, 10))}. SJATS staff can enter and correct the daily cash report.` : t.tenant.isStaff ? 'The client enters the daily cash report. SJATS staff can see it but cannot enter or change it until the client owner allows access.' : 'You enter the daily cash report. SJATS staff can see it but cannot enter or change it unless the owner allows access.'} A live bank feed is not connected yet; when one is, it will run only while this access is allowed.
          {t.tenant.role === 'client_owner' && <span className="row no-print" style={{ marginTop: 8 }}><button className="btn btn-sm" onClick={async () => { if (d.consent.allowed || confirm('Allow SJATS staff to enter and maintain your daily cash report, and to use a live bank feed once one is connected? You can withdraw this at any time.')) { await put(`${t.base}/bank-feed-consent`, { allowed: !d.consent.allowed }); r.reload(); } }}>{d.consent.allowed ? 'Withdraw access' : 'Allow SJATS access'}</button></span>}</div>
        {latest ? <><p className="meta">Latest: <b>{dateLabel(latest.date)}</b> · Bank balance after deposit <b>{fmtMoney(latest.cashBalanceCents)}</b></p>
          <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Date</th><th>Who paid</th><th className="num">Deposited</th><th className="num">Bank balance</th></tr></thead><tbody>
            {d.days.map((x: any) => <tr key={x.date}><td>{dateLabel(x.date)}</td><td>{x.deposits.length ? x.deposits.map((p: any) => `${p.payer} ${fmtMoney(p.cents)}`).join(' · ') : <span className="muted">No deposits</span>}</td><td className="num">{fmtMoney(x.deposits.reduce((a: number, p: any) => a + p.cents, 0))}</td><td className="num"><b>{fmtMoney(x.cashBalanceCents)}</b></td></tr>)}</tbody></table></div></>
          : <p className="muted">No daily reports yet. Each day, record who paid and the bank balance in the accounting system after the deposit. It takes a few minutes and tells the owner whether the day's cash is real.</p>}
        <p className="muted small">Entered by hand from the accounting system. It is an operating figure, not a reconciled balance, and it replaces the starting cash of the forecast until a newer balance sheet is imported.</p>
      </Card>
      {edit && <Drawer title="Daily cash report" onClose={() => setEdit(null)}>
        <Field label="Date"><input type="date" max={today()} value={edit.date} onChange={(e) => setEdit({ ...edit, date: e.target.value })} /></Field>
        <Field label="Who paid today">{edit.deposits.map((x: any, i: number) => <div className="row" key={i}><input placeholder="Customer" value={x.payer} onChange={(e) => setEdit({ ...edit, deposits: edit.deposits.map((y: any, j: number) => (j === i ? { ...y, payer: e.target.value } : y)) })} /><Money value={x.cents} onChange={(v) => setEdit({ ...edit, deposits: edit.deposits.map((y: any, j: number) => (j === i ? { ...y, cents: v ?? 0 } : y)) })} /></div>)}
          <button className="btn btn-sm" onClick={() => setEdit({ ...edit, deposits: [...edit.deposits, { payer: '', cents: 0 }] })}>Add a payment</button></Field>
        <Field label="Bank balance after the deposit" hint="The cash balance in the accounting system, not the bank's website."><Money value={edit.cashBalanceCents} onChange={(v) => setEdit({ ...edit, cashBalanceCents: v ?? 0 })} /></Field>
        <Field label="Owner paychecks missed to date" hint="Optional. Leave blank if owners have been paid."><Money nullable value={edit.missedOwnerPayCents} onChange={(v) => setEdit({ ...edit, missedOwnerPayCents: v })} /></Field>
        <label className="check"><input type="checkbox" checked={edit.withAging} onChange={(e) => setEdit({ ...edit, withAging: e.target.checked })} /> Update receivables aging (weekly)</label>
        {edit.withAging && AGING.map(([k, l]) => <Field key={k} label={l}><Money value={edit.aging[k]} onChange={(v) => setEdit({ ...edit, aging: { ...edit.aging, [k]: v ?? 0 } })} /></Field>)}
        <ErrorNote error={err} /><div className="row"><button className="btn btn-primary" onClick={save}>Save report</button><button className="btn" onClick={() => setEdit(null)}>Cancel</button></div>
      </Drawer>}
    </>; }}</Async>;
}
