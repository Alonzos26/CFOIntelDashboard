import React, { createContext, useContext, useEffect, useState } from 'react';
import { BudgetPage } from './budget.tsx';
import { ClientComms } from './comms.tsx';
import { get, post, setBearer, setOnUnauthorized } from './api.ts';
import { ErrorNote, Loading, Note } from './ui.tsx';
import { Overview, ScorecardPage, Performance, WeeklyPulse, CashFlow, Reports, Actions, IndustryKpis } from './pages.tsx';
import { DecisionLab, ProfitPlanner } from './lab.tsx';
import { LoansPage } from './loans.tsx';
import { Portfolio, DataSources, Review, ClientSettings, KpiLibrary } from './advisor.tsx';

export interface Tenant { id: string; name: string; role: string; isStaff: boolean; permissions: string[]; isSynthetic: boolean }
export interface Me { user: { id: string; name: string; email: string; staffRole: string | null }; embedded: boolean; tenants: Tenant[]; reference: any }
export interface TCtx { tid: string; tenant: Tenant; me: Me; can: (p: string) => boolean; go: (page: string, sub?: string) => void; sub: string | null; base: string }
const Ctx = createContext<TCtx>(null as unknown as TCtx);
export const useT = () => useContext(Ctx);

const usePath = (): [string, (p: string) => void] => {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => { const f = () => setPath(location.pathname); addEventListener('popstate', f); return () => removeEventListener('popstate', f); }, []);
  return [path, (p: string) => { if (p !== location.pathname) { history.pushState(null, '', p); setPath(p); window.scrollTo(0, 0); } }];
};

const NAV: { key: string; label: string; perm?: string; staff?: boolean; group?: string }[] = [
  { key: 'overview', label: 'Overview' }, { key: 'weekly', label: 'Weekly Pulse' }, { key: 'scorecard', label: 'Scorecard' }, { key: 'performance', label: 'Profit & Performance' },
  { key: 'cash', label: 'Cash Flow' }, { key: 'lab', label: 'Decision Lab' }, { key: 'budget', label: 'Budget' }, { key: 'planner', label: 'Profit Planner' }, { key: 'loans', label: 'Business Plan & Loans' }, { key: 'kpis', label: 'Industry KPIs' }, { key: 'actions', label: 'Goals & Actions' }, { key: 'reports', label: 'Reports' },
  { key: 'data', label: 'Data Sources & Mappings', perm: 'import', group: 'Advisor tools' }, { key: 'review', label: 'Review & Approval', perm: 'view_internal', group: 'Advisor tools' }, { key: 'comms', label: 'Client Communications', perm: 'view_internal', group: 'Advisor tools' }, { key: 'settings', label: 'Client Settings', perm: 'settings', group: 'Advisor tools' },
];
const PAGES: Record<string, React.FC> = { overview: Overview, weekly: WeeklyPulse, scorecard: ScorecardPage, performance: Performance, cash: CashFlow, lab: DecisionLab, budget: BudgetPage, planner: ProfitPlanner, loans: LoansPage, kpis: IndustryKpis, actions: Actions, reports: Reports, data: DataSources, review: Review, comms: ClientComms, settings: ClientSettings };

function Login({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => { e.preventDefault(); setBusy(true); setError(null); try { await post('/auth/login', { email, password }); onDone(); } catch (x) { setError((x as Error).message); } finally { setBusy(false); } };
  return <main className="login"><form onSubmit={submit} className="card">
    <div className="brand"><b>CFO</b> Intelligence</div>
    <p className="muted">Sign in to your financial command center. Clients normally arrive here from the SJATS Client Portal and do not need to sign in again.</p>
    <label className="field"><span className="field-l">Email</span><input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
    <label className="field"><span className="field-l">Password</span><input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
    <ErrorNote error={error} /><button className="btn btn-primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
  </form></main>;
}

export function App() {
  const [path, go] = usePath(); const [me, setMe] = useState<Me | null>(null); const [state, setState] = useState<'loading' | 'login' | 'ready' | 'error'>('loading'); const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const load = async () => { try { const m = await get<Me>('/me'); setMe(m); setState('ready'); return m; } catch (e: any) { if (e.status === 401) setState('login'); else { setError(e.message); setState('error'); } return null; } };
  useEffect(() => {
    setOnUnauthorized(() => setState('login'));
    (async () => {
      // Embedded launch: the portal passes a single-use launch token in the URL fragment (never sent to servers or logs).
      if (location.pathname === '/embed') {
        const token = new URLSearchParams(location.hash.slice(1)).get('token'); history.replaceState(null, '', '/embed');
        if (!token) { setError('This page must be opened from the SJATS Client Portal.'); setState('error'); return; }
        try { const r = await post('/auth/exchange', { token }); setBearer(r.sessionToken); const m = await load(); if (m) go(`/c/${r.tenantId}/overview`); } catch (e: any) { setError(e.message); setState('error'); }
        return;
      }
      await load();
    })();
  }, []);
  useEffect(() => { setMenu(false); }, [path]);
  if (state === 'loading') return <Loading />;
  if (state === 'error') return <main className="login"><div className="card"><div className="brand"><b>CFO</b> Intelligence</div><ErrorNote error={error} /></div></main>;
  if (state === 'login' || !me) return <Login onDone={() => void load()} />;

  const isStaff = !!me.user.staffRole; const parts = path.split('/').filter(Boolean);
  if (!parts.length || (parts[0] === 'portfolio' && !isStaff) || parts[0] === 'embed') { const dest = isStaff ? '/portfolio' : me.tenants[0] ? `/c/${me.tenants[0].id}/overview` : null; if (dest) { queueMicrotask(() => go(dest)); return <Loading />; } }
  const tenant = parts[0] === 'c' ? me.tenants.find((t) => t.id === parts[1]) ?? null : null;
  const page = parts[0] === 'c' ? parts[2] ?? 'overview' : parts[0];
  const logout = async () => { await post('/auth/logout').catch(() => {}); setBearer(null); setMe(null); setState('login'); go('/'); };
  const tctx: TCtx | null = tenant ? { tid: tenant.id, tenant, me, can: (p) => tenant.permissions.includes(p), go: (pg, sub) => go(`/c/${tenant.id}/${pg}${sub ? `/${sub}` : ''}`), sub: parts[3] ?? null, base: `/t/${tenant.id}` } : null;
  const Page = tenant ? PAGES[page] : null;
  const nav = NAV.filter((n) => !n.perm || tenant?.permissions.includes(n.perm));

  return <div className={`shell ${me.embedded ? 'embedded' : ''}`}>
    <header className="top">
      <button className="btn btn-ghost menu-btn" onClick={() => setMenu(!menu)} aria-expanded={menu} aria-controls="side">Menu</button>
      <div className="brand"><b>CFO</b> Intelligence</div>
      {tenant && <div className="top-client">{isStaff && !me.embedded && me.tenants.length > 1
        ? <select aria-label="Client" value={tenant.id} onChange={(e) => go(`/c/${e.target.value}/${page in PAGES ? page : 'overview'}`)}>{me.tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
        : <span>{tenant.name}</span>}</div>}
      <div className="top-r">{isStaff && <span className="pill pill-info">Advisor view</span>}<span className="who">{me.user.name}</span>{!me.embedded && <button className="btn btn-ghost" onClick={logout}>Sign out</button>}</div>
    </header>
    <div className="body">
      <nav id="side" className={`side ${menu ? 'open' : ''}`} aria-label="Sections">
        {isStaff && !me.embedded && <><a className={page === 'portfolio' ? 'on' : ''} href="/portfolio" onClick={(e) => { e.preventDefault(); go('/portfolio'); }}>Client Portfolio</a><a className={page === 'library' ? 'on' : ''} href="/library" onClick={(e) => { e.preventDefault(); go('/library'); }}>KPI Library</a><hr /></>}
        {tenant && nav.map((n, i) => <React.Fragment key={n.key}>{n.group && nav[i - 1]?.group !== n.group && <div className="side-g">{n.group}</div>}<a className={page === n.key ? 'on' : ''} href={`/c/${tenant.id}/${n.key}`} onClick={(e) => { e.preventDefault(); go(`/c/${tenant.id}/${n.key}`); }}>{n.label}</a></React.Fragment>)}
      </nav>
      <main className="main" id="main">
        {tenant?.isSynthetic && <Note tone="warn"><b>Synthetic demo data.</b> Every figure for this client was generated for demonstration. It does not describe a real business.</Note>}
        {parts[0] === 'portfolio' && isStaff ? <Portfolio go={go} /> : parts[0] === 'library' && isStaff ? <KpiLibrary me={me} />
          : tctx && Page ? <Ctx.Provider value={tctx}><Page key={`${tctx.tid}/${page}`} /></Ctx.Provider>
          : <div className="card"><h2>Page not found</h2><p className="muted">This page does not exist or you do not have access to it.</p></div>}
      </main>
    </div>
  </div>;
}
