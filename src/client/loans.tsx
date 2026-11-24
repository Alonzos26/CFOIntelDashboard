// Business Plan & Loans: is this client ready to qualify for an SBA loan, and the lender package that shows it.
// Every figure comes from src/engine/loans.ts; this file only collects inputs and lays out results.
import React, { useEffect, useMemo, useState } from 'react';
import { get, put } from './api.ts';
import { useT } from './App.tsx';
import { Async, Card, ErrorNote, Field, Money, Note, Num, Pill, dateLabel, useLoad } from './ui.tsx';
import { fmtMoney, fmtPct, fmtRatio } from '../engine/core.ts';
import {
  COLLATERAL_TYPES, ELIGIBILITY, LOAN_DOCS, LOAN_RULES, PLAN_MIN_CHARS, PLAN_SECTIONS, PROGRAMS, PROGRAM_KEYS, PURPOSE_LABELS, LOAN_PURPOSES,
  type BasisKey, type HistKey, type LoanHistory, type LoanInput, type LoanResult, type Tone, draftPlanSection, evaluateLoan,
} from '../engine/loans.ts';

interface LoanData { saved: boolean; updatedAt: string | null; updatedBy: string | null; input: LoanInput; history: LoanHistory; result: LoanResult; clientView: boolean }
const TABS: [string, string][] = [['ready', 'Readiness'], ['dscr', 'DSCR & cash flow'], ['request', 'Loan request & programs'], ['elig', 'Eligibility'], ['plan', 'Business plan'], ['docs', 'Documents'], ['package', 'Lender package']];
const pillTone = (t: Tone) => (t === 'good' ? 'good' : t === 'warn' ? 'warn' : 'bad') as 'good' | 'warn' | 'bad';
const cls = (ok: boolean | null) => (ok === null ? '' : ok ? 'good' : 'bad');

export function LoansPage() {
  const t = useT();
  const r = useLoad(() => get<LoanData>(`${t.base}/loans`), [t.tid]);
  return <Async r={r}>{(d) => <LoanWorkspace data={d} onSaved={r.reload} />}</Async>;
}

function LoanWorkspace({ data, onSaved }: { data: LoanData; onSaved: () => void }) {
  const t = useT(); const canEdit = t.can('scenario_write');
  const [tab, setTab] = useState(t.sub && TABS.some(([k]) => k === t.sub) ? t.sub : 'ready');
  const [input, setInput] = useState<LoanInput>(data.input); const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setInput(data.input); setDirty(false); }, [data]);
  const res = useMemo(() => evaluateLoan(input, data.history), [input, data.history]);
  const set = (patch: Partial<LoanInput>) => { setInput((x) => ({ ...x, ...patch })); setDirty(true); };
  const save = async () => { setBusy(true); setErr(null); try { await put(`${t.base}/loans`, { input }); onSaved(); } catch (x) { setErr((x as Error).message); } finally { setBusy(false); } };
  useEffect(() => { if (!dirty) return; const f = (e: BeforeUnloadEvent) => { e.preventDefault(); }; addEventListener('beforeunload', f); return () => removeEventListener('beforeunload', f); }, [dirty]);

  return <>
    <div className="page-h no-print">
      <div><h1>Business Plan &amp; Loans</h1>
        <p className="meta">Is the business ready to qualify for an SBA loan, and what will the lender see? Rules as of {LOAN_RULES.asOf}. {data.saved ? <>Last saved {dateLabel(data.updatedAt)}{data.updatedBy && <> by {data.updatedBy}</>}.</> : 'Not saved yet.'}</p></div>
      <div className="controls">
        {canEdit && <button className="btn btn-primary" disabled={(!dirty && data.saved) || busy} onClick={save}>{busy ? 'Saving…' : dirty || !data.saved ? 'Save changes' : 'Saved'}</button>}
        <button className="btn" onClick={() => setTab('package')}>Lender package</button>
      </div>
    </div>
    <ErrorNote error={err} />
    {data.clientView && <div className="no-print"><Note>Figures come from the months your advisor has approved{data.history.asOf ? <>, through {data.history.columns[2].label.replace('TTM ', '')}</> : ''}. This is a planning tool: the SBA lender makes the credit decision.</Note></div>}
    <div className="tabs no-print" role="tablist">{TABS.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}</div>
    <fieldset className="lr-fs" disabled={!canEdit && tab !== 'package' && tab !== 'ready'}>
      {tab === 'ready' && <Readiness i={input} r={res} go={setTab} />}
      {tab === 'dscr' && <Dscr i={input} r={res} h={data.history} set={set} />}
      {tab === 'request' && <Request i={input} r={res} set={set} />}
      {tab === 'elig' && <Checklist title="SBA eligibility and credit standards" hint="Items marked required are SBA eligibility tests: the loan cannot be guaranteed until each is met. The others strengthen the file." items={ELIGIBILITY} value={input.eligibility} onChange={(v) => set({ eligibility: v })} />}
      {tab === 'plan' && <Plan i={input} r={res} set={set} />}
      {tab === 'docs' && <Checklist title="SBA application documents" hint="The list follows the loan purpose. Lenders vary; this is the standard SBA package." items={LOAN_DOCS.filter((d) => !d.purposes || d.purposes.includes(input.purpose))} value={input.docs} onChange={(v) => set({ docs: v })} />}
    </fieldset>
    {tab === 'package' && <Package i={input} r={res} />}
    {!canEdit && tab !== 'package' && <p className="muted small no-print">Your role can view this workspace but not change it.</p>}
  </>;
}

// ---------------------------------------------------------------- readiness
function Ring({ score, tone }: { score: number; tone: Tone }) {
  const c = 2 * Math.PI * 54; const col = tone === 'good' ? 'var(--good)' : tone === 'warn' ? 'var(--warn)' : 'var(--bad)';
  return <svg width="132" height="132" viewBox="0 0 132 132" role="img" aria-label={`Readiness score ${score} of 100`}>
    <circle cx="66" cy="66" r="54" fill="none" stroke="var(--line-2)" strokeWidth="12" />
    <circle cx="66" cy="66" r="54" fill="none" stroke={col} strokeWidth="12" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - score / 100)} transform="rotate(-90 66 66)" />
    <text x="66" y="66" textAnchor="middle" fontSize="32" fontWeight="700" fill="var(--ink)">{score}</text>
    <text x="66" y="86" textAnchor="middle" fontSize="12" fill="var(--muted)">of 100</text></svg>;
}
function Stat({ k, v, s, tone }: { k: string; v: React.ReactNode; s?: React.ReactNode; tone?: string }) {
  return <div className="kpi static"><span className="kpi-l">{k}</span><span className={`kpi-v ${tone ?? ''}`}>{v}</span>{s && <span className="kpi-m muted">{s}</span>}</div>;
}
function Readiness({ i, r, go }: { i: LoanInput; r: LoanResult; go: (k: string) => void }) {
  const rec = r.recommended ? PROGRAMS[r.recommended].name : null;
  return <>
    <Card>
      <div className="lr-score">
        <Ring score={r.score} tone={r.status.tone} />
        <div style={{ flex: 1, minWidth: 240 }}>
          <Pill tone={pillTone(r.status.tone)}>{r.status.label}</Pill>
          <h2 style={{ margin: '8px 0 4px' }}>{fmtMoney(i.amountCents)} {PROGRAMS[i.program].name} for {PURPOSE_LABELS[i.purpose].toLowerCase()}</h2>
          <p className="muted small">{rec && <>Best-fit program for this request: <b>{rec}</b>. </>}Coverage rule applied: {r.rule.why}</p>
          <div className="lr-parts">{r.parts.map(([l, v, m]) => <div key={l}><div className="lr-part-h"><span>{l}</span><span>{Math.round(v)}/{m}</span></div><span className="fbar"><b style={{ width: `${Math.max(0, Math.min(100, (v / m) * 100))}%` }} /></span></div>)}</div>
        </div>
      </div>
    </Card>
    <div className="kpis">
      <Stat k="Business DSCR" v={fmtRatio(r.dscr)} tone={cls(r.dscr === null ? null : r.dscr >= r.rule.target)} s={<>Needs {fmtRatio(r.rule.target)} · {r.basis.label}</>} />
      <Stat k="Global DSCR" v={fmtRatio(r.global.dscr)} tone={cls(r.global.dscr === null ? null : r.global.dscr >= LOAN_RULES.globalDscrTarget)} s={<>Business and guarantors · target {fmtRatio(LOAN_RULES.globalDscrTarget)}</>} />
      <Stat k="Largest loan cash flow supports" v={fmtMoney(r.maxLoanCents, { compact: true })} s={<>At {fmtRatio(r.rule.target)}, {fmtPct(i.rate, 2)}, {i.termYears} years</>} />
      <Stat k="Cash-flow cushion" v={fmtPct(r.cushion, 0)} tone={cls(r.cushion === null ? null : r.cushion >= 0)} s="How far EBITDA can fall before coverage fails" />
      <Stat k="New loan payment" v={<>{fmtMoney(r.newMonthlyCents)}<span className="muted small">/mo</span></>} s={<>{fmtMoney(r.newAnnualCents)} a year</>} />
      <Stat k="Equity injection" v={r.equity.pct ? fmtPct(r.equity.pct, 0) : 'Lender policy'} tone={cls(r.equity.met)} s={r.equity.pct ? <>{fmtMoney(r.equity.countedCents)} of {fmtMoney(r.equity.requiredCents)} needed</> : 'No SBA minimum for this request'} />
      <Stat k="Collateral coverage" v={fmtPct(r.collateral.coverage, 0)} tone={r.collateral.coverage !== null && r.collateral.coverage >= 1 ? 'good' : ''} s={<>{fmtMoney(r.collateral.lendableCents)} lendable value</>} />
      <Stat k="Package completeness" v={`${r.docs.done}/${r.docs.applicable.length}`} s={<>Documents · plan {r.plan.done}/{r.plan.total} sections</>} />
    </div>
    <Card title="What stands between this client and an approval">
      {r.gaps.length ? <ul className="plain">{r.gaps.map((g, k) => <li key={k}><Pill tone={pillTone(g.tone)}>{g.tone === 'bad' ? 'Fix' : 'Improve'}</Pill> {g.text}</li>)}</ul> : <p className="good">No open items. Open the lender package.</p>}
      <div className="row"><button className="btn btn-sm" onClick={() => go('dscr')}>Cash flow</button><button className="btn btn-sm" onClick={() => go('request')}>Loan request</button><button className="btn btn-sm" onClick={() => go('elig')}>Eligibility</button><button className="btn btn-sm" onClick={() => go('plan')}>Business plan</button></div>
    </Card>
  </>;
}

// ---------------------------------------------------------------- DSCR
function Dscr({ i, r, h, set }: { i: LoanInput; r: LoanResult; h: LoanHistory; set: (p: Partial<LoanInput>) => void }) {
  const hc = (k: HistKey) => h.columns.find((c) => c.key === k)!;
  const basisOpts: [BasisKey, string][] = [['fy_last', `Last fiscal year (${hc('fy_last').label})`], ['avg2', 'Two-year average'], ['ttm', `Trailing twelve months (${hc('ttm').label})`], ['proj', `Projected (${i.projection.label})`]];
  const debts = i.debts; const setDebt = (k: number, p: Partial<LoanInput['debts'][number]>) => set({ debts: debts.map((d, j) => (j === k ? { ...d, ...p } : d)) });
  const g = i.guarantor; const setG = (p: Partial<LoanInput['guarantor']>) => set({ guarantor: { ...g, ...p } });
  return <>
    <Note><b>SBA method.</b> DSCR = EBITDA ÷ required principal and interest on <i>all</i> business debt, including the new loan. {r.rule.why}</Note>
    <Card title="Earnings available for debt service (EBITDA)" right={<span className="muted small">Imported columns come from {h.asOf ? 'the financials on file' : 'no imported data yet'}</span>}>
      <div className="tbl-wrap"><table className="tbl">
        <thead><tr><th></th>{r.columns.map((c) => <th key={c.key} className="num">{c.label}<div className="sub">{c.source === 'imported' ? `${c.months} mo imported${c.complete ? '' : ' (partial)'}` : c.source === 'entered' ? 'Entered' : 'No data'}</div></th>)}</tr></thead>
        <tbody>
          <tr><td>Revenue</td>{r.columns.map((c) => <td key={c.key} className="num">{c.key === 'proj' ? <Money value={i.projection.revenueCents} onChange={(v) => set({ projection: { ...i.projection, revenueCents: v ?? 0 } })} /> : hc(c.key as HistKey).months ? fmtMoney(c.revenueCents) : <Money value={i.manual[c.key as HistKey].revenueCents} onChange={(v) => set({ manual: { ...i.manual, [c.key]: { ...i.manual[c.key as HistKey], revenueCents: v ?? 0 } } })} />}</td>)}</tr>
          <tr><td>Pretax profit (as reported)</td>{r.columns.map((c) => <td key={c.key} className="num muted">{c.key !== 'proj' && hc(c.key as HistKey).months ? fmtMoney(hc(c.key as HistKey).pretaxCents) : '—'}</td>)}</tr>
          <tr><td>+ Interest expense</td>{r.columns.map((c) => <td key={c.key} className="num muted">{c.key !== 'proj' && hc(c.key as HistKey).months ? fmtMoney(hc(c.key as HistKey).interestCents) : '—'}</td>)}</tr>
          <tr><td>+ Depreciation and amortization</td>{r.columns.map((c) => <td key={c.key} className="num muted">{c.key !== 'proj' && hc(c.key as HistKey).months ? fmtMoney(hc(c.key as HistKey).depreciationCents) : '—'}</td>)}</tr>
          <tr><td>+ One-time add-backs</td>{r.columns.map((c) => <td key={c.key} className="num">{c.key === 'proj' ? '—' : <Money value={i.addbacks[c.key as HistKey]} onChange={(v) => set({ addbacks: { ...i.addbacks, [c.key]: v ?? 0 } })} />}</td>)}</tr>
          <tr className="tot"><td>EBITDA</td>{r.columns.map((c) => <td key={c.key} className="num">{(c.key === 'proj' || !hc(c.key as HistKey).months) ? <Money value={c.key === 'proj' ? i.projection.ebitdaCents : i.manual[c.key as HistKey].ebitdaCents} onChange={(v) => c.key === 'proj' ? set({ projection: { ...i.projection, ebitdaCents: v ?? 0 } }) : set({ manual: { ...i.manual, [c.key]: { ...i.manual[c.key as HistKey], ebitdaCents: v ?? 0 } } })} /> : fmtMoney(c.ebitdaCents)}</td>)}</tr>
          <tr><td>DSCR on the proposed debt</td>{r.columns.map((c) => <td key={c.key} className={`num ${cls(c.dscr === null ? null : c.dscr >= r.rule.target)}`}><b>{fmtRatio(c.dscr)}</b></td>)}</tr>
        </tbody></table></div>
      <p className="muted small">Pretax profit is as reported, before the owner-pay normalization, because lenders underwrite the books and tax returns. Owner salary already in the P&amp;L should not also be added back. Where a column has no imported months, enter revenue and EBITDA by hand (EBITDA there excludes add-backs, which are added on top).</p>
      <div className="form-grid">
        <Field label="Underwriting basis" hint={r.basis.note ?? `Using ${r.basis.label}.`}><select value={i.basis} onChange={(e) => set({ basis: e.target.value as BasisKey })}>{basisOpts.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        <Field label="Projected column label"><input value={i.projection.label} maxLength={60} onChange={(e) => set({ projection: { ...i.projection, label: e.target.value } })} /></Field>
        <Field label="Add-back explanation (lenders will ask)"><input value={i.addbackNote} maxLength={1000} onChange={(e) => set({ addbackNote: e.target.value })} /></Field>
      </div>
    </Card>
    <Card title="Existing business debt" right={<button className="btn btn-sm" onClick={() => set({ debts: [...debts, { name: '', balanceCents: 0, monthlyCents: 0, refinanced: false }] })}>Add debt</button>}>
      <p className="muted small">{h.debtBalanceCents !== null && <>The balance sheet for {h.debtBalanceAsOf} shows {fmtMoney(h.debtBalanceCents)} of notes and line of credit. </>}Tick <b>Refinanced</b> for any debt this loan pays off; it drops out of debt service.</p>
      {debts.length ? <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Lender / description</th><th className="num">Balance</th><th className="num">Monthly P&amp;I</th><th>Refinanced</th><th></th></tr></thead><tbody>
        {debts.map((d, k) => <tr key={k}><td><input value={d.name} maxLength={200} onChange={(e) => setDebt(k, { name: e.target.value })} aria-label="Debt description" /></td><td className="num"><Money value={d.balanceCents} onChange={(v) => setDebt(k, { balanceCents: v ?? 0 })} /></td><td className="num"><Money value={d.monthlyCents} onChange={(v) => setDebt(k, { monthlyCents: v ?? 0 })} /></td><td><input type="checkbox" checked={d.refinanced} onChange={(e) => setDebt(k, { refinanced: e.target.checked })} aria-label="Refinanced by this loan" /></td><td><button className="btn btn-ghost btn-sm" onClick={() => set({ debts: debts.filter((_, j) => j !== k) })}>Remove</button></td></tr>)}
      </tbody></table></div> : <p className="muted">No other business debt entered.</p>}
    </Card>
    <div className="grid-2">
      <Card title="Business DSCR">
        <table className="tbl"><tbody>
          <tr><td>EBITDA, {r.basis.label}</td><td className="num">{fmtMoney(r.basis.ebitdaCents)}</td></tr>
          <tr><td>Proposed loan P&amp;I ({fmtMoney(i.amountCents)}, {fmtPct(i.rate, 2)}, {i.termYears} yrs)</td><td className="num">{fmtMoney(r.newAnnualCents)}</td></tr>
          <tr><td>Existing debt P&amp;I (not refinanced)</td><td className="num">{fmtMoney(r.existingAnnualCents)}</td></tr>
          <tr className="tot"><td>Total annual debt service</td><td className="num">{fmtMoney(r.debtServiceCents)}</td></tr>
          <tr><td><b>DSCR</b></td><td className={`num ${cls(r.dscr === null ? null : r.dscr >= r.rule.target)}`}><b>{fmtRatio(r.dscr)}</b> <span className="muted">needs {fmtRatio(r.rule.target)}</span></td></tr>
          <tr><td>Largest loan supportable at {fmtRatio(r.rule.target)}</td><td className="num">{fmtMoney(r.maxLoanCents)}</td></tr>
          <tr><td>EBITDA drop before coverage fails</td><td className="num">{fmtPct(r.cushion, 0)}</td></tr>
        </tbody></table>
      </Card>
      <Card title="Global cash flow (business and guarantors)">
        <div className="form-grid">
          <Field label="Guarantors' after-tax income" hint="Wages or K-1 from the business and outside income"><Money value={g.incomeCents} onChange={(v) => setG({ incomeCents: v ?? 0 })} /></Field>
          <Field label="Living expenses, per year"><Money value={g.livingCents} onChange={(v) => setG({ livingCents: v ?? 0 })} /></Field>
          <Field label="Personal debt payments, per month" hint="Mortgage, auto, cards"><Money value={g.debtMonthlyCents} onChange={(v) => setG({ debtMonthlyCents: v ?? 0 })} /></Field>
          <Field label="Lowest credit score among 20%+ owners"><Num value={g.creditScore} nullable min={300} max={850} onChange={(v) => setG({ creditScore: v === null ? null : Math.round(v) })} /></Field>
          <Field label="Personal liquid assets"><Money value={g.liquidCents} onChange={(v) => setG({ liquidCents: v ?? 0 })} /></Field>
        </div>
        <table className="tbl"><tbody>
          <tr><td>Global cash available</td><td className="num">{fmtMoney(r.global.cashCents)}</td></tr>
          <tr><td>Global debt service</td><td className="num">{fmtMoney(r.global.debtServiceCents)}</td></tr>
          <tr className="tot"><td>Global DSCR</td><td className={`num ${cls(r.global.dscr === null ? null : r.global.dscr >= LOAN_RULES.globalDscrTarget)}`}>{fmtRatio(r.global.dscr)}</td></tr>
        </tbody></table>
      </Card>
    </div>
  </>;
}

// ---------------------------------------------------------------- request, programs, sources & uses, collateral
function Request({ i, r, set }: { i: LoanInput; r: LoanResult; set: (p: Partial<LoanInput>) => void }) {
  const setUse = (k: number, p: Partial<LoanInput['uses'][number]>) => set({ uses: i.uses.map((u, j) => (j === k ? { ...u, ...p } : u)) });
  const setColl = (k: number, p: Partial<LoanInput['collateral'][number]>) => set({ collateral: i.collateral.map((c, j) => (j === k ? { ...c, ...p } : c)) });
  const balanced = r.totalSourcesCents === r.totalUsesCents;
  return <>
    <Card title="Loan request">
      <div className="form-grid">
        <Field label="Primary purpose"><select value={i.purpose} onChange={(e) => set({ purpose: e.target.value as LoanInput['purpose'] })}>{LOAN_PURPOSES.map((p) => <option key={p} value={p}>{PURPOSE_LABELS[p]}</option>)}</select></Field>
        <Field label="Program"><select value={i.program} onChange={(e) => set({ program: e.target.value as LoanInput['program'] })}>{PROGRAM_KEYS.map((k) => <option key={k} value={k}>{PROGRAMS[k].name}</option>)}</select></Field>
        <Field label="Loan amount"><Money value={i.amountCents} onChange={(v) => set({ amountCents: v ?? 0 })} /></Field>
        <Field label="Rate type"><select value={i.rateType} onChange={(e) => set({ rateType: e.target.value as 'variable' | 'fixed' })}><option value="variable">Variable (Prime-based)</option><option value="fixed">Fixed</option></select></Field>
        <Field label="Lender-quoted rate" hint={r.rateCap !== null ? <>SBA maximum for this size: <b className={i.rate > r.rateCap + 1e-9 ? 'bad' : ''}>{fmtPct(r.rateCap, 2)}</b> (Prime {fmtPct(LOAN_RULES.primeRate, 2)})</> : undefined}><Num value={i.rate} pct step={0.25} onChange={(v) => set({ rate: v ?? 0 })} /></Field>
        <Field label="Term (years)"><Num value={i.termYears} min={1} max={30} onChange={(v) => set({ termYears: Math.max(1, Math.round(v ?? 1)) })} /></Field>
        <Field label="Years in business"><Num value={i.yearsInBusiness} min={0} onChange={(v) => set({ yearsInBusiness: Math.max(0, Math.round(v ?? 0)) })} /></Field>
      </div>
      <label className="chk"><input type="checkbox" checked={i.specialPurposeProperty} onChange={(e) => set({ specialPurposeProperty: e.target.checked })} /> Special-purpose property (504 adds 5% equity)</label>
    </Card>
    <Card title="Program fit">
      <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Program</th><th>Fit</th><th className="num">Maximum</th><th className="num">SBA guaranty</th><th className="num">Maximum rate</th><th className="num">Maximum term</th><th className="num">Est. payment</th><th>Notes</th></tr></thead><tbody>
        {r.programs.map((p) => <tr key={p.key}>
          <td><b>{p.name}</b>{r.recommended === p.key && <> <Pill tone="good">Best fit</Pill></>}</td>
          <td style={{ minWidth: 200 }}>{p.fit ? <Pill tone="good">Eligible</Pill> : <><Pill tone="bad">No</Pill><div className="sub">{p.issues.join('; ')}</div></>}</td>
          <td className="num">{p.key === 'cdc504' ? '$5.5M SBA portion' : fmtMoney(PROGRAMS[p.key].maxCents)}</td>
          <td className="num">{p.guaranty !== null ? <>{fmtPct(p.guaranty, 0)}<div className="sub">{fmtMoney(p.guaranteedCents)}</div></> : p.key === 'cdc504' ? '40% debenture' : '—'}</td>
          <td className="num">{p.maxRate !== null ? fmtPct(p.maxRate, 2) : p.key === 'cdc504' ? 'Fixed, Treasury-based' : 'Intermediary'}</td>
          <td className="num">{p.maxTermYears} yrs</td>
          <td className="num">{fmtMoney(p.monthlyCents)}/mo</td>
          <td className="sub" style={{ minWidth: 220 }}>{p.note}</td></tr>)}
      </tbody></table></div>
    </Card>
    <div className="grid-2">
      <Card title="Sources and uses" right={<button className="btn btn-sm" onClick={() => set({ uses: [...i.uses, { description: '', amountCents: 0 }] })}>Add use</button>}>
        <table className="tbl"><thead><tr><th>Use of proceeds</th><th className="num">Amount</th><th></th></tr></thead><tbody>
          {i.uses.map((u, k) => <tr key={k}><td><input value={u.description} maxLength={300} onChange={(e) => setUse(k, { description: e.target.value })} aria-label="Use of proceeds" /></td><td className="num"><Money value={u.amountCents} onChange={(v) => setUse(k, { amountCents: v ?? 0 })} /></td><td><button className="btn btn-ghost btn-sm" onClick={() => set({ uses: i.uses.filter((_, j) => j !== k) })}>Remove</button></td></tr>)}
          <tr className="tot"><td>Total project cost</td><td className="num">{fmtMoney(r.totalUsesCents)}</td><td></td></tr>
        </tbody></table>
        <h4>Sources</h4>
        <table className="tbl"><tbody>
          <tr><td>SBA loan</td><td className="num">{fmtMoney(i.amountCents)}</td></tr>
          <tr><td>Owner cash equity</td><td className="num"><Money value={i.sources.equityCents} onChange={(v) => set({ sources: { ...i.sources, equityCents: v ?? 0 } })} /></td></tr>
          <tr><td>Seller note on full standby (acquisitions)</td><td className="num"><Money value={i.sources.sellerStandbyCents} onChange={(v) => set({ sources: { ...i.sources, sellerStandbyCents: v ?? 0 } })} /></td></tr>
          <tr><td>Other (grants, investors)</td><td className="num"><Money value={i.sources.otherCents} onChange={(v) => set({ sources: { ...i.sources, otherCents: v ?? 0 } })} /></td></tr>
          <tr className="tot"><td>Total sources</td><td className={`num ${balanced ? 'good' : 'bad'}`}>{fmtMoney(r.totalSourcesCents)}</td></tr>
        </tbody></table>
        <button className="btn btn-sm" onClick={() => set({ amountCents: Math.max(0, r.totalUsesCents - i.sources.equityCents - i.sources.sellerStandbyCents - i.sources.otherCents) })}>Set loan to uses less other sources</button>
      </Card>
      <div>
        <Card title="Equity injection">
          <p className="muted small">{r.equity.why}</p>
          <table className="tbl"><tbody>
            <tr><td>Required</td><td className="num">{r.equity.pct ? <>{fmtMoney(r.equity.requiredCents)} ({fmtPct(r.equity.pct, 0)})</> : 'No SBA minimum'}</td></tr>
            <tr><td>Counts toward it{r.equity.sellerCountedCents ? <> (incl. {fmtMoney(r.equity.sellerCountedCents)} seller standby, capped at half)</> : ''}</td><td className="num">{fmtMoney(r.equity.countedCents)}</td></tr>
            <tr className="tot"><td>Status</td><td className="num"><Pill tone={r.equity.met ? 'good' : 'bad'}>{r.equity.met ? 'Met' : `Short ${fmtMoney(r.equity.requiredCents - r.equity.countedCents)}`}</Pill></td></tr>
          </tbody></table>
        </Card>
        <Card title="Collateral" right={<button className="btn btn-sm" onClick={() => set({ collateral: [...i.collateral, { type: 'Equipment / vehicles', description: '', valueCents: 0 }] })}>Add</button>}>
          {i.collateral.length ? <table className="tbl"><thead><tr><th>Type</th><th>Description</th><th className="num">Market value</th><th className="num">Lendable</th><th></th></tr></thead><tbody>
            {r.collateral.rows.map((c, k) => <tr key={k}><td><select value={c.type} onChange={(e) => setColl(k, { type: e.target.value })} aria-label="Collateral type">{Object.keys(COLLATERAL_TYPES).map((x) => <option key={x}>{x}</option>)}</select></td><td><input value={c.description} maxLength={300} onChange={(e) => setColl(k, { description: e.target.value })} aria-label="Collateral description" /></td><td className="num"><Money value={c.valueCents} onChange={(v) => setColl(k, { valueCents: v ?? 0 })} /></td><td className="num">{fmtMoney(c.lendableCents)}<div className="sub">{fmtPct(c.advanceRate, 0)}</div></td><td><button className="btn btn-ghost btn-sm" onClick={() => set({ collateral: i.collateral.filter((_, j) => j !== k) })}>Remove</button></td></tr>)}
            <tr className="tot"><td colSpan={3}>Lendable value, share of the loan</td><td className="num">{fmtMoney(r.collateral.lendableCents)}<div className="sub">{fmtPct(r.collateral.coverage, 0)}</div></td><td></td></tr>
          </tbody></table> : <p className="muted">No collateral entered.</p>}
          <p className="muted small">Advance rates are typical lender haircuts, not SBA rules.</p>
        </Card>
      </div>
    </div>
  </>;
}

// ---------------------------------------------------------------- checklists and plan
function Checklist({ title, hint, items, value, onChange }: { title: string; hint: string; items: typeof ELIGIBILITY; value: Record<string, boolean>; onChange: (v: Record<string, boolean>) => void }) {
  const done = items.filter((x) => value[x.key]).length;
  return <Card title={title} right={<Pill tone={done === items.length ? 'good' : 'warn'}>{done}/{items.length}</Pill>}>
    <p className="muted small">{hint}</p>
    {items.map((x) => <label key={x.key} className="lr-check"><input type="checkbox" checked={!!value[x.key]} onChange={(e) => onChange({ ...value, [x.key]: e.target.checked })} />
      <span><b>{x.label}</b>{x.required && <> <Pill>Required</Pill></>}<span className="sub">{x.detail}</span></span></label>)}
  </Card>;
}
function Plan({ i, r, set }: { i: LoanInput; r: LoanResult; set: (p: Partial<LoanInput>) => void }) {
  const t = useT();
  const draft = (k: 'company' | 'uses' | 'fin') => { if ((i.plan[k] ?? '').trim() && !confirm('Replace the text in this section with a fresh draft?')) return; set({ plan: { ...i.plan, [k]: draftPlanSection(k, i, r, t.tenant.name) } }); };
  return <>
    <Note>Sections follow what SBA lenders expect. {r.plan.done} of {r.plan.total} complete (at least {PLAN_MIN_CHARS} characters each). Three sections can start from the figures already entered.</Note>
    {PLAN_SECTIONS.map((s) => { const len = (i.plan[s.key] ?? '').trim().length; return <Card key={s.key} title={s.label} right={<>{len >= PLAN_MIN_CHARS ? <Pill tone="good">Complete</Pill> : <Pill>{len ? 'Draft' : 'Empty'}</Pill>}{(s.key === 'company' || s.key === 'uses' || s.key === 'fin') && <> <button className="btn btn-sm" onClick={() => draft(s.key as 'company' | 'uses' | 'fin')}>Draft from figures</button></>}</>}>
      <p className="muted small">{s.detail}</p>
      <textarea rows={5} value={i.plan[s.key] ?? ''} maxLength={20000} placeholder={s.detail} onChange={(e) => set({ plan: { ...i.plan, [s.key]: e.target.value } })} aria-label={s.label} />
    </Card>; })}
  </>;
}

// ---------------------------------------------------------------- lender package (print to PDF)
function Package({ i, r }: { i: LoanInput; r: LoanResult }) {
  const t = useT(); const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const src: [string, number][] = ([['SBA loan', i.amountCents], ['Owner equity', i.sources.equityCents], ['Seller note (standby)', i.sources.sellerStandbyCents], ['Other', i.sources.otherCents]] as [string, number][]).filter(([, v]) => v > 0);
  const rows = Math.max(i.uses.length, src.length);
  const docs = LOAN_DOCS.filter((d) => r.docs.applicable.includes(d.key));
  return <div className="report">
    <div className="page-h no-print"><p className="muted">Print or save as PDF and send it with SBA Forms 1919 and 413. Save first so the package matches the stored workspace.</p><div className="controls"><button className="btn btn-primary" onClick={() => window.print()}>Download PDF (print)</button></div></div>
    <Card>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}><h1>{t.tenant.name}</h1><p className="meta">SBA loan request and business plan · Prepared {today}</p></div>
        <div style={{ textAlign: 'right' }}><div className="lbl">Readiness</div><div className="big">{r.score}/100</div><div className="muted small">{r.status.label}</div></div>
      </div>

      <section><h3>1. Loan request</h3>
        <table className="tbl"><tbody>
          <tr><td>Program</td><td>{PROGRAMS[i.program].name}</td><td>Amount</td><td className="num">{fmtMoney(i.amountCents)}</td></tr>
          <tr><td>Purpose</td><td>{PURPOSE_LABELS[i.purpose]}</td><td>Term</td><td className="num">{i.termYears} years</td></tr>
          <tr><td>Rate (quoted)</td><td>{fmtPct(i.rate, 2)} {i.rateType}{r.rateCap !== null && <> (SBA maximum {fmtPct(r.rateCap, 2)})</>}</td><td>Estimated payment</td><td className="num">{fmtMoney(r.newMonthlyCents)}/mo</td></tr>
        </tbody></table>
        <h4>Sources and uses</h4>
        <table className="tbl"><thead><tr><th>Uses</th><th className="num">Amount</th><th>Sources</th><th className="num">Amount</th></tr></thead><tbody>
          {Array.from({ length: rows }, (_, k) => <tr key={k}><td>{i.uses[k]?.description ?? ''}</td><td className="num">{i.uses[k] ? fmtMoney(i.uses[k].amountCents) : ''}</td><td>{src[k]?.[0] ?? ''}</td><td className="num">{src[k] ? fmtMoney(src[k][1]) : ''}</td></tr>)}
          <tr className="tot"><td>Total</td><td className="num">{fmtMoney(r.totalUsesCents)}</td><td>Total</td><td className="num">{fmtMoney(r.totalSourcesCents)}</td></tr>
        </tbody></table>
      </section>

      <section><h3>2. Repayment ability</h3>
        <table className="tbl"><thead><tr><th></th>{r.columns.filter((c) => c.source !== 'none').map((c) => <th key={c.key} className="num">{c.label}</th>)}</tr></thead><tbody>
          <tr><td>Revenue</td>{r.columns.filter((c) => c.source !== 'none').map((c) => <td key={c.key} className="num">{fmtMoney(c.revenueCents)}</td>)}</tr>
          <tr><td>One-time add-backs</td>{r.columns.filter((c) => c.source !== 'none').map((c) => <td key={c.key} className="num">{fmtMoney(c.addbackCents)}</td>)}</tr>
          <tr className="tot"><td>EBITDA</td>{r.columns.filter((c) => c.source !== 'none').map((c) => <td key={c.key} className="num">{fmtMoney(c.ebitdaCents)}</td>)}</tr>
          <tr><td>Total debt service</td>{r.columns.filter((c) => c.source !== 'none').map((c) => <td key={c.key} className="num">{fmtMoney(r.debtServiceCents)}</td>)}</tr>
          <tr><td><b>DSCR</b></td>{r.columns.filter((c) => c.source !== 'none').map((c) => <td key={c.key} className="num"><b>{fmtRatio(c.dscr)}</b></td>)}</tr>
        </tbody></table>
        {i.addbackNote && <p className="muted small">Add-backs: {i.addbackNote}</p>}
        <table className="tbl"><tbody>
          <tr><td>Underwriting basis</td><td>{r.basis.label}</td></tr>
          <tr><td>Requirement</td><td>{fmtRatio(r.rule.target)}: {r.rule.why}</td></tr>
          <tr><td>Business DSCR</td><td><b>{fmtRatio(r.dscr)}</b> ({fmtMoney(r.basis.ebitdaCents)} ÷ {fmtMoney(r.debtServiceCents)}){r.dscr !== null && <>, {r.dscr >= r.rule.target ? 'meets the requirement' : 'below the requirement'}</>}</td></tr>
          <tr><td>Global DSCR</td><td>{r.global.dscr === null ? 'Not measured: guarantor income and obligations not entered' : <>{fmtRatio(r.global.dscr)} ({fmtMoney(r.global.cashCents)} ÷ {fmtMoney(r.global.debtServiceCents)})</>}</td></tr>
          <tr><td>Other business debt</td><td>{i.debts.length ? i.debts.map((d, k) => <div key={k}>{d.name || 'Debt'}: {fmtMoney(d.balanceCents)} balance, {fmtMoney(d.monthlyCents)}/mo{d.refinanced ? ', refinanced by this loan' : ''}</div>) : 'None'}</td></tr>
        </tbody></table>
      </section>

      <section><h3>3. Equity, collateral and guarantees</h3>
        <table className="tbl"><tbody>
          <tr><td>Equity injection</td><td>{r.equity.pct ? <>{fmtMoney(r.equity.countedCents)} of {fmtMoney(r.equity.requiredCents)} required ({fmtPct(r.equity.pct, 0)}): {r.equity.met ? 'met' : 'short'}</> : 'No SBA-mandated injection; lender policy'}</td></tr>
          {r.collateral.rows.map((c, k) => <tr key={k}><td>Collateral: {c.type}</td><td>{c.description || '—'}: {fmtMoney(c.valueCents)} market, {fmtMoney(c.lendableCents)} lendable</td></tr>)}
          <tr><td>Collateral coverage</td><td>{fmtPct(r.collateral.coverage, 0)} of the loan</td></tr>
          <tr><td>Personal guarantees</td><td>{i.eligibility.guarantee ? 'All 20%+ owners will guarantee' : 'Not yet confirmed'}</td></tr>
          <tr><td>Guarantor credit and liquidity</td><td>Score {i.guarantor.creditScore ?? 'not entered'} · Liquid assets {fmtMoney(i.guarantor.liquidCents)}</td></tr>
        </tbody></table>
      </section>

      <section><h3>4. Eligibility</h3>
        <ul className="plain lr-list">{ELIGIBILITY.map((e) => <li key={e.key}>{i.eligibility[e.key] ? '☑' : '☐'} {e.label}{e.required ? ' *' : ''}</li>)}</ul>
        <p className="muted small">* SBA eligibility requirement</p>
      </section>

      <section><h3>5. Business plan</h3>
        {PLAN_SECTIONS.map((s) => <div key={s.key} className="lr-plan"><h4>{s.label}</h4><p>{(i.plan[s.key] ?? '').trim() || '— To be completed —'}</p></div>)}
      </section>

      <section><h3>6. Documents</h3>
        <ul className="plain lr-list">{docs.map((d) => <li key={d.key}>{i.docs[d.key] ? '☑' : '☐'} {d.label}</li>)}</ul>
      </section>

      {r.gaps.length > 0 && <section><h3>7. Open items</h3><ul className="plain">{r.gaps.map((g, k) => <li key={k}>{g.text}</li>)}</ul></section>}

      <p className="muted small" style={{ marginTop: 18 }}>A planning and pre-qualification summary, not a commitment to lend. Final eligibility, terms and credit decisions rest with the SBA lender or CDC. Rule basis ({LOAN_RULES.asOf}): {LOAN_RULES.sources.join('; ')}. SBA 7(a) maximum rates use Prime of {fmtPct(LOAN_RULES.primeRate, 2)}. Imported figures are unaudited.</p>
    </Card>
  </div>;
}
