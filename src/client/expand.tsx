// Expand a management line into the accounts behind it, and collapse it again, without leaving the table.
import React, { useState } from 'react';
import { get } from './api.ts';
import { useT } from './App.tsx';

export interface Acct { id: string; name: string; byMonth: Record<string, number> }
export interface Expand { open: Set<string>; toggle: (k: string) => void; setAll: (keys: string[], on: boolean) => void; accounts: (line: string) => Acct[]; ready: boolean }
/** Account detail is fetched once, the first time anything is expanded. */
export function useExpand(): Expand {
  const t = useT(); const [open, setOpen] = useState<Set<string>>(new Set()); const [data, setData] = useState<any>(null); const [asked, setAsked] = useState(false);
  const ensure = () => { if (!asked) { setAsked(true); get(`${t.base}/financials/accounts`).then(setData).catch(() => setData({ lines: {} })); } };
  return { open, ready: !!data, accounts: (line) => data?.lines?.[line] ?? [],
    toggle: (k) => { ensure(); setOpen((p) => { const n = new Set(p); if (n.has(k)) n.delete(k); else n.add(k); return n; }); }, setAll: (keys, on) => { if (on) ensure(); setOpen(new Set(on ? keys : [])); } };
}
export const sumAcct = (a: Acct, periods: string[]) => periods.reduce((s, p) => s + (a.byMonth[p] ?? 0), 0);
export function Toggle({ ex, k, children }: { ex: Expand; k: string; children: React.ReactNode }) {
  const on = ex.open.has(k); return <button className="xp" aria-expanded={on} title={on ? 'Hide the accounts in this line' : 'Show the accounts in this line'} onClick={() => ex.toggle(k)}><span aria-hidden="true" className="xp-i">{on ? '▾' : '▸'}</span>{children}</button>;
}
export function ExpandAll({ ex, keys }: { ex: Expand; keys: string[] }) {
  const any = keys.some((k) => ex.open.has(k)); return <button className="btn btn-sm no-print" onClick={() => ex.setAll(keys, !any)}>{any ? 'Collapse all' : 'Expand all'}</button>;
}
/** Child rows for one expanded line. `cells` returns the cells after the name for one account. */
export function AcctRows({ ex, k, lines, span, cells }: { ex: Expand; k: string; lines?: string[]; span: number; cells: (a: Acct, line: string) => React.ReactNode }) {
  if (!ex.open.has(k)) return null; if (!ex.ready) return <tr className="acct"><td colSpan={span + 1} className="muted">Loading accounts…</td></tr>;
  const rows = (lines ?? [k]).flatMap((line) => ex.accounts(line).map((a) => ({ a, line })));
  if (!rows.length) return <tr className="acct"><td colSpan={span + 1} className="muted">No accounts are mapped to this line.</td></tr>;
  return <>{rows.map(({ a, line }) => <tr key={a.id} className="acct"><td>{a.name}</td>{cells(a, line)}</tr>)}</>;
}
