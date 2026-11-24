// Annual budgets: created during budget season from the forecast, edited until the deadline, then finalized and locked for good.
// Budget to actual and the outlook are computed on read from stored data; clients see approved months only.
import { type Db, now } from './db.ts';
import { HttpError } from './app.ts';
import { type Access } from './auth.ts';
import * as svc from './services.ts';
import { type BudgetData, type LineMonth, BUDGET_LINES, budgetSeason, budgetVsActual, defaultDeadline, fyLabel, fyPeriods, outlook, seedBudget } from '../engine/budget.ts';
import { type Levers, whatIf } from '../engine/whatif.ts';
import { type MonthData, type Settings, addMonths } from '../engine/core.ts';

const gap = (a: string, b: string) => Number(b.slice(0, 4)) * 12 + Number(b.slice(5, 7)) - (Number(a.slice(0, 4)) * 12 + Number(a.slice(5, 7)));
const lines = (months: MonthData[], s: Settings, levers: Partial<Levers>, horizon: number): LineMonth[] => { const r = whatIf(months, s, levers, horizon); return r.available ? r.months.map((m) => ({ period: m.period, pnl: m.lines, ownerAdj: m.ownerAdj })) : []; };
const row = (db: Db, tenantId: string, fy: string) => db.get(`SELECT b.*, cu.name AS created_name, uu.name AS updated_name, fu.name AS finalized_name FROM budgets b LEFT JOIN users cu ON cu.id = b.created_by LEFT JOIN users uu ON uu.id = b.updated_by LEFT JOIN users fu ON fu.id = b.finalized_by WHERE b.tenant_id = ? AND b.fiscal_year = ?`, tenantId, fy);

export function outlookLevers(db: Db, tenantId: string) {
  const r = db.get('SELECT o.levers_json, o.note, o.updated_at, u.name FROM forecast_outlook o LEFT JOIN users u ON u.id = o.updated_by WHERE o.tenant_id = ?', tenantId);
  return r ? { levers: JSON.parse(r.levers_json) as Partial<Levers>, note: r.note as string, updatedAt: r.updated_at as string, updatedBy: r.name as string | null, custom: true } : { levers: {} as Partial<Levers>, note: '', updatedAt: null, updatedBy: null, custom: false };
}
const checkFy = (s: Settings, fy: string) => { if (Number(fy.slice(5, 7)) !== s.fiscalYearStartMonth) throw new HttpError(400, `This client's fiscal year starts in month ${s.fiscalYearStartMonth}. A budget year must start then.`); };

export function list(db: Db, tenantId: string, today: string) {
  const s = svc.loadSettings(db, tenantId); const season = budgetSeason(today, s.fiscalYearStartMonth);
  const have = db.all('SELECT fiscal_year, status, deadline FROM budgets WHERE tenant_id = ? ORDER BY fiscal_year DESC', tenantId).map((r) => ({ fiscalYear: r.fiscal_year as string, label: fyLabel(r.fiscal_year), status: r.status as string, deadline: r.deadline as string }));
  const years = [...new Set([season.nextFy, season.currentFy, ...have.map((h) => h.fiscalYear)])].sort().reverse().map((fy) => have.find((h) => h.fiscalYear === fy) ?? { fiscalYear: fy, label: fyLabel(fy), status: 'none', deadline: defaultDeadline(fy) });
  // Open on the budget in preparation during season, otherwise on the year being tracked.
  const open = season.inSeason && have.some((h) => h.fiscalYear === season.nextFy) ? season.nextFy : have.some((h) => h.fiscalYear === season.currentFy) ? season.currentFy : season.suggestedFy;
  return { season, years, open, today };
}

export function detail(db: Db, tenantId: string, fy: string, access: Access, today: string, through?: string) {
  const s = svc.loadSettings(db, tenantId); checkFy(s, fy); const r = row(db, tenantId, fy); const season = budgetSeason(today, s.fiscalYearStartMonth); const months = svc.loadMonths(db, tenantId, !access.can('view_unapproved'));
  const head = { fiscalYear: fy, label: fyLabel(fy), periods: fyPeriods(fy), season, settings: s, canCreate: access.can('budget_edit'), hasHistory: months.length >= 3 };
  if (!r) return { ...head, exists: false as const, defaultDeadline: defaultDeadline(fy) };
  const data = JSON.parse(r.data_json) as BudgetData; const final = r.status === 'final'; const pastDeadline = today > r.deadline;
  const ol = outlookLevers(db, tenantId); const last = months.at(-1)?.period ?? null; const fyEnd = addMonths(fy, 11);
  const forecast = last ? lines(months, s, ol.levers, Math.min(24, Math.max(12, gap(last, fyEnd)))) : [];
  return { ...head, exists: true as const, status: r.status as 'draft' | 'final', deadline: r.deadline as string, pastDeadline, data, seededFrom: r.seeded_from_json ? JSON.parse(r.seeded_from_json) : null,
    // Clients may enter figures until the deadline; staff until the budget is finalized; nobody afterwards.
    editable: !final && access.can('budget_edit') && (access.isStaff || !pastDeadline), canFinalize: !final && access.can('approve'), canSetDeadline: !final && access.can('approve'), canEditOutlook: access.isStaff && access.can('adjust'),
    createdBy: r.created_name, createdAt: r.created_at, updatedBy: r.updated_name, updatedAt: r.updated_at, finalizedBy: r.finalized_name, finalizedAt: r.finalized_at,
    bva: final ? budgetVsActual(data, months, s, through) : null, outlook: forecast.length || months.some((m) => m.period >= fy && m.period <= fyEnd) ? outlook(data, months, forecast, s) : null, outlookLevers: ol, lastActual: last };
}

/** Create (or, for staff, rebuild) a draft from the forecast. Months of the budget year that are already closed start from their actuals. */
export function create(db: Db, tenantId: string, userId: string, fy: string, o: { levers?: Partial<Levers>; sourceLabel: string; approvedOnly: boolean; replace?: boolean; asOf?: string; deadline?: string }) {
  const s = svc.loadSettings(db, tenantId); checkFy(s, fy); const existing = row(db, tenantId, fy);
  if (existing?.status === 'final') throw new HttpError(409, 'This budget is finalized and cannot be changed.'); if (existing && !o.replace) throw new HttpError(409, 'A budget for this year already exists.');
  let months = svc.loadMonths(db, tenantId, o.approvedOnly); if (o.asOf) months = months.filter((m) => m.period <= o.asOf!); const fyEnd = addMonths(fy, 11); const last = months.at(-1)?.period ?? null;
  if (last && last >= fyEnd) throw new HttpError(409, 'That fiscal year is already complete, so there is nothing left to budget.'); if (last && gap(last, fyEnd) > 24) throw new HttpError(409, 'That fiscal year is too far ahead to forecast from the months imported so far.');
  const source: LineMonth[] = [...months.filter((m) => m.period >= fy).map((m) => ({ period: m.period, pnl: m.pnl, ownerAdj: m.ownerAdj })), ...(last ? lines(months, s, o.levers ?? {}, gap(last, fyEnd)) : [])];
  const { data, missing } = seedBudget(fy, source); const t = now();
  const seeded = { source: source.length ? o.sourceLabel : 'Blank: not enough history to forecast', basedOnMonthsThrough: last, actualMonthsUsed: months.filter((m) => m.period >= fy).length, monthsWithoutFigures: missing, levers: o.levers ?? {}, at: t };
  if (existing) db.run('UPDATE budgets SET data_json = ?, seeded_from_json = ?, updated_by = ?, updated_at = ? WHERE tenant_id = ? AND fiscal_year = ?', JSON.stringify(data), JSON.stringify(seeded), userId, t, tenantId, fy);
  else db.run('INSERT INTO budgets (tenant_id, fiscal_year, status, deadline, data_json, seeded_from_json, created_by, created_at, updated_by, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)', tenantId, fy, 'draft', o.deadline ?? defaultDeadline(fy), JSON.stringify(data), JSON.stringify(seeded), userId, t, userId, t);
  db.audit(tenantId, userId, existing ? 'budget.rebuilt' : 'budget.created', 'budget', fy, { source: seeded.source });
}

export function save(db: Db, tenantId: string, userId: string, fy: string, data: BudgetData, access: Access, today: string) {
  const r = row(db, tenantId, fy); if (!r) throw new HttpError(404, 'Not found.'); if (r.status === 'final') throw new HttpError(409, 'This budget is finalized and cannot be changed.');
  if (!access.isStaff && today > r.deadline) throw new HttpError(409, `The deadline for budget figures was ${r.deadline}. Ask your advisor if you need it extended.`);
  for (const k of BUDGET_LINES) if (!Array.isArray(data.base[k]) || data.base[k].length !== 12) throw new HttpError(400, 'Each budget line needs twelve months.');
  db.run('UPDATE budgets SET data_json = ?, updated_by = ?, updated_at = ? WHERE tenant_id = ? AND fiscal_year = ?', JSON.stringify({ ...data, fiscalYear: fy }), userId, now(), tenantId, fy); db.audit(tenantId, userId, 'budget.saved', 'budget', fy, { items: data.items.length });
}
export function setDeadline(db: Db, tenantId: string, userId: string, fy: string, deadline: string) {
  const r = row(db, tenantId, fy); if (!r) throw new HttpError(404, 'Not found.'); if (r.status === 'final') throw new HttpError(409, 'This budget is finalized and cannot be changed.');
  db.run('UPDATE budgets SET deadline = ? WHERE tenant_id = ? AND fiscal_year = ?', deadline, tenantId, fy); db.audit(tenantId, userId, 'budget.deadline_set', 'budget', fy, { from: r.deadline, to: deadline });
}
/** Lock the budget. There is no way back: the database also refuses any later change to a finalized budget. */
export function finalize(db: Db, tenantId: string, userId: string, fy: string, at = now()) {
  const r = row(db, tenantId, fy); if (!r) throw new HttpError(404, 'Not found.'); if (r.status === 'final') throw new HttpError(409, 'This budget is already finalized.');
  const d = JSON.parse(r.data_json) as BudgetData; if (!d.base.revenue.some((v) => v !== 0)) throw new HttpError(409, 'Enter revenue before finalizing: a budget with no sales cannot be tracked.');
  db.run("UPDATE budgets SET status = 'final', finalized_by = ?, finalized_at = ? WHERE tenant_id = ? AND fiscal_year = ?", userId, at, tenantId, fy); db.audit(tenantId, userId, 'budget.finalized', 'budget', fy);
}
export function remove(db: Db, tenantId: string, userId: string, fy: string) {
  const r = row(db, tenantId, fy); if (!r) throw new HttpError(404, 'Not found.'); if (r.status === 'final') throw new HttpError(409, 'A finalized budget cannot be deleted.');
  db.run('DELETE FROM budgets WHERE tenant_id = ? AND fiscal_year = ?', tenantId, fy); db.audit(tenantId, userId, 'budget.draft_deleted', 'budget', fy);
}
export function saveOutlook(db: Db, tenantId: string, userId: string, levers: Partial<Levers>, note: string) {
  db.run('INSERT INTO forecast_outlook (tenant_id, levers_json, note, updated_by, updated_at) VALUES (?,?,?,?,?) ON CONFLICT (tenant_id) DO UPDATE SET levers_json = excluded.levers_json, note = excluded.note, updated_by = excluded.updated_by, updated_at = excluded.updated_at', tenantId, JSON.stringify(levers), note, userId, now());
  db.audit(tenantId, userId, 'outlook.saved', 'tenant', tenantId, levers);
}
/** One sentence on budget to actual for the month a packet or script covers, when a finalized budget exists for that year. */
export function headlineFor(db: Db, tenantId: string, period: string): string | null {
  const s = svc.loadSettings(db, tenantId); const m = Number(period.slice(5, 7)), y = Number(period.slice(0, 4)); const fy = `${m >= s.fiscalYearStartMonth ? y : y - 1}-${String(s.fiscalYearStartMonth).padStart(2, '0')}`;
  const r = row(db, tenantId, fy); if (!r || r.status !== 'final') return null; return budgetVsActual(JSON.parse(r.data_json), svc.loadMonths(db, tenantId, true), s, period)?.headline ?? null;
}

/** Budget to actual and outlook for the fiscal year a period falls in, on approved months, when a finalized budget exists. For packets and slides. */
export function summaryFor(db: Db, tenantId: string, period: string) {
  const s = svc.loadSettings(db, tenantId); const m = Number(period.slice(5, 7)), y = Number(period.slice(0, 4)); const fy = `${m >= s.fiscalYearStartMonth ? y : y - 1}-${String(s.fiscalYearStartMonth).padStart(2, '0')}`;
  const r = row(db, tenantId, fy); if (!r || r.status !== 'final') return null; const data = JSON.parse(r.data_json) as BudgetData; const months = svc.loadMonths(db, tenantId, true).filter((x) => x.period <= period); if (!months.length) return null;
  const forecast = lines(months, s, outlookLevers(db, tenantId).levers, Math.min(24, Math.max(12, gap(period, addMonths(fy, 11)))));
  return { label: fyLabel(fy), bva: budgetVsActual(data, months, s, period), outlook: forecast.length ? outlook(data, months, forecast, s) : null };
}
