// Capital and return on investment, and the ownership buy-in illustration (Crabtree ch. 7).
import React, { useEffect, useState } from 'react';
import { del, get, post, put } from './api.ts';
import { useT } from './App.tsx';
import { Card, ErrorNote, Field, Money, Note, Num, P, Pill, useLoad } from './ui.tsx';
import { fmtMoney, fmtPct } from '../engine/core.ts';
import { buyIn, defaultBuyIn, type BuyInInput } from '../engine/capital.ts';

const pct = (r: { value: number | null; reason?: string | null }) => (r.value === null ? 'N/A' : fmtPct(r.value, 1));

export function CapitalCard({ ms }: { ms: any[] }) {
  const cur = [...ms].reverse().find((m) => m.capital); if (!cur) return <Card title="Capital and return on investment"><p className="muted">Needs a balance sheet. Import one to see equity, debt and the return on the owners' investment.</p></Card>;
  const c = cur.capital;
  return <Card title="Capital and return on investment" right={<Pill>{P(cur.period)}</Pill>}>
    <div className="stat-grid">
      <div><span>Owners' equity (capital)</span><b>{fmtMoney(c.equityCents)}</b><small>What the business owns less what it owes</small></div>
      <div><span>True pretax profit, rolling 12</span><b>{cur.r12.complete ? fmtMoney(c.pretaxCents) : 'N/A'}</b><small>After owner pay at market wage</small></div>
      <div><span>Return on investment</span><b>{pct(c.returnOnEquity)}</b><small>{c.returnOnEquity.reason ?? 'Pretax profit ÷ equity'}</small></div>
      <div><span>Debt (not capital)</span><b>{fmtMoney(c.debtCents)}</b><small>Line of credit {fmtMoney(c.locCents)} · {c.debtToEquity.value === null ? 'debt to equity N/A' : `${c.debtToEquity.value.toFixed(2)}× equity`}</small></div>
      <div><span>Sweat equity (tracked)</span><b>{fmtMoney(c.sweatEquityCents)}</b><small>Unpaid market wages not yet returned</small></div>
    </div>
    {c.notes.map((n: string) => <Note key={n} tone="warn">{n}</Note>)}
    <p className="muted small">Capital comes from three places: profit kept in the business, money put in by owners or investors, and sweat equity. Borrowed money is shown beside capital, not inside it. A return of 50% or more a year is the book's benchmark for a small private business; treat it as that author's rule of thumb, not an industry statistic.</p>
  </Card>;
}

export function BuyInCard({ ms }: { ms: any[] }) {
  const t = useT(); const list = useLoad(() => get(`${t.base}/scenarios`), [t.tid]); const cur = [...ms].reverse().find((m) => m.capital);
  const [inp, setInp] = useState<BuyInInput | null>(null); const [id, setId] = useState<string | null>(null); const [open, setOpen] = useState(false); const [msg, setMsg] = useState<string | null>(null); const [err, setErr] = useState<string | null>(null);
  const base = () => defaultBuyIn(cur?.r12.complete ? cur.r12.adjustedPretax : 0, cur?.capital.equityCents ?? 0);
  useEffect(() => { const s = list.data?.scenarios.find((x: any) => x.type === 'buy_in'); if (s && !id) get(`${t.base}/scenarios/${s.id}`).then((x) => { setId(x.id); setInp(x.inputs); setOpen(true); }); }, [list.data]);
  const canWrite = t.can('scenario_write');
  if (!open) return <Card title="Ownership buy-in illustration" className="no-print"><p className="muted">Work out what a key employee's after-tax bonus would buy, and the return each owner would earn. Uses the formula value of average pretax profit × a multiple, plus equity.</p>{canWrite && <button className="btn" onClick={() => { setInp(base()); setOpen(true); }}>Start an illustration</button>}</Card>;
  if (!inp) return null;
  const r = buyIn(inp); const set = (p: Partial<BuyInInput>) => { setInp({ ...inp, ...p }); setMsg(null); };
  const save = async () => { setErr(null); try { const x = id ? await put(`${t.base}/scenarios/${id}`, { name: 'Ownership buy-in illustration', inputs: inp }) : await post(`${t.base}/scenarios`, { type: 'buy_in', name: 'Ownership buy-in illustration', inputs: inp }); setId(x.id); setMsg('Illustration saved.'); } catch (e) { setErr((e as Error).message); } };
  const remove = async () => { if (id) await del(`${t.base}/scenarios/${id}`); setId(null); setInp(null); setOpen(false); list.reload(); };
  return <Card title="Ownership buy-in illustration" right={<Pill tone="warn">Illustration — not a valuation</Pill>}>
    <div className="form-grid">
      <Field label="Average pretax profit" hint="True profit after market owner pay. Starts at the rolling 12 months."><Money value={inp.avgPretaxCents} onChange={(v) => set({ avgPretaxCents: v ?? 0 })} /></Field>
      <Field label="Owners' equity" hint="From the latest balance sheet."><Money value={inp.equityCents} onChange={(v) => set({ equityCents: v ?? 0 })} /></Field>
      <Field label="Profit multiple"><Num value={inp.profitMultiple} onChange={(v) => set({ profitMultiple: v ?? 0 })} min={0} max={20} step={0.5} suffix="×" /></Field>
      <Field label="Discount for a minority, hard-to-sell stake"><Num pct value={inp.discountPct} onChange={(v) => set({ discountPct: v ?? 0 })} min={0} max={95} step={5} /></Field>
      <Field label="Bonus before tax"><Money value={inp.grossBonusCents} onChange={(v) => set({ grossBonusCents: v ?? 0 })} /></Field>
      <Field label="Tax on the bonus"><Num pct value={inp.bonusTaxRate} onChange={(v) => set({ bonusTaxRate: v ?? 0 })} min={0} max={95} /></Field>
      <Field label="Shares outstanding"><Num value={inp.sharesOutstanding} onChange={(v) => set({ sharesOutstanding: v ?? 0 })} min={1} step={1000} /></Field>
      <Field label="Owner tax rate on profit"><Num pct value={inp.ownerTaxRate} onChange={(v) => set({ ownerTaxRate: v ?? 0 })} min={0} max={95} /></Field>
    </div>
    <div className="stat-grid">
      <div><span>Formula value of the business</span><b>{fmtMoney(r.businessValueCents)}</b><small>{inp.profitMultiple}× profit + equity</small></div>
      <div><span>Price per share</span><b>{fmtMoney(Math.round(r.pricePerShareCents))}</b><small>{fmtMoney(Math.round(r.discountedPriceCents))} after discount</small></div>
      <div><span>After-tax amount invested</span><b>{fmtMoney(r.netInvestmentCents)}</b><small>Buys {Math.round(r.sharesPurchased).toLocaleString('en-US')} new shares</small></div>
      <div><span>Buyer's ownership</span><b>{fmtPct(r.buyerOwnership, 2)}</b><small>Existing owners keep {fmtPct(r.original.ownership, 2)}</small></div>
    </div>
    <div className="tbl-wrap"><table className="tbl"><thead><tr><th></th><th className="num">Share of pretax profit</th><th className="num">Tax distribution</th><th className="num">Profit distribution</th><th className="num">Investment</th><th className="num">Return on investment</th></tr></thead><tbody>
      <tr><td>New owner</td><td className="num">{fmtMoney(r.buyer.profitCents)}</td><td className="num">{fmtMoney(r.buyer.taxDistributionCents)}</td><td className="num">{fmtMoney(r.buyer.profitDistributionCents)}</td><td className="num">{fmtMoney(r.netInvestmentCents)}</td><td className="num">{pct(r.buyer.roi)}</td></tr>
      <tr><td>Existing owners</td><td className="num">{fmtMoney(r.original.profitCents)}</td><td className="num">{fmtMoney(r.original.taxDistributionCents)}</td><td className="num">{fmtMoney(r.original.profitDistributionCents)}</td><td className="num">{fmtMoney(r.original.investmentCents)}</td><td className="num">{pct(r.original.roi)}</td></tr>
    </tbody></table></div>
    {r.cautions.map((c) => <p key={c} className="muted small">{c}</p>)}
    <ErrorNote error={err} />{msg && <Note tone="good">{msg}</Note>}
    {canWrite && <div className="row no-print"><button className="btn btn-primary" onClick={save}>Save illustration</button><button className="btn" onClick={() => set(base())}>Reset to current figures</button><button className="btn btn-ghost" onClick={remove}>{id ? 'Delete' : 'Close'}</button></div>}
  </Card>;
}
