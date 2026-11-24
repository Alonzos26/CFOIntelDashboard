// API routes. Every /api/t/:tid/* route has already passed server-side tenant authorization in App.handle;
// every SQL statement below additionally filters on tenant_id.
import { type App, type Ctx, HttpError, notFound } from './app.ts';
import { now, uid } from './db.ts';
import { ROLE_PERMISSIONS, STAFF_ROLES, hashPassword } from './auth.ts';
import { BS_LINES, DEFAULT_SETTINGS, ENGINE_VERSION, LINE_LABELS, PNL_LINES, type Settings, isPeriod, mergeSettings, fmtMoney, rolling12 } from '../engine/core.ts';
import { CADENCES, CASH_CATEGORIES, type CashItem, weekStart } from '../engine/cash.ts';
import { evaluateHire, type HiringInputs } from '../engine/hiring.ts';
import { profitPlan } from '../engine/profitplan.ts';
import { evaluateWagePlan, type WagePlanInput } from '../engine/ownerwage.ts';
import { buyIn } from '../engine/capital.ts';
import * as comms from './comms.ts';
import { MERGE_FIELDS, renderTemplate } from '../engine/comms.ts';
import { profitLevels, valuation, VALUE_ELEMENTS } from '../engine/valuation.ts';
import { FINANCIAL_VARIABLES, FormulaError, isFinancialVariable, formulaVariables, parseFormula } from '../engine/kpi.ts';
import * as imp from './importer.ts';
import * as svc from './services.ts';

const str = (v: unknown, name: string, max = 500, required = true): string => {
  if (v === undefined || v === null || v === '') { if (required) throw new HttpError(400, `${name} is required.`); return ''; }
  if (typeof v !== 'string' || v.length > max) throw new HttpError(400, `${name} must be text of at most ${max} characters.`);
  return v.trim();
};
const int = (v: unknown, name: string, o: { min?: number; max?: number; nullable?: boolean } = {}): number => {
  if ((v === null || v === undefined || v === '') && o.nullable) return null as unknown as number;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new HttpError(400, `${name} must be a number.`);
  const n = Math.round(v); if ((o.min !== undefined && n < o.min) || (o.max !== undefined && n > o.max)) throw new HttpError(400, `${name} is out of range.`);
  return n;
};
const num = (v: unknown, name: string, nullable = false): number => { if ((v === null || v === undefined || v === '') && nullable) return null as unknown as number; if (typeof v !== 'number' || !Number.isFinite(v)) throw new HttpError(400, `${name} must be a number.`); return v; };
const oneOf = <T extends string>(v: unknown, name: string, opts: readonly T[]): T => { if (!opts.includes(v as T)) throw new HttpError(400, `${name} must be one of: ${opts.join(', ')}.`); return v as T; };
const period = (v: unknown) => { if (typeof v !== 'string' || !isPeriod(v)) throw new HttpError(400, 'Period must look like 2026-01.'); return v; };
const isoDate = (v: unknown, name: string, nullable = false) => { if ((v === null || v === undefined || v === '') && nullable) return null as unknown as string; if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) throw new HttpError(400, `${name} must be a date (YYYY-MM-DD).`); return v; };
const clientOnly = (c: Ctx) => !c.access.can('view_unapproved');
const MONEY_MAX = 1e13;

export function registerRoutes(app: App) {
  const { db, auth } = app;

  // ---------- authentication ----------
  app.on('POST', '/api/auth/login', (c) => {
    const r = auth.login(str(c.body.email, 'Email', 200), str(c.body.password, 'Password', 200));
    if ('error' in r) throw new HttpError(401, r.error);
    c.res.setHeader('Set-Cookie', app.sessionCookie(r.token, app.cfg.sessionTtlMinutes * 60));
    return { ok: true, expiresAt: r.expiresAt };
  }, { open: true });
  // Portal single sign-on: exchange the portal's short-lived launch token for a CFO session pinned to one client.
  app.on('POST', '/api/auth/exchange', (c) => {
    const r = auth.exchangeLaunchToken(str(c.body.token, 'Launch token', 4000));
    if ('error' in r) throw new HttpError(401, r.error);
    c.res.setHeader('Set-Cookie', app.sessionCookie(r.token, app.cfg.embeddedSessionTtlMinutes * 60));
    // The bearer token is also returned so an embedded frame can authenticate without relying on third-party cookies.
    return { ok: true, tenantId: r.tenantId, sessionToken: r.token, expiresAt: r.expiresAt };
  }, { open: true });
  app.on('POST', '/api/auth/logout', (c) => { auth.revoke(c.session.tokenHash); c.res.setHeader('Set-Cookie', app.sessionCookie('', 0)); return { ok: true }; });
  app.on('GET', '/api/me', (c) => ({
    user: c.session.user, embedded: !!c.session.pinnedTenantId,
    tenants: auth.tenantsFor(c.session).map((t) => ({ ...t, isStaff: STAFF_ROLES.includes(t.role), permissions: ROLE_PERMISSIONS[t.role] })),
    reference: { pnlLines: PNL_LINES, bsLines: BS_LINES, lineLabels: LINE_LABELS, cadences: CADENCES, cashCategories: CASH_CATEGORIES, financialVariables: FINANCIAL_VARIABLES, defaultSettings: DEFAULT_SETTINGS, engineVersion: ENGINE_VERSION },
  }));

  // ---------- advisor environment ----------
  app.on('GET', '/api/portfolio', (c) => ({ clients: svc.portfolio(db, auth.tenantsFor(c.session).map((t) => t.id)) }), { staff: true });
  app.on('POST', '/api/tenants', (c) => {
    if (!['super_admin', 'advisor'].includes(c.session.user.staffRole ?? '')) throw new HttpError(403, 'Only advisors can add clients.');
    const id = uid(); const name = str(c.body.name, 'Client name', 120);
    const industryId = c.body.industryId ? str(c.body.industryId, 'Industry', 60) : null;
    if (industryId && !db.get('SELECT id FROM industries WHERE id = ?', industryId)) throw new HttpError(400, 'Unknown industry.');
    db.tx(() => {
      db.run('INSERT INTO tenants (id, name, portal_client_id, industry_id, settings_json, is_synthetic, created_at) VALUES (?,?,?,?,?,?,?)', id, name, c.body.portalClientId ? str(c.body.portalClientId, 'Portal client ID', 100) : null, industryId, '{}', c.body.isSynthetic ? 1 : 0, now());
      if (c.session.user.staffRole !== 'super_admin') db.run('INSERT INTO memberships (user_id, tenant_id, role) VALUES (?,?,?)', c.session.user.id, id, 'advisor');
      if (industryId) db.run("INSERT INTO tenant_kpis (tenant_id, kpi_id, client_visible) SELECT ?, id, client_visible FROM kpi_definitions WHERE industry_id = ? AND status = 'active'", id, industryId);
      db.audit(id, c.session.user.id, 'tenant.created', 'tenant', id, { name });
    });
    return { id };
  }, { staff: true });

  // KPI library (shared across clients; managed without code changes)
  app.on('GET', '/api/kpi-library', () => ({ industries: db.all('SELECT * FROM industries ORDER BY name'), definitions: db.all('SELECT * FROM kpi_definitions ORDER BY name'), financialVariables: FINANCIAL_VARIABLES }), { staff: true });
  const libraryAdmin = (c: Ctx) => { if (!['super_admin', 'advisor'].includes(c.session.user.staffRole ?? '')) throw new HttpError(403, 'Only advisors can change the KPI library.'); };
  app.on('POST', '/api/kpi-library/industries', (c) => { libraryAdmin(c); const id = uid(); try { db.run('INSERT INTO industries (id, name) VALUES (?,?)', id, str(c.body.name, 'Industry name', 80)); } catch { throw new HttpError(409, 'An industry with that name already exists.'); } db.audit(null, c.session.user.id, 'kpi.industry_created', 'industry', id); return { id }; }, { staff: true });
  app.on('POST', '/api/kpi-library/validate', (c) => validateFormula(str(c.body.formula, 'Formula', 500)), { staff: true });
  function validateFormula(formula: string) {
    try { parseFormula(formula); } catch (e) { if (e instanceof FormulaError) return { valid: false, error: e.message }; throw e; }
    const vars = formulaVariables(formula);
    return { valid: true, financial: vars.filter((v) => isFinancialVariable(v)), inputs: vars.filter((v) => !isFinancialVariable(v)) };
  }
  function kpiFields(c: Ctx) {
    const formula = str(c.body.formula, 'Formula', 500); const v = validateFormula(formula);
    if (!v.valid) throw new HttpError(400, `Formula error: ${v.error}`);
    return {
      name: str(c.body.name, 'Name', 120), formula, unit: oneOf(c.body.unit, 'Unit', ['percent', 'currency', 'ratio', 'number', 'days'] as const), basis: oneOf(c.body.basis ?? 'month', 'Basis', ['month', 'r12'] as const),
      frequency: oneOf(c.body.frequency ?? 'monthly', 'Frequency', ['weekly', 'monthly', 'quarterly'] as const), direction: oneOf(c.body.direction ?? 'higher', 'Direction', ['higher', 'lower'] as const),
      target: num(c.body.defaultTarget, 'Target', true), alert: num(c.body.alertThreshold, 'Alert threshold', true), description: str(c.body.description, 'Description', 1000, false), action: str(c.body.recommendedAction, 'Recommended action', 1000, false),
      dataSource: str(c.body.dataSource, 'Data source', 300, false), benchmark: str(c.body.benchmarkSource, 'Benchmark source', 300, false) || null, visible: c.body.clientVisible === false ? 0 : 1,
    };
  }
  app.on('POST', '/api/kpi-library/definitions', (c) => {
    libraryAdmin(c); const f = kpiFields(c); const id = uid(); const industryId = str(c.body.industryId, 'Industry', 60);
    const key = str(c.body.key, 'Key', 60); if (!/^[a-z][a-z0-9_]*$/.test(key)) throw new HttpError(400, 'Key must be lowercase letters, digits and underscores.');
    if (!db.get('SELECT id FROM industries WHERE id = ?', industryId)) throw new HttpError(400, 'Unknown industry.');
    try { db.run('INSERT INTO kpi_definitions (id, industry_id, key, name, formula, unit, basis, frequency, direction, default_target, alert_threshold, description, recommended_action, data_source, benchmark_source, client_visible, updated_by, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      id, industryId, key, f.name, f.formula, f.unit, f.basis, f.frequency, f.direction, f.target, f.alert, f.description, f.action, f.dataSource, f.benchmark, f.visible, c.session.user.id, now()); } catch { throw new HttpError(409, 'That key is already used in this industry.'); }
    db.audit(null, c.session.user.id, 'kpi.definition_created', 'kpi', id, { key, formula: f.formula });
    return { id };
  }, { staff: true });
  app.on('PUT', '/api/kpi-library/definitions/:id', (c) => {
    libraryAdmin(c); const f = kpiFields(c); const status = oneOf(c.body.status ?? 'active', 'Status', ['active', 'retired'] as const);
    const r = db.run('UPDATE kpi_definitions SET name=?, formula=?, unit=?, basis=?, frequency=?, direction=?, default_target=?, alert_threshold=?, description=?, recommended_action=?, data_source=?, benchmark_source=?, client_visible=?, status=?, updated_by=?, updated_at=? WHERE id=?',
      f.name, f.formula, f.unit, f.basis, f.frequency, f.direction, f.target, f.alert, f.description, f.action, f.dataSource, f.benchmark, f.visible, status, c.session.user.id, now(), c.params.id);
    if (!r.changes) throw notFound();
    db.audit(null, c.session.user.id, 'kpi.definition_updated', 'kpi', c.params.id, { status, formula: f.formula });
    return { ok: true };
  }, { staff: true });

  // ---------- tenant: dashboard & financials ----------
  const T = '/api/t/:tid';
  app.on('GET', `${T}/overview`, (c) => svc.overview(db, c.tenantId, clientOnly(c), oneOf(c.query.get('view') ?? 'monthly', 'View', ['monthly', 'quarterly', 'ytd', 'r12'] as const)), { perm: 'view' });
  app.on('GET', `${T}/financials`, (c) => svc.financials(db, c.tenantId, clientOnly(c)), { perm: 'view' });
  app.on('GET', `${T}/export/pnl.csv`, (c) => {
    const f = svc.financials(db, c.tenantId, clientOnly(c));
    const rows = [['Line', ...f.months.map((m) => m.period)], ...PNL_LINES.map((l) => [LINE_LABELS[l], ...f.months.map((m) => (m.pnl.lines[l] / 100).toFixed(2))]),
      ['Gross profit', ...f.months.map((m) => (m.pnl.grossProfit / 100).toFixed(2))], ['Pretax profit', ...f.months.map((m) => (m.pnl.pretax / 100).toFixed(2))], ['Adjusted pretax profit', ...f.months.map((m) => (m.pnl.adjustedPretax / 100).toFixed(2))], ['Status', ...f.months.map((m) => m.status)]];
    db.audit(c.tenantId, c.session.user.id, 'export.pnl_csv');
    c.res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="management-pnl.csv"' });
    c.res.end(rows.map((r) => r.map((x) => (/[",\n]/.test(String(x)) ? `"${String(x).replace(/"/g, '""')}"` : x)).join(',')).join('\n'));
  }, { perm: 'export', raw: true });

  app.on('GET', `${T}/settings`, (c) => ({ settings: svc.loadSettings(db, c.tenantId), tenant: db.get('SELECT id, name, portal_client_id, industry_id, is_synthetic FROM tenants WHERE id = ?', c.tenantId) }), { perm: 'view_unapproved' });
  app.on('PUT', `${T}/settings`, (c) => {
    const b = c.body.settings ?? {}; const cur = svc.loadSettings(db, c.tenantId);
    const pct = (v: unknown, n: string, nullable = false) => { const x = num(v, n, nullable); if (x !== null && (x < 0 || x > 1)) throw new HttpError(400, `${n} must be between 0% and 100%.`); return x; };
    const pos = (v: unknown, n: string, nullable = false) => { const x = num(v, n, nullable); if (x !== null && (x < 0 || x > MONEY_MAX)) throw new HttpError(400, `${n} is out of range.`); return x; };
    const grades = { ...cur.grades };
    for (const k of Object.keys(DEFAULT_SETTINGS.grades) as (keyof Settings['grades'])[]) if (b.grades?.[k]) { const g = { great: pos(b.grades[k].great, 'Grade threshold'), good: pos(b.grades[k].good, 'Grade threshold'), ok: pos(b.grades[k].ok, 'Grade threshold') }; if (!(g.great >= g.good && g.good >= g.ok)) throw new HttpError(400, 'Grade thresholds must descend: Great ≥ Good ≥ OK.'); grades[k] = g; }
    const next: Settings = mergeSettings({
      pretaxTargetPct: pct(b.pretaxTargetPct ?? cur.pretaxTargetPct, 'Profit target'), dlerTarget: pos(b.dlerTarget ?? null, 'Direct LYR target', true), mlerTarget: pos(b.mlerTarget ?? null, 'Management LYR target', true),
      salesTargetR12Cents: b.salesTargetR12Cents == null ? null : Math.round(pos(b.salesTargetR12Cents, 'Sales target')), opexPctTarget: pct(b.opexPctTarget ?? null, 'Operating expense target', true), dsoTargetDays: pos(b.dsoTargetDays ?? null, 'DSO target', true),
      dsoWindowDays: oneOf(b.dsoWindowDays ?? cur.dsoWindowDays, 'DSO window', [30, 60, 90] as any), coreCapitalMonths: pos(b.coreCapitalMonths ?? cur.coreCapitalMonths, 'Operating reserve months'),
      coreCapitalBasis: oneOf(b.coreCapitalBasis ?? cur.coreCapitalBasis, 'Operating reserve basis', ['r12_avg', 't3m_avg', 'latest_month'] as const), coreCapitalExcludeCogs: !!(b.coreCapitalExcludeCogs ?? cur.coreCapitalExcludeCogs),
      burdenTreatment: oneOf(b.burdenTreatment ?? cur.burdenTreatment, 'Burden treatment', ['opex', 'labor'] as const), weeklyGpTargetCents: b.weeklyGpTargetCents == null ? null : Math.round(pos(b.weeklyGpTargetCents, 'Weekly gross profit target')),
      cashFloorCents: Math.round(pos(b.cashFloorCents ?? cur.cashFloorCents, 'Minimum cash')), weekStartDay: int(b.weekStartDay ?? cur.weekStartDay, 'Week start day', { min: 0, max: 6 }), fiscalYearStartMonth: int(b.fiscalYearStartMonth ?? cur.fiscalYearStartMonth, 'Fiscal year start', { min: 1, max: 12 }),
      clientCanRunScenarios: !!(b.clientCanRunScenarios ?? cur.clientCanRunScenarios), grades,
      taxReserveRate: (() => { const x = num(b.taxReserveRate ?? cur.taxReserveRate, 'Tax reserve rate'); if (x < 0 || x > 0.9) throw new HttpError(400, 'Tax reserve rate must be between 0% and 90%.'); return x; })(), taxesPaid: cur.taxesPaid, taxProjected: cur.taxProjected, locLimitCents: b.locLimitCents === undefined ? cur.locLimitCents : b.locLimitCents === null ? null : Math.round(pos(b.locLimitCents, 'Line of credit limit')),
      stretchPretaxPct: (() => { const x = num(b.stretchPretaxPct ?? cur.stretchPretaxPct, 'Stretch profit target'); if (x < 0 || x > 0.9) throw new HttpError(400, 'Stretch profit target must be between 0% and 90%.'); return x; })(), reportDueDay: int(b.reportDueDay ?? cur.reportDueDay, 'Report due day', { min: 1, max: 28 }), billPayWeekday: b.billPayWeekday === undefined ? cur.billPayWeekday : b.billPayWeekday === null ? null : int(b.billPayWeekday, 'Bill-pay day', { min: 0, max: 6 }),
    });
    db.run('UPDATE tenants SET settings_json = ? WHERE id = ?', JSON.stringify(next), c.tenantId);
    db.audit(c.tenantId, c.session.user.id, 'settings.updated', 'tenant', c.tenantId, { before: cur, after: next });
    return { settings: next };
  }, { perm: 'settings' });

  // ---------- periods, adjustments, scorecard ----------
  app.on('GET', `${T}/periods`, (c) => ({ periods: svc.loadMonths(db, c.tenantId, false).map((m) => ({ period: m.period, status: m.status, missing: m.missing, hasBs: !!m.bs, ownerAdj: m.ownerAdj })), adjustments: db.all('SELECT a.*, u.name AS created_by_name FROM adjustments a JOIN users u ON u.id = a.created_by WHERE a.tenant_id = ? ORDER BY a.period DESC, a.created_at DESC', c.tenantId) }), { perm: 'view_unapproved' });
  app.on('PUT', `${T}/periods/status`, (c) => {
    const status = oneOf(c.body.status, 'Status', ['preliminary', 'reconciled', 'approved'] as const); const periods: string[] = (Array.isArray(c.body.periods) ? c.body.periods : []).map(period);
    if (!periods.length) throw new HttpError(400, 'Select at least one period.');
    const have = new Set(svc.loadMonths(db, c.tenantId, false).filter((m) => !m.missing).map((m) => m.period));
    for (const p of periods) if (!have.has(p)) throw new HttpError(400, `There is no imported data for ${p}.`);
    db.tx(() => { for (const p of periods) db.run('INSERT INTO period_status (tenant_id, period, status, updated_by, updated_at) VALUES (?,?,?,?,?) ON CONFLICT (tenant_id, period) DO UPDATE SET status = excluded.status, updated_by = excluded.updated_by, updated_at = excluded.updated_at', c.tenantId, p, status, c.session.user.id, now()); db.audit(c.tenantId, c.session.user.id, 'period.status', 'period', periods.join(','), { status }); });
    return { ok: true };
  }, { perm: 'approve' });
  app.on('POST', `${T}/adjustments`, (c) => {
    const from = period(c.body.from), to = period(c.body.to ?? c.body.from); if (to < from) throw new HttpError(400, 'End period is before start period.');
    const amount = int(c.body.amountCents, 'Amount', { min: -MONEY_MAX, max: MONEY_MAX }); const note = str(c.body.note, 'Note', 500);
    // owner_comp = monthly under/over-payment vs. market wage; owner_distribution = shareholder distributions taken (overrides the balance-sheet-derived figure).
    const kind = oneOf(c.body.kind ?? 'owner_comp', 'Type', ['owner_comp', 'owner_distribution'] as const);
    if (kind === 'owner_distribution' && amount < 0) throw new HttpError(400, 'Distributions cannot be negative.');
    const ids: string[] = [];
    db.tx(() => { for (const m of svc.loadMonths(db, c.tenantId, false)) if (m.period >= from && m.period <= to) { const id = uid(); ids.push(id); db.run("INSERT INTO adjustments (id, tenant_id, period, kind, amount_cents, note, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)", id, c.tenantId, m.period, kind, amount, note, c.session.user.id, now()); } db.audit(c.tenantId, c.session.user.id, 'adjustment.created', 'adjustment', ids.join(','), { kind, from, to, amount, note }); });
    if (!ids.length) throw new HttpError(400, 'No imported periods fall in that range.');
    return { created: ids.length };
  }, { perm: 'adjust' });
  app.on('POST', `${T}/adjustments/:id/reverse`, (c) => {
    const r = db.run('UPDATE adjustments SET reversed_by = ?, reversed_at = ? WHERE id = ? AND tenant_id = ? AND reversed_at IS NULL', c.session.user.id, now(), c.params.id, c.tenantId);
    if (!r.changes) throw notFound(); db.audit(c.tenantId, c.session.user.id, 'adjustment.reversed', 'adjustment', c.params.id); return { ok: true };
  }, { perm: 'adjust' });

  // ---------- owner / shareholder market-based wage plan ----------
  const wageCtx = (c: Ctx) => { const st = svc.loadSettings(db, c.tenantId); const months = svc.loadMonths(db, c.tenantId, clientOnly(c)); const r = months.length ? rolling12(months, months.length - 1, st) : null; return { today: now().slice(0, 10), r12HeadroomCents: r ? r.salaryCapHeadroom : null, r12OwnerAdjCents: r ? r.ownerAdj : null, pretaxTargetPct: st.pretaxTargetPct }; };
  const wageOut = (c: Ctx, p: any) => ({ id: p.id, year: p.year, status: p.status, input: JSON.parse(p.input_json), result: evaluateWagePlan(JSON.parse(p.input_json), wageCtx(c)), appliedFrom: p.applied_from, appliedTo: p.applied_to, updatedAt: p.updated_at, approvedAt: p.approved_at });
  // Clients see approved plans only; advisors see drafts too.
  app.on('GET', `${T}/owner-wage`, (c) => ({ plans: db.all(`SELECT * FROM owner_wage_plans WHERE tenant_id = ? ${clientOnly(c) ? "AND status = 'approved'" : ''} ORDER BY year DESC`, c.tenantId).map((p) => wageOut(c, p)), context: wageCtx(c) }), { perm: 'view' });
  function sanitizeWage(b: any): WagePlanInput {
    const m = (v: unknown, n: string) => int(v ?? 0, n, { min: 0, max: MONEY_MAX }); const d = (v: unknown, n: string) => isoDate(v, n, true);
    const owners = (Array.isArray(b.owners) ? b.owners : []).slice(0, 12).map((o: any) => ({
      name: str(o.name, 'Owner name', 120), ownershipPct: (() => { const x = num(o.ownershipPct ?? 1, 'Ownership'); if (x < 0 || x > 1) throw new HttpError(400, 'Ownership must be between 0% and 100%.'); return x; })(), approach: oneOf(o.approach, 'Approach', ['cost', 'market', 'income'] as const),
      roles: (Array.isArray(o.roles) ? o.roles : []).slice(0, 20).map((r: any) => ({ title: str(r.title, 'Role', 120, false), hoursPerYear: (() => { const h = num(r.hoursPerYear ?? 0, 'Hours'); if (h < 0 || h > 8760) throw new HttpError(400, 'Hours per year is out of range.'); return h; })(), hourlyWageCents: m(r.hourlyWageCents, 'Hourly wage'), source: str(r.source, 'Source', 300, false), sourceDate: d(r.sourceDate, 'Source date') })),
      marketTitle: str(o.marketTitle, 'Comparable position', 120, false), marketAnnualCents: m(o.marketAnnualCents, 'Market wage'), marketSource: str(o.marketSource, 'Source', 300, false), marketSourceDate: d(o.marketSourceDate, 'Source date'),
      incomeAnnualCents: m(o.incomeAnnualCents, 'Income-approach wage'), incomeBasis: str(o.incomeBasis, 'Basis', 1000, false), actualW2AnnualCents: m(o.actualW2AnnualCents, 'W-2 wages'), plannedDistributionsAnnualCents: m(o.plannedDistributionsAnnualCents, 'Distributions'),
    }));
    return { year: int(b.year, 'Year', { min: 2000, max: 2100 }), isSCorp: b.isSCorp !== false, analysisDate: isoDate(b.analysisDate, 'Analysis date'), owners };
  }
  app.on('PUT', `${T}/owner-wage`, (c) => {
    const input = sanitizeWage(c.body.input ?? {}); const result = evaluateWagePlan(input, wageCtx(c)); const approve = c.body.approve === true;
    if (approve && !c.access.can('approve')) throw new HttpError(403, 'Your role cannot approve a wage plan.');
    if (approve && (!input.owners.length || result.totalReasonableAnnualCents <= 0)) throw new HttpError(400, 'Enter at least one owner with a market wage before approving.');
    const ex = db.get('SELECT id FROM owner_wage_plans WHERE tenant_id = ? AND year = ?', c.tenantId, input.year); const id = ex?.id ?? uid();
    db.run(`INSERT INTO owner_wage_plans (id, tenant_id, year, status, input_json, result_json, updated_by, updated_at, approved_by, approved_at) VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT (tenant_id, year) DO UPDATE SET status = excluded.status, input_json = excluded.input_json, result_json = excluded.result_json, updated_by = excluded.updated_by, updated_at = excluded.updated_at, approved_by = excluded.approved_by, approved_at = excluded.approved_at`,
      id, c.tenantId, input.year, approve ? 'approved' : 'draft', JSON.stringify(input), JSON.stringify(result), c.session.user.id, now(), approve ? c.session.user.id : null, approve ? now() : null);
    db.audit(c.tenantId, c.session.user.id, approve ? 'owner_wage.approved' : 'owner_wage.saved', 'owner_wage_plan', id, { year: input.year, reasonable: result.totalReasonableAnnualCents, gap: result.totalGapAnnualCents });
    return wageOut(c, db.get('SELECT * FROM owner_wage_plans WHERE id = ? AND tenant_id = ?', id, c.tenantId));
  }, { perm: 'adjust' });
  /** Apply the plan's monthly gap as the owner-pay adjustment for a range of months. Existing owner-pay adjustments in the range are reversed (kept in history), not deleted. */
  app.on('POST', `${T}/owner-wage/:id/apply`, (c) => {
    const p = db.get('SELECT * FROM owner_wage_plans WHERE id = ? AND tenant_id = ?', c.params.id, c.tenantId); if (!p) throw notFound();
    if (p.status !== 'approved') throw new HttpError(409, 'Approve the wage plan before applying it to the financials.');
    const from = period(c.body.from), to = period(c.body.to); if (to < from) throw new HttpError(400, 'End month is before start month.');
    const amount = evaluateWagePlan(JSON.parse(p.input_json), wageCtx(c)).monthlyAdjustmentCents; const months = svc.loadMonths(db, c.tenantId, false).filter((m) => m.period >= from && m.period <= to);
    if (!months.length) throw new HttpError(400, 'No imported months fall in that range.');
    db.tx(() => {
      db.run("UPDATE adjustments SET reversed_by = ?, reversed_at = ? WHERE tenant_id = ? AND kind = 'owner_comp' AND reversed_at IS NULL AND period >= ? AND period <= ?", c.session.user.id, now(), c.tenantId, from, to);
      for (const m of months) db.run("INSERT INTO adjustments (id, tenant_id, period, kind, amount_cents, note, created_by, created_at) VALUES (?,?,?,'owner_comp',?,?,?,?)", uid(), c.tenantId, m.period, amount, `From the ${p.year} owner market-wage plan: market wage less W-2 wages paid, per month.`, c.session.user.id, now());
      db.run('UPDATE owner_wage_plans SET applied_from = ?, applied_to = ? WHERE id = ? AND tenant_id = ?', from, to, p.id, c.tenantId);
      db.audit(c.tenantId, c.session.user.id, 'owner_wage.applied', 'owner_wage_plan', p.id, { from, to, monthlyAmount: amount, months: months.length });
    });
    return { applied: months.length, monthlyAmountCents: amount };
  }, { perm: 'adjust' });

  app.on('GET', `${T}/scorecard`, (c) => {
    if (clientOnly(c)) { const cur = svc.publishedScorecard(db, c.tenantId); return { current: cur, recent: svc.recentFor(db, c.tenantId, true, cur?.period), history: db.all("SELECT period, published_at FROM scorecards WHERE tenant_id = ? AND status = 'published' ORDER BY period DESC", c.tenantId) }; }
    const months = svc.loadMonths(db, c.tenantId, false);
    return { recent: svc.recentFor(db, c.tenantId, false, months.at(-1)?.period), current: svc.liveScorecard(db, c.tenantId, months, svc.loadSettings(db, c.tenantId)), published: svc.publishedScorecard(db, c.tenantId), history: db.all('SELECT period, status, published_at FROM scorecards WHERE tenant_id = ? ORDER BY period DESC', c.tenantId), periodStatus: months.at(-1)?.status ?? null };
  }, { perm: 'view' });
  app.on('GET', `${T}/scorecard/:period`, (c) => { const s = svc.publishedScorecard(db, c.tenantId, period(c.params.period)); if (!s) throw notFound(); return { ...s, recent: svc.recentFor(db, c.tenantId, clientOnly(c), s.period) }; }, { perm: 'view' });
  /** Save commentary / grade overrides as a draft, or publish a frozen snapshot for the client. */
  app.on('PUT', `${T}/scorecard`, (c) => {
    const publish = c.body.publish === true; if (publish && !c.access.can('publish')) throw new HttpError(403, 'Your role cannot publish scorecards.');
    const months = svc.loadMonths(db, c.tenantId, false); const live = svc.liveScorecard(db, c.tenantId, months, svc.loadSettings(db, c.tenantId));
    if (!live) throw new HttpError(400, 'There is no financial data to score yet.');
    if (publish && months.at(-1)!.status !== 'approved') throw new HttpError(409, `${live.period} has not been approved. Approve the period before publishing its scorecard.`);
    const commentary: Record<string, { grade?: string; comment?: string }> = {};
    { const x = c.body.commentary?.tax; if (x && (x.comment || x.grade)) commentary.tax = { comment: str(x.comment ?? '', 'Comment', 1000, false), ...(x.grade ? { grade: oneOf(x.grade, 'Grade', ['Great', 'Good', 'OK', 'Caution', 'N/A'] as const) } : {}) }; }
    for (const m of live.scorecard.measures) { const x = c.body.commentary?.[m.key]; if (!x) continue; commentary[m.key] = { comment: str(x.comment, 'Comment', 1000, false), ...(x.grade ? { grade: oneOf(x.grade, 'Grade', ['Great', 'Good', 'OK', 'Caution', 'N/A'] as const) } : {}) }; }
    const id = live.id ?? uid(); const notes = str(c.body.internalNotes, 'Internal notes', 4000, false);
    db.run(`INSERT INTO scorecards (id, tenant_id, period, status, snapshot_json, commentary_json, internal_notes, engine_version, published_by, published_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT (tenant_id, period) DO UPDATE SET status = excluded.status, snapshot_json = excluded.snapshot_json, commentary_json = excluded.commentary_json, internal_notes = excluded.internal_notes, engine_version = excluded.engine_version, published_by = excluded.published_by, published_at = excluded.published_at, updated_at = excluded.updated_at`,
      id, c.tenantId, live.period, publish ? 'published' : 'draft', JSON.stringify(live.scorecard), JSON.stringify(commentary), notes, ENGINE_VERSION, publish ? c.session.user.id : null, publish ? now() : null, now());
    db.audit(c.tenantId, c.session.user.id, publish ? 'scorecard.published' : 'scorecard.saved', 'scorecard', id, { period: live.period });
    return { id, period: live.period, status: publish ? 'published' : 'draft' };
  }, { perm: 'view_internal' });

  // ---------- data sources: imports & mappings ----------
  const BASES = ['accrual', 'cash', 'unknown'] as const;
  const fileOf = (c: Ctx) => {
    const filename = str(c.body.filename, 'File name', 200); const b64 = str(c.body.contentBase64, 'File content', app.cfg.maxUploadBytes * 1.4);
    const data = Buffer.from(b64, 'base64'); if (!data.length || data.length > app.cfg.maxUploadBytes) throw new HttpError(413, 'The file is empty or too large.');
    return { filename, data };
  };
  const wrap = <X>(fn: () => X): X => { try { return fn(); } catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(422, (e as Error).message); } };
  app.on('POST', `${T}/imports/preview`, (c) => { const f = fileOf(c); return { sheets: wrap(() => imp.preview(f.filename, f.data)) }; }, { perm: 'import' });
  app.on('POST', `${T}/imports`, (c) => { const f = fileOf(c); const r = wrap(() => imp.stage(db, c.tenantId, c.session.user.id, { ...f, statement: oneOf(c.body.statement, 'Statement', ['pnl', 'bs'] as const), sheet: c.body.sheet ? str(c.body.sheet, 'Sheet', 100) : undefined })); db.run('UPDATE import_batches SET accounting_basis = ? WHERE id = ? AND tenant_id = ?', oneOf(c.body.basis ?? 'unknown', 'Accounting basis', BASES), r.batchId, c.tenantId); return imp.review(db, c.tenantId, r.batchId); }, { perm: 'import' });
  app.on('PUT', `${T}/imports/:id/basis`, (c) => { const b = db.get('SELECT id FROM import_batches WHERE id = ? AND tenant_id = ?', c.params.id, c.tenantId); if (!b) throw notFound(); const basis = oneOf(c.body.basis, 'Accounting basis', BASES); db.run('UPDATE import_batches SET accounting_basis = ? WHERE id = ? AND tenant_id = ?', basis, b.id, c.tenantId); db.audit(c.tenantId, c.session.user.id, 'import.basis_set', 'import_batch', b.id, { basis }); return { ok: true }; }, { perm: 'import' });
  app.on('GET', `${T}/imports`, (c) => ({ batches: db.all('SELECT b.id, b.statement, b.filename, b.sheet, b.status, b.accounting_basis, b.period_from, b.period_to, b.row_count, b.created_at, b.committed_at, b.rolled_back_at, u.name AS created_by FROM import_batches b JOIN users u ON u.id = b.created_by WHERE b.tenant_id = ? ORDER BY b.created_at DESC', c.tenantId) }), { perm: 'import' });
  app.on('GET', `${T}/imports/:id`, (c) => { const r = imp.review(db, c.tenantId, c.params.id); if (!r) throw notFound(); return r; }, { perm: 'import' });
  app.on('POST', `${T}/imports/:id/commit`, (c) => { const r = imp.commit(db, c.tenantId, c.session.user.id, c.params.id, c.body.acknowledgeWarnings === true); if (!r.ok) throw new HttpError(409, r.error, { issues: r.issues }); return r; }, { perm: 'import' });
  app.on('POST', `${T}/imports/:id/rollback`, (c) => { if (!imp.rollback(db, c.tenantId, c.session.user.id, c.params.id)) throw new HttpError(409, 'Only a committed import can be rolled back.'); return { ok: true }; }, { perm: 'approve' });
  app.on('GET', `${T}/accounts`, (c) => ({ accounts: db.all('SELECT id, statement, name, line, sign FROM accounts WHERE tenant_id = ? ORDER BY statement DESC, name', c.tenantId).map((a) => ({ ...a, suggested: a.line ? null : imp.suggestLine(a.statement, a.name) })) }), { perm: 'mapping' });
  app.on('PUT', `${T}/accounts`, (c) => {
    const list = Array.isArray(c.body.mappings) ? c.body.mappings : []; if (!list.length || list.length > 2000) throw new HttpError(400, 'Provide between 1 and 2000 mappings.');
    db.tx(() => {
      for (const m of list) {
        const a = db.get('SELECT id, statement FROM accounts WHERE id = ? AND tenant_id = ?', str(m.id, 'Account', 60), c.tenantId); if (!a) throw notFound();
        const line = m.line === null ? null : oneOf(m.line, 'Line', imp.validLines(a.statement)); const sign = m.sign === -1 ? -1 : 1;
        db.run('UPDATE accounts SET line = ?, sign = ? WHERE id = ? AND tenant_id = ?', line, sign, a.id, c.tenantId);
      }
      // Changing a mapping changes reported history, so affected approved periods return to preliminary.
      db.run("UPDATE period_status SET status = 'preliminary', updated_by = ?, updated_at = ? WHERE tenant_id = ? AND status <> 'preliminary' AND period IN (SELECT DISTINCT f.period FROM facts f WHERE f.tenant_id = ? AND f.active = 1 AND f.account_id IN (" + list.map(() => '?').join(',') + '))', c.session.user.id, now(), c.tenantId, c.tenantId, ...list.map((m: any) => String(m.id)));
      db.audit(c.tenantId, c.session.user.id, 'mapping.updated', 'account', undefined, { count: list.length });
    });
    return { ok: true };
  }, { perm: 'mapping' });

  // ---------- weekly pulse ----------
  app.on('GET', `${T}/weekly`, (c) => svc.weeklyData(db, c.tenantId, clientOnly(c)), { perm: 'view' });
  app.on('PUT', `${T}/weekly/entries`, (c) => {
    const s = svc.loadSettings(db, c.tenantId); const d = isoDate(c.body.weekStart, 'Week start');
    if (weekStart(d, s.weekStartDay) !== d) throw new HttpError(400, `Weeks for this client start on ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][s.weekStartDay]}. ${d} is not a week start.`);
    if (db.get("SELECT id FROM weekly_reports WHERE tenant_id = ? AND week_start = ? AND status = 'published'", c.tenantId, d)) throw new HttpError(409, 'A report for this week has been published. Published weeks are not rewritten.');
    const m = (v: unknown, n: string) => int(v, n, { min: 0, max: MONEY_MAX });
    db.run(`INSERT INTO weekly_entries (tenant_id, week_start, revenue_cents, cogs_cents, direct_labor_cents, other_labor_cents, cash_balance_cents, source, entered_by, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT (tenant_id, week_start) DO UPDATE SET revenue_cents = excluded.revenue_cents, cogs_cents = excluded.cogs_cents, direct_labor_cents = excluded.direct_labor_cents, other_labor_cents = excluded.other_labor_cents, cash_balance_cents = excluded.cash_balance_cents, source = excluded.source, entered_by = excluded.entered_by, updated_at = excluded.updated_at`,
      c.tenantId, d, m(c.body.revenueCents, 'Sales'), m(c.body.cogsCents, 'Direct costs'), m(c.body.directLaborCents, 'Direct labor'), int(c.body.otherLaborCents, 'Office and management payroll', { nullable: true, min: 0, max: MONEY_MAX }), int(c.body.cashBalanceCents, 'Cash balance', { nullable: true, min: -MONEY_MAX, max: MONEY_MAX }), str(c.body.source, 'Source', 120, false) || 'Manual weekly entry', c.session.user.id, now());
    db.audit(c.tenantId, c.session.user.id, 'weekly.entry_saved', 'weekly_entry', d);
    return { ok: true };
  }, { perm: 'weekly_entry' });
  const reportRow = (c: Ctx, id: string) => { const r = db.get(`SELECT * FROM weekly_reports WHERE id = ? AND tenant_id = ? ${clientOnly(c) ? "AND status = 'published'" : ''}`, id, c.tenantId); if (!r) throw notFound(); return r; };
  const reportOut = (c: Ctx, r: any) => ({ id: r.id, weekStart: r.week_start, status: r.status, snapshot: JSON.parse(r.snapshot_json), briefing: JSON.parse(r.briefing_json), nextSteps: JSON.parse(r.next_steps_json), publishedAt: r.published_at, acknowledgedAt: r.acknowledged_at, ...(c.access.can('view_internal') ? { internalNotes: r.internal_notes } : {}), comments: commentsFor(c, 'weekly_report', r.id) });
  app.on('POST', `${T}/weekly/reports`, (c) => {
    const week = isoDate(c.body.weekStart, 'Week start'); const ex = db.get('SELECT id, status FROM weekly_reports WHERE tenant_id = ? AND week_start = ?', c.tenantId, week);
    if (ex?.status === 'published') throw new HttpError(409, 'This week has already been published.');
    const built = svc.buildWeeklySnapshot(db, c.tenantId, week); if (!built) throw new HttpError(400, 'Enter the weekly figures for that week first.');
    const id = ex?.id ?? uid();
    db.run(`INSERT INTO weekly_reports (id, tenant_id, week_start, status, snapshot_json, briefing_json, updated_at) VALUES (?,?,?,'draft',?,?,?) ON CONFLICT (tenant_id, week_start) DO UPDATE SET snapshot_json = excluded.snapshot_json, briefing_json = excluded.briefing_json, updated_at = excluded.updated_at`, id, c.tenantId, week, JSON.stringify(built.snapshot), JSON.stringify(built.briefing), now());
    db.audit(c.tenantId, c.session.user.id, 'weekly.report_drafted', 'weekly_report', id);
    return reportOut(c, reportRow(c, id));
  }, { perm: 'weekly_entry' });
  app.on('GET', `${T}/weekly/reports/:id`, (c) => reportOut(c, reportRow(c, c.params.id)), { perm: 'view' });
  app.on('PUT', `${T}/weekly/reports/:id`, (c) => {
    const r = reportRow(c, c.params.id); if (r.status === 'published') throw new HttpError(409, 'Published reports are archived and cannot be edited.');
    const publish = c.body.publish === true; if (publish && !c.access.can('publish')) throw new HttpError(403, 'Your role cannot publish reports.');
    const b = c.body.briefing ?? {}; const briefing = Object.fromEntries(['performance', 'improved', 'attention', 'actions', 'watch'].map((k) => [k, str(b[k], 'Briefing section', 3000, false)]));
    const steps = (Array.isArray(c.body.nextSteps) ? c.body.nextSteps : []).slice(0, 10).map((s: any) => ({ text: str(s.text, 'Next step', 400), owner: str(s.owner, 'Owner', 80, false), due: isoDate(s.due, 'Due date', true) }));
    if (publish && !steps.length) throw new HttpError(400, 'Add at least one specific next step before publishing.');
    db.run('UPDATE weekly_reports SET briefing_json = ?, next_steps_json = ?, internal_notes = ?, status = ?, published_by = ?, published_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ?', JSON.stringify(briefing), JSON.stringify(steps), str(c.body.internalNotes, 'Internal notes', 4000, false), publish ? 'published' : 'draft', publish ? c.session.user.id : null, publish ? now() : null, now(), r.id, c.tenantId);
    db.audit(c.tenantId, c.session.user.id, publish ? 'weekly.report_published' : 'weekly.report_saved', 'weekly_report', r.id);
    return reportOut(c, reportRow(c, r.id));
  }, { perm: 'weekly_entry' });
  app.on('POST', `${T}/weekly/reports/:id/acknowledge`, (c) => { const r = reportRow(c, c.params.id); if (r.status !== 'published') throw new HttpError(409, 'Only published reports can be acknowledged.'); db.run('UPDATE weekly_reports SET acknowledged_by = ?, acknowledged_at = ? WHERE id = ? AND tenant_id = ?', c.session.user.id, now(), r.id, c.tenantId); db.audit(c.tenantId, c.session.user.id, 'weekly.report_acknowledged', 'weekly_report', r.id); return { ok: true }; }, { perm: 'acknowledge' });

  // ---------- comments & questions (client-visible vs internal) ----------
  const ENTITIES = ['weekly_report', 'scenario', 'action', 'question', 'scorecard'] as const;
  function commentsFor(c: Ctx, entity: string, id: string) {
    return db.all(`SELECT m.id, m.body, m.visibility, m.created_at, u.name AS author, u.staff_role IS NOT NULL AS from_advisor FROM comments m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = ? AND m.entity = ? AND m.entity_id = ? ${c.access.can('view_internal') ? '' : "AND m.visibility = 'client'"} ORDER BY m.created_at`, c.tenantId, entity, id);
  }
  app.on('GET', `${T}/comments`, (c) => ({ comments: commentsFor(c, oneOf(c.query.get('entity'), 'Entity', ENTITIES), str(c.query.get('id'), 'ID', 60)) }), { perm: 'view' });
  app.on('POST', `${T}/comments`, (c) => {
    const entity = oneOf(c.body.entity, 'Entity', ENTITIES); const entityId = entity === 'question' ? 'advisor' : str(c.body.entityId, 'ID', 60);
    const table = { weekly_report: 'weekly_reports', scenario: 'scenarios', action: 'actions', scorecard: 'scorecards' }[entity as string];
    if (table && !db.get(`SELECT id FROM ${table} WHERE id = ? AND tenant_id = ?`, entityId, c.tenantId)) throw notFound();
    const visibility = c.body.visibility === 'internal' && c.access.can('view_internal') ? 'internal' : 'client';
    const id = uid(); db.run('INSERT INTO comments (id, tenant_id, entity, entity_id, user_id, body, visibility, created_at) VALUES (?,?,?,?,?,?,?,?)', id, c.tenantId, entity, entityId, c.session.user.id, str(c.body.body, 'Comment', 2000), visibility, now());
    db.audit(c.tenantId, c.session.user.id, 'comment.created', entity, entityId, { visibility });
    return { id };
  }, { perm: 'comment' });

  // ---------- cash flow ----------
  // ---------- client communications (firm staff only; client roles have no route into any of this) ----------
  const commsFor = (c: Ctx, note?: unknown) => comms.gather(db, c.tenantId, { advisorName: c.session.user.name.replace(/\s*\(.*\)\s*$/, ''), publicUrl: app.cfg.publicUrl, personalNote: note === undefined ? '' : str(note, 'Personal note', 2000, false) });
  const readyComms = (c: Ctx, note?: unknown) => { const g = commsFor(c, note); if (!g.ready) throw new HttpError(409, g.reason); return g; };
  app.on('GET', `${T}/comms`, (c) => {
    const g = commsFor(c, c.query.get('note') ?? ''); const t = comms.template(db, c.tenantId); if (!g.ready) return { ready: false, reason: g.reason, template: t, mergeFields: MERGE_FIELDS };
    return { ready: true, period: g.period, clientName: g.clientName, notices: g.notices, template: t, mergeFields: MERGE_FIELDS, values: g.vars, draft: comms.draft(db, c.tenantId, g), recipients: g.contacts, packetName: comms.packetName(g), script: g.script, scriptText: comms.scriptText(g.script), scorecardPublished: g.scorecardPublished };
  }, { perm: 'view_internal' });
  app.on('PUT', `${T}/comms/template`, (c) => {
    if (c.body.reset === true) { db.run('DELETE FROM comm_templates WHERE tenant_id = ?', c.tenantId); db.audit(c.tenantId, c.session.user.id, 'comms.template_reset', 'tenant', c.tenantId); return comms.template(db, c.tenantId); }
    const subject = str(c.body.subject, 'Subject', 200), body = str(c.body.body, 'Message', 8000); const known = Object.fromEntries(MERGE_FIELDS.map(([k]) => [k, 'x']));
    const bad = [...renderTemplate(subject, known).unknown, ...renderTemplate(body, known).unknown]; if (bad.length) throw new HttpError(400, `Unknown merge field: {{${bad[0]}}}. Use one of the fields listed.`);
    db.run('INSERT INTO comm_templates (tenant_id, subject, body, updated_by, updated_at) VALUES (?,?,?,?,?) ON CONFLICT (tenant_id) DO UPDATE SET subject = excluded.subject, body = excluded.body, updated_by = excluded.updated_by, updated_at = excluded.updated_at', c.tenantId, subject, body, c.session.user.id, now());
    db.audit(c.tenantId, c.session.user.id, 'comms.template_saved', 'tenant', c.tenantId); return comms.template(db, c.tenantId);
  }, { perm: 'view_internal' });
  app.on('GET', `${T}/comms/packet.pdf`, (c) => {
    const g = readyComms(c); const pdf = comms.packetPdf(g, c.session.user.name.replace(/\s*\(.*\)\s*$/, '')); db.audit(c.tenantId, c.session.user.id, 'comms.packet_generated', 'period', g.period);
    c.res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${comms.packetName(g)}"`, 'Cache-Control': 'no-store' }); c.res.end(pdf);
  }, { perm: 'view_internal', raw: true });
  app.on('POST', `${T}/comms/email.eml`, (c) => {
    const g = readyComms(c); const to = (Array.isArray(c.body.to) ? c.body.to : []).slice(0, 10).map((x: unknown) => str(x, 'Recipient', 200)); for (const a of to) if (!/^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/.test(a)) throw new HttpError(400, `"${a}" is not an email address.`);
    const subject = str(c.body.subject, 'Subject', 300), body = str(c.body.body, 'Message', 20000); if (/\{\{\s*[a-z_]+\s*\}\}/.test(subject + body)) throw new HttpError(400, 'The draft still contains an unfilled {{field}}. Fill it in or remove it first.');
    const eml = comms.emailFile({ to, subject, body, attachment: comms.packetPdf(g, c.session.user.name.replace(/\s*\(.*\)\s*$/, '')), filename: comms.packetName(g) });
    db.audit(c.tenantId, c.session.user.id, 'comms.email_draft_generated', 'period', g.period, { recipients: to.length });
    c.res.writeHead(200, { 'Content-Type': 'message/rfc822', 'Content-Disposition': `attachment; filename="${comms.packetName(g).replace(/\.pdf$/, '.eml')}"`, 'Cache-Control': 'no-store' }); c.res.end(eml);
  }, { perm: 'view_internal', raw: true });

  // ---------- what-if forecast ----------
  const levers = (b: any) => {
    const out: Record<string, unknown> = {}; if (!b || typeof b !== 'object') return out;
    const rng = (k: string, n: string, lo: number, hi: number) => { if (b[k] === undefined) return; const x = num(b[k], n); if (x < lo || x > hi) throw new HttpError(400, `${n} is out of range.`); out[k] = x; };
    const money = (k: string, n: string, lo: number) => { if (b[k] !== undefined) out[k] = int(b[k], n, { min: lo, max: MONEY_MAX }); };
    rng('salesChangePct', 'Sales change', -0.9, 3); rng('grossProfitPct', 'Gross profit', 0, 1); money('payrollChangeMonthlyCents', 'Payroll change', -MONEY_MAX); money('overheadChangeMonthlyCents', 'Expense change', -MONEY_MAX); money('debtPaydownMonthlyCents', 'Debt pay-down', 0); money('purchasesMonthlyCents', 'Purchases', 0);
    if (b.dsoDays !== undefined && b.dsoDays !== null) rng('dsoDays', 'Days to collect', 0, 365); if (b.distributionPolicy !== undefined) out.distributionPolicy = oneOf(b.distributionPolicy, 'Distributions', ['tax_only', 'tax_then_excess', 'none'] as const);
    return out;
  };
  app.on('GET', `${T}/what-if`, (c) => svc.whatIfForecast(db, c.tenantId, clientOnly(c)), { perm: 'view' });
  app.on('POST', `${T}/what-if`, (c) => svc.whatIfForecast(db, c.tenantId, clientOnly(c), levers(c.body.levers)), { perm: 'view' });

  // ---------- P&L line drill-down ----------
  app.on('GET', `${T}/financials/line-accounts`, (c) => { const r = svc.lineAccounts(db, c.tenantId, oneOf(c.query.get('line'), 'Line', svc.DRILL_LINES as any), period(c.query.get('to')), clientOnly(c)); if (!r) throw notFound(); return r; }, { perm: 'view' });
  // ---------- daily cash report and two-week cash flow forecast ----------
  app.on('GET', `${T}/cash-reports`, (c) => svc.cashReports(db, c.tenantId, clientOnly(c)), { perm: 'view' });
  // Only the client owner decides whether SJATS staff may work with the client's bank information. Staff cannot grant it to themselves.
  app.on('PUT', `${T}/bank-feed-consent`, (c) => {
    if (c.access.role !== 'client_owner') throw new HttpError(403, 'Only the client owner can allow or withdraw access to bank information.');
    if (typeof c.body.allowed !== 'boolean') throw new HttpError(400, 'Say whether access is allowed.');
    db.run('INSERT INTO bank_feed_consent (tenant_id, allowed, decided_by, decided_at) VALUES (?,?,?,?) ON CONFLICT (tenant_id) DO UPDATE SET allowed = excluded.allowed, decided_by = excluded.decided_by, decided_at = excluded.decided_at', c.tenantId, c.body.allowed ? 1 : 0, c.session.user.id, now());
    db.audit(c.tenantId, c.session.user.id, c.body.allowed ? 'bank_feed.consent_granted' : 'bank_feed.consent_withdrawn', 'tenant', c.tenantId);
    return svc.bankFeedConsent(db, c.tenantId);
  }, { perm: 'view' });
  app.on('PUT', `${T}/daily-cash`, (c) => {
    if (c.access.isStaff && !svc.bankFeedConsent(db, c.tenantId).allowed) throw new HttpError(403, 'The client has not allowed SJATS access to their bank information. The client owner can allow it on the Cash Flow page.');
    const date = isoDate(c.body.date, 'Date'); if (date > now().slice(0, 10)) throw new HttpError(400, 'A daily cash report cannot be dated in the future.');
    const m = (v: unknown, n: string) => int(v, n, { min: 0, max: MONEY_MAX });
    const deposits = (Array.isArray(c.body.deposits) ? c.body.deposits : []).slice(0, 50).map((d: any) => ({ payer: str(d.payer, 'Payer', 120), cents: m(d.cents, 'Payment') }));
    const a = c.body.aging; const aging = a ? { d0_30: m(a.d0_30 ?? 0, 'Aging'), d31_60: m(a.d31_60 ?? 0, 'Aging'), d61_90: m(a.d61_90 ?? 0, 'Aging'), over90: m(a.over90 ?? 0, 'Aging') } : null;
    db.run(`INSERT INTO daily_cash (tenant_id, date, cash_balance_cents, deposits_json, ar_aging_json, missed_owner_pay_cents, entered_by, updated_at) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT (tenant_id, date) DO UPDATE SET cash_balance_cents = excluded.cash_balance_cents, deposits_json = excluded.deposits_json, ar_aging_json = excluded.ar_aging_json, missed_owner_pay_cents = excluded.missed_owner_pay_cents, entered_by = excluded.entered_by, updated_at = excluded.updated_at`,
      c.tenantId, date, int(c.body.cashBalanceCents, 'Cash balance', { min: -MONEY_MAX, max: MONEY_MAX }), JSON.stringify(deposits), aging ? JSON.stringify(aging) : null, int(c.body.missedOwnerPayCents, 'Missed owner pay', { nullable: true, min: 0, max: MONEY_MAX }), c.session.user.id, now());
    db.audit(c.tenantId, c.session.user.id, 'daily_cash.saved', 'daily_cash', date);
    return { ok: true };
  }, { perm: 'daily_cash' });
  app.on('GET', `${T}/four-forces`, (c) => svc.fourForcesView(db, c.tenantId, clientOnly(c)), { perm: 'view' });
  /** Record taxes already paid (or distributed to owners for tax) for a fiscal year, so the set-aside reflects only what is still owed. */
  app.on('PUT', `${T}/four-forces/taxes-paid`, (c) => {
    const year = String(int(c.body.fiscalYear, 'Fiscal year', { min: 2000, max: 2100 })); const cur = svc.loadSettings(db, c.tenantId);
    const next = { ...cur, taxesPaid: { ...cur.taxesPaid }, taxProjected: { ...cur.taxProjected } };
    if (c.body.cents !== undefined) next.taxesPaid[year] = int(c.body.cents, 'Taxes paid', { min: 0, max: MONEY_MAX });
    // Projected tax from tax planning: a number reserves that amount; null clears it and returns to rate × profit.
    if (c.body.projectedCents !== undefined) { if (c.body.projectedCents === null) delete next.taxProjected[year]; else next.taxProjected[year] = int(c.body.projectedCents, 'Projected tax', { min: 0, max: MONEY_MAX }); }
    db.run('UPDATE tenants SET settings_json = ? WHERE id = ?', JSON.stringify(next), c.tenantId); db.audit(c.tenantId, c.session.user.id, 'four_forces.tax_inputs', 'tenant', c.tenantId, { year, paid: next.taxesPaid[year] ?? 0, projected: next.taxProjected[year] ?? null });
    return { ok: true };
  }, { perm: 'adjust' });
  app.on('GET', `${T}/cash`, (c) => svc.cashForecast(db, c.tenantId, clientOnly(c)), { perm: 'view' });
  const cashFields = (b: any): Omit<CashItem, 'id'> => {
    const direction = oneOf(b.direction, 'Direction', ['in', 'out'] as const);
    return { name: str(b.name, 'Name', 120), direction, category: oneOf(b.category, 'Category', CASH_CATEGORIES[direction] as readonly string[]), amountCents: int(b.amountCents, 'Amount', { min: 0, max: MONEY_MAX }), cadence: oneOf(b.cadence, 'Cadence', CADENCES), anchorDate: isoDate(b.anchorDate, 'Date'), endDate: isoDate(b.endDate, 'End date', true), secondDay: int(b.secondDay, 'Second day', { nullable: true, min: 1, max: 31 }), active: b.active !== false };
  };
  /** What-if on the 13-week forecast. Nothing is saved; the stored cash plan is untouched. */
  app.on('POST', `${T}/cash/what-if`, (c) => {
    const delays = (Array.isArray(c.body.delays) ? c.body.delays : []).slice(0, 20).map((d: any) => ({ itemId: str(d.itemId, 'Item', 60), days: int(d.days, 'Days', { min: -90, max: 180 }) }));
    const extra = (Array.isArray(c.body.extra) ? c.body.extra : []).slice(0, 20).map((e: any, i: number) => ({ id: `what-if-${i}`, ...cashFields(e) }));
    const scale = c.body.scaleInflowsPct === undefined || c.body.scaleInflowsPct === null ? undefined : num(c.body.scaleInflowsPct, 'Sales change'); if (scale !== undefined && (scale < -1 || scale > 5)) throw new HttpError(400, 'Sales change is out of range.');
    return svc.cashForecast(db, c.tenantId, clientOnly(c), { delays, extra, scaleInflowsPct: scale });
  }, { perm: 'view' });
  app.on('POST', `${T}/cash/items`, (c) => { const f = cashFields(c.body); const id = uid(); db.run('INSERT INTO cash_items (id, tenant_id, name, direction, category, amount_cents, cadence, anchor_date, end_date, second_day, active) VALUES (?,?,?,?,?,?,?,?,?,?,?)', id, c.tenantId, f.name, f.direction, f.category, f.amountCents, f.cadence, f.anchorDate, f.endDate, f.secondDay, f.active ? 1 : 0); db.audit(c.tenantId, c.session.user.id, 'cash.item_created', 'cash_item', id); return { id }; }, { perm: 'weekly_entry' });
  app.on('PUT', `${T}/cash/items/:id`, (c) => { const f = cashFields(c.body); const r = db.run('UPDATE cash_items SET name=?, direction=?, category=?, amount_cents=?, cadence=?, anchor_date=?, end_date=?, second_day=?, active=? WHERE id=? AND tenant_id=?', f.name, f.direction, f.category, f.amountCents, f.cadence, f.anchorDate, f.endDate, f.secondDay, f.active ? 1 : 0, c.params.id, c.tenantId); if (!r.changes) throw notFound(); db.audit(c.tenantId, c.session.user.id, 'cash.item_updated', 'cash_item', c.params.id); return { ok: true }; }, { perm: 'weekly_entry' });
  app.on('DELETE', `${T}/cash/items/:id`, (c) => { const r = db.run('DELETE FROM cash_items WHERE id = ? AND tenant_id = ?', c.params.id, c.tenantId); if (!r.changes) throw notFound(); db.audit(c.tenantId, c.session.user.id, 'cash.item_deleted', 'cash_item', c.params.id); return { ok: true }; }, { perm: 'weekly_entry' });

  // ---------- Decision Lab: scenarios ----------
  const scenarioGate = (c: Ctx) => { if (!c.access.isStaff && !svc.loadSettings(db, c.tenantId).clientCanRunScenarios) throw new HttpError(403, 'Scenario planning has not been enabled for your account. Ask your advisor.'); };
  app.on('GET', `${T}/scenarios/baseline`, (c) => { const r = svc.hiringBaseline(db, c.tenantId, clientOnly(c)); if ('error' in r) throw new HttpError(409, r.error); return r; }, { perm: 'view' });
  // Clients see their own scenarios plus anything shared; staff see everything for the tenant.
  const visibleScenario = (c: Ctx) => (c.access.isStaff ? '' : "AND (s.created_by = ? OR s.status <> 'draft')");
  app.on('GET', `${T}/scenarios`, (c) => ({ scenarios: db.all(`SELECT s.id, s.type, s.name, s.status, s.baseline_period, s.result_json, s.updated_at, u.name AS created_by FROM scenarios s JOIN users u ON u.id = s.created_by WHERE s.tenant_id = ? ${visibleScenario(c)} ORDER BY s.updated_at DESC`, ...(c.access.isStaff ? [c.tenantId] : [c.tenantId, c.session.user.id])).map((s) => ({ ...s, result_json: undefined, summary: summarize(s.type, s.result_json) })) }), { perm: 'view' });
  function summarize(type: string, json: string | null) {
    if (!json) return null; const r = JSON.parse(json);
    if (type === 'hiring') return { revenue: r.scenario.revenue, grossProfit: r.scenario.grossProfit, pretax: r.scenario.pretax, marginPct: r.scenario.adjustedPretaxPct.value, minCash: r.scenario.minCash, endCash: r.scenario.endCash, dLER: r.scenario.dLER.value, tLER: r.scenario.tLER.value, investment: r.cost.firstYearCents, breakEven: r.paybackMonth, baseline: { revenue: r.baseline.revenue, grossProfit: r.baseline.grossProfit, pretax: r.baseline.pretax, marginPct: r.baseline.adjustedPretaxPct.value, minCash: r.baseline.minCash, endCash: r.baseline.endCash, dLER: r.baseline.dLER.value, tLER: r.baseline.tLER.value } };
    if (type === 'forecast') return { pretaxDelta: r.summary.vsBaseline.pretax, endCash: r.summary.next12.endCash, minCash: r.summary.next12.minCash, pretaxPct: r.summary.next12.pretaxPct.value };
    if (type === 'buy_in') return { businessValue: r.businessValueCents, buyerOwnership: r.buyerOwnership };
    if (type === 'valuation') return { value: r.valueCents, method: r.method };
    if (type === 'profit_levels') return { levels: r.map((x: any) => ({ level: x.level, endingValue: x.endingValueCents })) };
    return { requiredPretax: r.requiredPretaxCents, requiredRevenue: r.requiredRevenueCents, gap: r.gapCents };
  }
  /** Results are always recomputed on the server from the stored inputs — the browser's numbers are a preview only. */
  function compute(c: Ctx, type: string, inputs: any) {
    if (type === 'hiring') {
      const b = svc.hiringBaseline(db, c.tenantId, clientOnly(c)); if ('error' in b) throw new HttpError(409, b.error);
      const i = sanitizeHiring(inputs); return { inputs: i, result: evaluateHire(i, b.baseline, b.settings), baselinePeriod: b.baseline.asOf };
    }
    if (type === 'valuation') {
      const months = svc.loadMonths(db, c.tenantId, clientOnly(c)); if (!months.length) throw new HttpError(409, 'No financial history is available yet.'); const st = svc.loadSettings(db, c.tenantId);
      const r01 = (v: unknown, n: string, max = 0.95) => { const x = num(v ?? 0, n); if (x < 0 || x > max) throw new HttpError(400, `${n} is out of range.`); return x; }; const mult = (v: unknown, n: string) => { const x = num(v ?? 0, n); if (x < 0 || x > 50) throw new HttpError(400, `${n} is out of range.`); return x; };
      const el: Record<string, { rating: any; note: string }> = {}; for (const [k] of VALUE_ELEMENTS) { const e = inputs.elements?.[k]; if (e) el[k] = { rating: e.rating == null ? null : oneOf(e.rating, 'Rating', ['strong', 'adequate', 'weak'] as const), note: str(e.note ?? '', 'Note', 500, false) }; }
      const stake = r01(inputs.stakePct ?? 0.5, 'Interest being valued', 1); if (stake <= 0) throw new HttpError(400, 'Interest being valued must be greater than zero.');
      const i = { equityAdjustmentCents: int(inputs.equityAdjustmentCents ?? 0, 'Equity adjustment', { min: -MONEY_MAX, max: MONEY_MAX }), equityAdjustmentNote: str(inputs.equityAdjustmentNote ?? '', 'Reason', 500, false), stakePct: stake, marketabilityDiscount: r01(inputs.marketabilityDiscount ?? 0.2, 'Marketability discount', 0.6), controlDiscount: r01(inputs.controlDiscount ?? 0.2, 'Control discount', 0.6), noteRate: r01(inputs.noteRate ?? 0.07, 'Interest rate', 0.5), noteYears: int(inputs.noteYears ?? 5, 'Note term', { min: 1, max: 30 }), taxRate: r01(inputs.taxRate ?? st.taxReserveRate, 'Tax rate'), ebitdaMultiple: mult(inputs.ebitdaMultiple ?? 5, 'EBITDA multiple'), revenueMultiple: mult(inputs.revenueMultiple ?? 1, 'Revenue multiple'), elements: el };
      const base = svc.valuationBase(db, c.tenantId, months, st); // figures always come from the server, never from the request
      return { inputs: i, result: { ...valuation(base, i), base }, baselinePeriod: months.at(-1)!.period };
    }
    if (type === 'profit_levels') {
      const r01 = (v: unknown, n: string, max: number) => { const x = num(v, n); if (x < 0 || x > max) throw new HttpError(400, `${n} is out of range.`); return x; };
      if (!Array.isArray(inputs.revenueCents) || inputs.revenueCents.length < 1 || inputs.revenueCents.length > 10) throw new HttpError(400, 'Enter between one and ten years of revenue.'); if (!Array.isArray(inputs.levels) || inputs.levels.length < 1 || inputs.levels.length > 4) throw new HttpError(400, 'Enter between one and four profit tiers.');
      const i = { startEquityCents: int(inputs.startEquityCents ?? 0, 'Starting equity', { min: -MONEY_MAX, max: MONEY_MAX }), revenueCents: inputs.revenueCents.map((v: unknown) => int(v, 'Revenue', { min: 0, max: MONEY_MAX })), levels: inputs.levels.map((v: unknown) => { const x = num(v, 'Profit tier'); if (x < -0.5 || x > 0.9) throw new HttpError(400, 'Profit tier is out of range.'); return x; }),
        taxRate: r01(inputs.taxRate ?? 0.4, 'Tax rate', 0.95), coreCapitalMonths: r01(inputs.coreCapitalMonths ?? 2, 'Operating reserve months', 24), firstProfitDistributionYear: int(inputs.firstProfitDistributionYear ?? 3, 'First distribution year', { min: 1, max: 11 }), marketabilityDiscount: r01(inputs.marketabilityDiscount ?? 0.2, 'Marketability discount', 0.6), controlDiscount: r01(inputs.controlDiscount ?? 0.2, 'Control discount', 0.6) };
      return { inputs: i, result: profitLevels(i), baselinePeriod: svc.loadMonths(db, c.tenantId, clientOnly(c)).at(-1)?.period ?? null };
    }
    if (type === 'forecast') {
      const r = svc.whatIfForecast(db, c.tenantId, clientOnly(c), levers(inputs)); if (!r.available) throw new HttpError(409, r.reason ?? 'A forecast is not available yet.');
      return { inputs: (r as any).levers, result: r, baselinePeriod: (r as any).basePeriod };
    }
    if (type === 'buy_in') {
      const m2 = (v: unknown, n: string) => int(v ?? 0, n, { min: -MONEY_MAX, max: MONEY_MAX }); const r01 = (v: unknown, n: string) => { const x = num(v ?? 0, n); if (x < 0 || x > 0.95) throw new HttpError(400, `${n} must be between 0% and 95%.`); return x; };
      const mult = num(inputs.profitMultiple ?? 3, 'Profit multiple'); if (mult < 0 || mult > 20) throw new HttpError(400, 'Profit multiple is out of range.'); const sh = num(inputs.sharesOutstanding ?? 0, 'Shares outstanding'); if (sh <= 0 || sh > 1e12) throw new HttpError(400, 'Shares outstanding must be greater than zero.');
      const i = { grossBonusCents: int(inputs.grossBonusCents ?? 0, 'Bonus', { min: 0, max: MONEY_MAX }), bonusTaxRate: r01(inputs.bonusTaxRate, 'Tax on the bonus'), avgPretaxCents: m2(inputs.avgPretaxCents, 'Average pretax profit'), equityCents: m2(inputs.equityCents, 'Equity'), profitMultiple: mult, discountPct: r01(inputs.discountPct, 'Discount'), sharesOutstanding: sh, ownerTaxRate: r01(inputs.ownerTaxRate, 'Owner tax rate') };
      return { inputs: i, result: buyIn(i), baselinePeriod: svc.loadMonths(db, c.tenantId, clientOnly(c)).at(-1)?.period ?? null };
    }
    const s = svc.loadSettings(db, c.tenantId); const months = svc.loadMonths(db, c.tenantId, clientOnly(c)); if (!months.length) throw new HttpError(409, 'No financial history is available yet.');
    const m = (v: unknown, n: string) => int(v ?? 0, n, { min: 0, max: MONEY_MAX }); const rate = num(inputs.estimatedTaxRate ?? 0.25, 'Tax rate'); if (rate < 0 || rate > 0.9) throw new HttpError(400, 'Tax rate must be between 0% and 90%.');
    const i = { debtPrincipalCents: m(inputs.debtPrincipalCents, 'Debt'), assetPurchasesCents: m(inputs.assetPurchasesCents, 'Investments'), savingsGoalCents: m(inputs.savingsGoalCents, 'Savings'), ownerDistributionsCents: m(inputs.ownerDistributionsCents, 'Distributions'), estimatedTaxRate: rate, marketOwnerPayCents: m(inputs.marketOwnerPayCents, 'Owner pay') };
    return { inputs: i, result: profitPlan(i, rolling12(months, months.length - 1, s)!), baselinePeriod: months.at(-1)!.period };
  }
  function sanitizeHiring(x: any): HiringInputs {
    const m = (v: unknown, n: string) => int(v ?? 0, n, { min: 0, max: MONEY_MAX }); const f = (v: unknown, n: string, lo: number, hi: number) => { const y = num(v ?? 0, n); if (y < lo || y > hi) throw new HttpError(400, `${n} is out of range.`); return y; };
    const taxes = (Array.isArray(x.taxes) ? x.taxes : []).slice(0, 12).map((t: any) => ({ name: str(t.name, 'Tax name', 80), rate: f(t.rate, 'Tax rate', 0, 1), wageBaseCents: t.wageBaseCents === null || t.wageBaseCents === undefined ? null : m(t.wageBaseCents, 'Wage base') }));
    return {
      title: str(x.title, 'Position title', 120), startPeriod: period(x.startPeriod), workerType: oneOf(x.workerType, 'Worker type', ['salaried', 'hourly', 'contractor_fixed', 'contractor_hourly'] as const), roleType: oneOf(x.roleType, 'Role type', ['direct', 'management'] as const),
      annualSalaryCents: m(x.annualSalaryCents, 'Salary'), hourlyRateCents: m(x.hourlyRateCents, 'Hourly rate'), hoursPerWeek: f(x.hoursPerWeek, 'Hours per week', 0, 100), overtimeHoursPerWeek: f(x.overtimeHoursPerWeek, 'Overtime hours', 0, 60), overtimeMultiplier: f(x.overtimeMultiplier ?? 1.5, 'Overtime multiplier', 1, 3),
      contractMonthlyFeeCents: m(x.contractMonthlyFeeCents, 'Monthly fee'), taxes, workersCompPct: f(x.workersCompPct, 'Workers comp', 0, 1), healthMonthlyCents: m(x.healthMonthlyCents, 'Health benefits'), retirementMatchPct: f(x.retirementMatchPct, 'Retirement match', 0, 1), otherBenefitsMonthlyCents: m(x.otherBenefitsMonthlyCents, 'Other benefits'),
      ptoDays: f(x.ptoDays, 'PTO days', 0, 100), paidHolidays: f(x.paidHolidays, 'Paid holidays', 0, 30), softwareMonthlyCents: m(x.softwareMonthlyCents, 'Software'), equipmentOneTimeCents: m(x.equipmentOneTimeCents, 'Equipment'), recruitingOneTimeCents: m(x.recruitingOneTimeCents, 'Recruiting'), onboardingOneTimeCents: m(x.onboardingOneTimeCents, 'Onboarding'),
      trainingMonths: int(x.trainingMonths ?? 0, 'Training months', { min: 0, max: 12 }), rampMonths: int(x.rampMonths ?? 0, 'Ramp months', { min: 0, max: 24 }), expectedMonthlyRevenueCents: m(x.expectedMonthlyRevenueCents, 'Expected revenue'),
      grossMarginPct: x.grossMarginPct === null || x.grossMarginPct === undefined ? null : f(x.grossMarginPct, 'Gross margin', 0, 1), billRateCents: x.billRateCents ? m(x.billRateCents, 'Bill rate') : null, replacing: !!x.replacing, replacedMonthlyCostCents: m(x.replacedMonthlyCostCents, 'Replaced cost'),
      guardrailMinCashCents: x.guardrailMinCashCents === null || x.guardrailMinCashCents === undefined ? null : m(x.guardrailMinCashCents, 'Cash guardrail'),
    };
  }
  const getScenario = (c: Ctx, id: string) => { const s = db.get(`SELECT s.* FROM scenarios s WHERE s.id = ? AND s.tenant_id = ? ${visibleScenario(c)}`, ...(c.access.isStaff ? [id, c.tenantId] : [id, c.tenantId, c.session.user.id])); if (!s) throw notFound(); return s; };
  const scenarioOut = (c: Ctx, s: any) => ({ id: s.id, type: s.type, name: s.name, status: s.status, inputs: JSON.parse(s.inputs_json), result: s.result_json ? JSON.parse(s.result_json) : null, baselinePeriod: s.baseline_period, engineVersion: s.engine_version, updatedAt: s.updated_at, mine: s.created_by === c.session.user.id, comments: commentsFor(c, 'scenario', s.id) });
  app.on('POST', `${T}/scenarios`, (c) => {
    scenarioGate(c); const type = oneOf(c.body.type, 'Type', ['hiring', 'profit_plan', 'buy_in', 'valuation', 'profit_levels', 'forecast'] as const); const r = compute(c, type, c.body.inputs ?? {}); const id = uid();
    db.run('INSERT INTO scenarios (id, tenant_id, type, name, inputs_json, result_json, baseline_period, engine_version, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)', id, c.tenantId, type, str(c.body.name, 'Scenario name', 120), JSON.stringify(r.inputs), JSON.stringify(r.result), r.baselinePeriod, ENGINE_VERSION, c.session.user.id, now(), now());
    db.audit(c.tenantId, c.session.user.id, 'scenario.created', 'scenario', id, { type });
    return scenarioOut(c, getScenario(c, id));
  }, { perm: 'scenario_write' });
  app.on('GET', `${T}/scenarios/:id`, (c) => scenarioOut(c, getScenario(c, c.params.id)), { perm: 'view' });
  app.on('PUT', `${T}/scenarios/:id`, (c) => {
    scenarioGate(c); const s = getScenario(c, c.params.id);
    if (!c.access.isStaff && s.created_by !== c.session.user.id) throw new HttpError(403, 'You can only edit scenarios you created. Duplicate it to make your own copy.');
    if (s.status === 'approved') throw new HttpError(409, 'Approved scenarios are locked. Duplicate it to explore changes.');
    const r = compute(c, s.type, c.body.inputs ?? {});
    db.run("UPDATE scenarios SET name = ?, inputs_json = ?, result_json = ?, baseline_period = ?, engine_version = ?, status = CASE WHEN status = 'approval_requested' THEN 'shared' ELSE status END, updated_at = ? WHERE id = ? AND tenant_id = ?", str(c.body.name ?? s.name, 'Scenario name', 120), JSON.stringify(r.inputs), JSON.stringify(r.result), r.baselinePeriod, ENGINE_VERSION, now(), s.id, c.tenantId);
    db.audit(c.tenantId, c.session.user.id, 'scenario.updated', 'scenario', s.id);
    return scenarioOut(c, getScenario(c, s.id));
  }, { perm: 'scenario_write' });
  app.on('POST', `${T}/scenarios/:id/duplicate`, (c) => {
    scenarioGate(c); const s = getScenario(c, c.params.id); const id = uid();
    db.run('INSERT INTO scenarios (id, tenant_id, type, name, inputs_json, result_json, baseline_period, engine_version, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)', id, c.tenantId, s.type, `${s.name} (copy)`.slice(0, 120), s.inputs_json, s.result_json, s.baseline_period, s.engine_version, c.session.user.id, now(), now());
    db.audit(c.tenantId, c.session.user.id, 'scenario.duplicated', 'scenario', id, { from: s.id });
    return scenarioOut(c, getScenario(c, id));
  }, { perm: 'scenario_write' });
  app.on('POST', `${T}/scenarios/:id/status`, (c) => {
    const s = getScenario(c, c.params.id); const status = oneOf(c.body.status, 'Status', ['draft', 'shared', 'approval_requested', 'approved', 'declined'] as const);
    if (['approved', 'declined'].includes(status) && !c.access.can('scenario_approve')) throw new HttpError(403, 'Only your advisor can approve or decline a scenario.');
    if (!c.access.isStaff && s.created_by !== c.session.user.id) throw new HttpError(403, 'You can only share scenarios you created.');
    db.run('UPDATE scenarios SET status = ?, updated_at = ? WHERE id = ? AND tenant_id = ?', status, now(), s.id, c.tenantId);
    db.audit(c.tenantId, c.session.user.id, 'scenario.status', 'scenario', s.id, { status });
    return { ok: true, status };
  }, { perm: 'scenario_write' });
  app.on('DELETE', `${T}/scenarios/:id`, (c) => { const s = getScenario(c, c.params.id); if (!c.access.isStaff && s.created_by !== c.session.user.id) throw new HttpError(403, 'You can only delete scenarios you created.'); db.run('DELETE FROM scenarios WHERE id = ? AND tenant_id = ?', s.id, c.tenantId); db.audit(c.tenantId, c.session.user.id, 'scenario.deleted', 'scenario', s.id); return { ok: true }; }, { perm: 'scenario_write' });

  // ---------- industry KPIs for a client ----------
  app.on('GET', `${T}/kpis`, (c) => ({ ...svc.kpiValues(db, c.tenantId, clientOnly(c)), packs: c.access.can('kpi_assign') ? db.all("SELECT i.id, i.name, COUNT(d.id) AS kpis FROM industries i JOIN kpi_definitions d ON d.industry_id = i.id AND d.status = 'active' WHERE i.status = 'active' GROUP BY i.id ORDER BY i.name") : [], available: c.access.can('kpi_assign') ? db.all("SELECT d.id, d.name, d.key, i.name AS industry FROM kpi_definitions d JOIN industries i ON i.id = d.industry_id WHERE d.status = 'active' AND d.id NOT IN (SELECT kpi_id FROM tenant_kpis WHERE tenant_id = ?) ORDER BY i.name, d.name", c.tenantId) : [] }), { perm: 'view' });
  /** Apply a whole industry pack to a client. A client may carry several packs (multiple service lines). */
  app.on('POST', `${T}/kpis/apply-pack`, (c) => {
    const ind = db.get("SELECT id, name FROM industries WHERE id = ? AND status = 'active'", str(c.body.industryId, 'Industry', 60)); if (!ind) throw notFound();
    const r = db.run("INSERT OR IGNORE INTO tenant_kpis (tenant_id, kpi_id, client_visible) SELECT ?, id, client_visible FROM kpi_definitions WHERE industry_id = ? AND status = 'active'", c.tenantId, ind.id);
    db.audit(c.tenantId, c.session.user.id, 'kpi.pack_applied', 'industry', ind.id, { name: ind.name, added: Number(r.changes) });
    return { added: Number(r.changes), industry: ind.name };
  }, { perm: 'kpi_assign' });
  app.on('PUT', `${T}/kpis/:id`, (c) => {
    if (!db.get("SELECT id FROM kpi_definitions WHERE id = ? AND status = 'active'", c.params.id)) throw notFound();
    if (c.body.remove === true) db.run('DELETE FROM tenant_kpis WHERE tenant_id = ? AND kpi_id = ?', c.tenantId, c.params.id);
    else db.run('INSERT INTO tenant_kpis (tenant_id, kpi_id, target, alert_threshold, client_visible) VALUES (?,?,?,?,?) ON CONFLICT (tenant_id, kpi_id) DO UPDATE SET target = excluded.target, alert_threshold = excluded.alert_threshold, client_visible = excluded.client_visible', c.tenantId, c.params.id, num(c.body.target, 'Target', true), num(c.body.alertThreshold, 'Alert threshold', true), c.body.clientVisible === false ? 0 : 1);
    db.audit(c.tenantId, c.session.user.id, 'kpi.assignment', 'kpi', c.params.id, { remove: !!c.body.remove });
    return { ok: true };
  }, { perm: 'kpi_assign' });
  app.on('PUT', `${T}/kpi-inputs`, (c) => {
    const list = Array.isArray(c.body.inputs) ? c.body.inputs.slice(0, 500) : [];
    db.tx(() => { for (const i of list) { const key = str(i.key, 'Input', 60); if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || isFinancialVariable(key)) throw new HttpError(400, `"${key}" is not a valid operational input name.`); db.run('INSERT INTO kpi_inputs (tenant_id, key, period, value, entered_by, updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT (tenant_id, key, period) DO UPDATE SET value = excluded.value, entered_by = excluded.entered_by, updated_at = excluded.updated_at', c.tenantId, key, period(i.period), num(i.value, 'Value'), c.session.user.id, now()); } db.audit(c.tenantId, c.session.user.id, 'kpi.inputs_saved', 'kpi_input', undefined, { count: list.length }); });
    return { ok: true };
  }, { perm: 'kpi_inputs' });

  // ---------- goals & actions ----------
  app.on('GET', `${T}/actions`, (c) => ({ actions: db.all(`SELECT * FROM actions WHERE tenant_id = ? ${clientOnly(c) ? "AND client_visible = 1 AND status <> 'suggested'" : ''} ORDER BY status = 'done', priority, due_date`, c.tenantId).map((a) => ({ ...a, evidence: JSON.parse(a.evidence_json), history: JSON.parse(a.history_json), evidence_json: undefined, history_json: undefined })) }), { perm: 'view' });
  /** Generate advisor-review suggestions from the engine. They stay internal ("suggested") until an advisor approves them. */
  app.on('POST', `${T}/actions/generate`, (c) => {
    const ins = svc.insightsFor(db, c.tenantId); let created = 0;
    db.tx(() => { for (const [i, x] of ins.entries()) {
      if (db.get("SELECT id FROM actions WHERE tenant_id = ? AND source_key = ? AND status NOT IN ('done','dismissed')", c.tenantId, x.key)) continue;
      db.run("INSERT INTO actions (id, tenant_id, title, kpi, observation, cause, impact, recommendation, impact_cents, impact_basis, evidence_json, priority, status, client_visible, source, source_key, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'suggested',0,'generated',?,?,?,?)", uid(), c.tenantId, x.title, x.kpi, x.observation, x.cause, x.impact, x.action, x.impactCents, x.impactBasis, JSON.stringify([...x.evidence, { label: 'Period', value: x.period }, { label: 'Data completeness', value: x.completeness }]), Math.min(3, i + 1), x.key, c.session.user.id, now(), now()); created++;
    } db.audit(c.tenantId, c.session.user.id, 'actions.generated', 'action', undefined, { created }); });
    return { created, considered: ins.length };
  }, { perm: 'actions_manage' });
  app.on('POST', `${T}/actions`, (c) => {
    const id = uid(); const b = c.body;
    db.run("INSERT INTO actions (id, tenant_id, title, kpi, observation, cause, impact, recommendation, impact_cents, impact_basis, owner, priority, due_date, status, client_visible, source, scenario_id, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'open',?,'advisor',?,?,?,?)", id, c.tenantId, str(b.title, 'Title', 200), str(b.kpi, 'KPI', 60, false) || null, str(b.observation, 'Observation', 2000, false), str(b.cause, 'Cause', 2000, false), str(b.impact, 'Impact', 2000, false), str(b.recommendation, 'Recommendation', 2000, false), int(b.impactCents, 'Impact', { nullable: true, min: -MONEY_MAX, max: MONEY_MAX }), str(b.impactBasis, 'Impact basis', 500, false) || null, str(b.owner, 'Owner', 120, false), int(b.priority ?? 2, 'Priority', { min: 1, max: 3 }), isoDate(b.dueDate, 'Due date', true), b.clientVisible ? 1 : 0, b.scenarioId && db.get('SELECT id FROM scenarios WHERE id = ? AND tenant_id = ?', String(b.scenarioId), c.tenantId) ? String(b.scenarioId) : null, c.session.user.id, now(), now());
    if (b.impactCents != null && !b.impactBasis) { db.run('DELETE FROM actions WHERE id = ?', id); throw new HttpError(400, 'An estimated financial impact needs a stated basis (how it was calculated).'); }
    db.audit(c.tenantId, c.session.user.id, 'action.created', 'action', id);
    return { id };
  }, { perm: 'actions_manage' });
  app.on('PUT', `${T}/actions/:id`, (c) => {
    const a = db.get(`SELECT * FROM actions WHERE id = ? AND tenant_id = ? ${clientOnly(c) ? "AND client_visible = 1 AND status <> 'suggested'" : ''}`, c.params.id, c.tenantId); if (!a) throw notFound();
    const b = c.body; const manage = c.access.can('actions_manage'); if (!manage && !c.access.can('actions_update')) throw new HttpError(403, 'Your role cannot update actions.');
    // Clients may move status and set owner / due date; advisors may edit, approve, suppress or replace everything.
    const status = b.status === undefined ? a.status : oneOf(b.status, 'Status', manage ? ['suggested', 'open', 'in_progress', 'done', 'dismissed'] as const : ['open', 'in_progress', 'done'] as const);
    const next = {
      title: manage && b.title !== undefined ? str(b.title, 'Title', 200) : a.title, observation: manage && b.observation !== undefined ? str(b.observation, 'Observation', 2000, false) : a.observation, cause: manage && b.cause !== undefined ? str(b.cause, 'Cause', 2000, false) : a.cause,
      impact: manage && b.impact !== undefined ? str(b.impact, 'Impact', 2000, false) : a.impact, recommendation: manage && b.recommendation !== undefined ? str(b.recommendation, 'Recommendation', 2000, false) : a.recommendation,
      priority: manage && b.priority !== undefined ? int(b.priority, 'Priority', { min: 1, max: 3 }) : a.priority, visible: manage && b.clientVisible !== undefined ? (b.clientVisible ? 1 : 0) : a.client_visible,
      owner: b.owner !== undefined ? str(b.owner, 'Owner', 120, false) : a.owner, due: b.dueDate !== undefined ? isoDate(b.dueDate, 'Due date', true) : a.due_date,
    };
    const history = JSON.parse(a.history_json); if (status !== a.status) history.push({ at: now(), by: c.session.user.name, from: a.status, to: status });
    db.run('UPDATE actions SET title=?, observation=?, cause=?, impact=?, recommendation=?, priority=?, client_visible=?, owner=?, due_date=?, status=?, history_json=?, updated_at=? WHERE id=? AND tenant_id=?', next.title, next.observation, next.cause, next.impact, next.recommendation, next.priority, next.visible, next.owner, next.due, status, JSON.stringify(history), now(), a.id, c.tenantId);
    db.audit(c.tenantId, c.session.user.id, 'action.updated', 'action', a.id, { status });
    return { ok: true };
  }, { perm: 'view' });

  // ---------- client access management & audit ----------
  app.on('GET', `${T}/users`, (c) => ({ users: db.all('SELECT u.id, u.email, u.name, u.active, m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = ? ORDER BY m.role, u.name', c.tenantId) }), { perm: 'users' });
  app.on('POST', `${T}/users`, (c) => {
    const email = str(c.body.email, 'Email', 200).toLowerCase(); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'Enter a valid email address.');
    const role = oneOf(c.body.role, 'Role', ['client_owner', 'client_manager', 'client_viewer', 'advisor', 'analyst'] as const);
    let u = db.get('SELECT id, staff_role FROM users WHERE email = ?', email);
    if (['advisor', 'analyst'].includes(role) && !u?.staff_role) throw new HttpError(400, 'Advisor and analyst roles can only be given to SJATS staff accounts.');
    if (!['advisor', 'analyst'].includes(role) && u?.staff_role) throw new HttpError(400, 'SJATS staff cannot be given a client role.');
    db.tx(() => {
      // Portal-authenticated users need no password here; a temporary password is only for standalone sign-in.
      if (!u) { u = { id: uid(), staff_role: null }; db.run('INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?,?,?,?,?)', u.id, email, str(c.body.name, 'Name', 120), c.body.temporaryPassword ? hashPassword(str(c.body.temporaryPassword, 'Temporary password', 200)) : null, now()); }
      db.run('INSERT INTO memberships (user_id, tenant_id, role) VALUES (?,?,?) ON CONFLICT (user_id, tenant_id) DO UPDATE SET role = excluded.role', u.id, c.tenantId, role);
      db.audit(c.tenantId, c.session.user.id, 'access.granted', 'user', u.id, { role });
    });
    return { id: u!.id };
  }, { perm: 'users' });
  app.on('DELETE', `${T}/users/:id`, (c) => { const r = db.run('DELETE FROM memberships WHERE tenant_id = ? AND user_id = ?', c.tenantId, c.params.id); if (!r.changes) throw notFound(); auth.revokeAllForUser(c.params.id); db.audit(c.tenantId, c.session.user.id, 'access.revoked', 'user', c.params.id); return { ok: true }; }, { perm: 'users' });
  app.on('GET', `${T}/audit`, (c) => ({ entries: db.all('SELECT a.id, a.action, a.entity, a.entity_id, a.detail_json, a.at, u.name AS user FROM audit_log a LEFT JOIN users u ON u.id = a.user_id WHERE a.tenant_id = ? ORDER BY a.id DESC LIMIT 200', c.tenantId) }), { perm: 'view_internal' });
  void fmtMoney;
}
