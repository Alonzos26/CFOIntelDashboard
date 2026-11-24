// Seeds the KPI library and three clearly labelled SYNTHETIC demo clients. Refuses to run in production.
import { Db, now, uid } from './db.ts';
import { hashPassword } from './auth.ts';
import { addMonths, ENGINE_VERSION, type Settings } from '../engine/core.ts';
import { addDays, weekStart } from '../engine/cash.ts';
import { buildScorecard } from '../engine/scorecard.ts';
import * as imp from './importer.ts';
import * as svc from './services.ts';
import { PROFILES, generate, type Generated } from './synthetic.ts';
import { syncKpiLibrary } from './library.ts';


export const DEMO_PASSWORD = process.env.SEED_PASSWORD ?? 'demo-CFO-2026!';

export function seed(db: Db, today = new Date().toISOString().slice(0, 10)) {
  if (process.env.NODE_ENV === 'production') throw new Error('Demo seeding is disabled in production.');
  if (db.get('SELECT id FROM tenants LIMIT 1')) return false;
  const end = addMonths(today.slice(0, 7), -1); // last complete month
  const pw = hashPassword(DEMO_PASSWORD);
  const user = (email: string, name: string, staff: string | null = null) => { const id = uid(); db.run('INSERT INTO users (id, email, name, password_hash, staff_role, created_at) VALUES (?,?,?,?,?,?)', id, email, name, pw, staff, now()); return id; };
  const admin = user('admin@sjats.demo', 'Sam Admin (demo)', 'super_admin'), advisor = user('advisor@sjats.demo', 'Avery Advisor (demo)', 'advisor'), analyst = user('analyst@sjats.demo', 'Ana Analyst (demo)', 'analyst');
  const advisor2 = user('advisor2@sjats.demo', 'Blake Advisor (demo)', 'advisor');
  void admin;
  syncKpiLibrary(db);
  const industries: Record<string, string> = Object.fromEntries(db.all('SELECT id, name FROM industries').map((i) => [i.name as string, i.id as string]));
  const tenant = (name: string, portalId: string, industry: string, settings: Partial<Settings>) => {
    const id = uid(); db.run('INSERT INTO tenants (id, name, portal_client_id, industry_id, settings_json, is_synthetic, created_at) VALUES (?,?,?,?,?,1,?)', id, name, portalId, industries[industry], JSON.stringify(settings), now());
    db.run("INSERT INTO tenant_kpis (tenant_id, kpi_id, client_visible) SELECT ?, id, 1 FROM kpi_definitions WHERE industry_id = ?", id, industries[industry]); return id;
  };
  const member = (u: string, t: string, role: string) => db.run('INSERT INTO memberships (user_id, tenant_id, role) VALUES (?,?,?)', u, t, role);
  const load = (t: string, g: Generated, approveThrough: string) => {
    for (const [statement, text, map] of [['pnl', g.pnlCsv, g.pnlMap], ['bs', g.bsCsv, g.bsMap]] as const) {
      const { batchId } = imp.stage(db, t, advisor, { filename: `synthetic-${statement}.csv`, data: Buffer.from(text), statement });
      for (const [name, [line, sign]] of Object.entries(map)) db.run('UPDATE accounts SET line = ?, sign = ? WHERE tenant_id = ? AND statement = ? AND name = ?', line, sign, t, statement, name);
      db.run("UPDATE import_batches SET accounting_basis = 'accrual' WHERE id = ?", batchId);
      const r = imp.commit(db, t, advisor, batchId, true); if (!r.ok) throw new Error(`Seed import failed: ${r.error} ${JSON.stringify(r.issues)}`);
    }
    db.run("UPDATE period_status SET status = 'approved', updated_by = ?, updated_at = ? WHERE tenant_id = ? AND period <= ?", advisor, now(), t, approveThrough);
  };
  const publish = (t: string, s: Settings, commentary: Record<string, { comment: string; grade?: string }>) => {
    const months = svc.loadMonths(db, t, true); const sc = buildScorecard(months, months.length - 1, s)!;
    db.run("INSERT INTO scorecards (id, tenant_id, period, status, snapshot_json, commentary_json, engine_version, published_by, published_at, updated_at) VALUES (?,?,?,'published',?,?,?,?,?,?)", uid(), t, sc.period, JSON.stringify(sc), JSON.stringify(commentary), ENGINE_VERSION, advisor, now(), now());
  };

  // ---- Cedar Ridge Builders (construction): latest month left "preliminary" so the approval workflow can be demonstrated
  const cedarSettings: Partial<Settings> = { pretaxTargetPct: 0.10, dlerTarget: 2.0, mlerTarget: 3.5, opexPctTarget: 0.24, dsoTargetDays: 40, salesTargetR12Cents: 290_000_000, weeklyGpTargetCents: 3_600_000, cashFloorCents: 6_000_000, coreCapitalMonths: 2, coreCapitalBasis: 'r12_avg', weekStartDay: 1 };
  const cedar = tenant('Cedar Ridge Builders — SYNTHETIC DEMO', 'portal-client-1001', 'Construction', cedarSettings);
  load(cedar, generate(PROFILES.cedar(end)), addMonths(end, -1));
  member(advisor, cedar, 'advisor'); member(analyst, cedar, 'analyst');
  member(user('owner@cedarridge.demo', 'Casey Owner (demo)'), cedar, 'client_owner'); member(user('manager@cedarridge.demo', 'Morgan Manager (demo)'), cedar, 'client_manager'); member(user('viewer@cedarridge.demo', 'Val Viewer (demo)'), cedar, 'client_viewer');
  const cedarMonths = svc.loadMonths(db, cedar, false);
  for (const m of cedarMonths) db.run("INSERT INTO adjustments (id, tenant_id, period, kind, amount_cents, note, created_by, created_at) VALUES (?,?,?,'owner_comp',?,?,?,?)", uid(), cedar, m.period, 450_000, 'Owner works full time as general manager; officer salary is below the market-rate estimate for the role. Synthetic example.', advisor, now());
  publish(cedar, svc.loadSettings(db, cedar), { profitability: { comment: 'True profit is positive but well short of 10% once your pay is set at a market rate. This is the number to move this year.' }, labor: { comment: 'Field labor has grown faster than the gross profit it produces. We will track this weekly.' }, core_capital: { comment: 'Hold distributions beyond taxes until you reach two months of reserves.' }, sales: { comment: 'Sales are growing steadily.' } });
  // weekly entries: last 20 complete weeks; reports published for all but the most recent week
  const thisWeek = weekStart(today, 1); let seedN = 7; const rnd = () => { seedN = (seedN * 9301 + 49297) % 233280; return seedN / 233280; };
  for (let w = 20; w >= 1; w--) {
    const ws = addDays(thisWeek, -7 * w); const rev = 6_300_000 + Math.round(rnd() * 1_600_000); const cogs = Math.round(rev * (0.36 + rnd() * 0.04)); const dl = Math.round((rev - cogs) / (1.6 + rnd() * 0.5));
    db.run("INSERT INTO weekly_entries (tenant_id, week_start, revenue_cents, cogs_cents, direct_labor_cents, other_labor_cents, cash_balance_cents, source, entered_by, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)", cedar, ws, rev, cogs, dl, 1_150_000 + (w % 3) * 20_000, w === 1 ? 11_840_000 : 10_500_000 + Math.round(rnd() * 3_000_000), 'Synthetic weekly entry (sales system, payroll, bank balance)', analyst, now());
  }
  const D = (n: number) => addDays(thisWeek, n);
  const items: [string, 'in' | 'out', string, number, string, string][] = [
    ['Customer collections (progress billings)', 'in', 'collections', 6_600_000, 'weekly', D(3)], ['Retainage release — Maple St. project', 'in', 'known_receivable', 8_500_000, 'once', D(38)], ['Deposit — new kitchen remodel', 'in', 'deposit', 1_800_000, 'once', D(10)],
    ['Payroll', 'out', 'payroll', 6_100_000, 'biweekly', D(4)], ['Payroll taxes', 'out', 'payroll_taxes', 1_250_000, 'biweekly', D(4)], ['Materials & subcontractors', 'out', 'vendor', 2_500_000, 'weekly', D(2)],
    ['Shop & office rent', 'out', 'rent', 780_000, 'monthly', `${addMonths(today.slice(0, 7), 1)}-01`], ['Credit card payment', 'out', 'credit_card', 1_300_000, 'monthly', `${addMonths(today.slice(0, 7), 1)}-15`],
    ['Equipment note payment', 'out', 'loan_payment', 340_000, 'monthly', `${addMonths(today.slice(0, 7), 0)}-20`], ['Estimated income taxes', 'out', 'estimated_taxes', 1_800_000, 'quarterly', `${today.slice(0, 4)}-01-15`],
    ['Owner distribution', 'out', 'owner_distribution', 250_000, 'monthly', `${addMonths(today.slice(0, 7), 0)}-28`], ['Skid steer purchase (planned)', 'out', 'capital_purchase', 6_500_000, 'once', D(30)],
  ];
  for (const [name, dir, cat, amt, cad, anchor] of items) db.run('INSERT INTO cash_items (id, tenant_id, name, direction, category, amount_cents, cadence, anchor_date) VALUES (?,?,?,?,?,?,?,?)', uid(), cedar, name, dir, cat, amt, cad, anchor);
  for (let w = 8; w >= 2; w--) { const ws = addDays(thisWeek, -7 * w); const b = svc.buildWeeklySnapshot(db, cedar, ws)!; db.run("INSERT INTO weekly_reports (id, tenant_id, week_start, status, snapshot_json, briefing_json, next_steps_json, published_by, published_at, updated_at) VALUES (?,?,?,'published',?,?,?,?,?,?)", uid(), cedar, ws, JSON.stringify(b.snapshot), JSON.stringify(b.briefing), JSON.stringify([{ text: 'Review crew schedule against billed hours for the week.', owner: 'Casey Owner', due: addDays(ws, 10) }]), advisor, now(), now()); }
  for (let k = 0; k < 12; k++) { const p = addMonths(end, -k); for (const [key, v] of [['jobs_completed', 9 + (k % 4)], ['field_hours', 3900 + k * 35], ['change_order_revenue', 14_000 + k * 600], ['backlog', 610_000 - k * 9000], ['actual_job_cost', 141_000 + k * 500], ['estimated_job_cost', 134_000 + k * 400]] as const) db.run('INSERT INTO kpi_inputs (tenant_id, key, period, value, entered_by, updated_at) VALUES (?,?,?,?,?,?)', cedar, key, p, v, analyst, now()); }
  const ins = svc.insightsFor(db, cedar).slice(0, 3);
  ins.forEach((x, i) => db.run("INSERT INTO actions (id, tenant_id, title, kpi, observation, cause, impact, recommendation, impact_cents, impact_basis, evidence_json, owner, priority, due_date, status, client_visible, source, source_key, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'open',1,'generated',?,?,?,?)", uid(), cedar, x.title, x.kpi, x.observation, x.cause, x.impact, x.action, x.impactCents, x.impactBasis, JSON.stringify([...x.evidence, { label: 'Period', value: x.period }, { label: 'Data completeness', value: x.completeness }]), 'Casey Owner', i + 1, addDays(today, 14 + i * 7), x.key, advisor, now(), now()));

  // ---- Harbor Family Dental: a second, fully separate client (used to demonstrate tenant isolation)
  const harborSettings: Partial<Settings> = { pretaxTargetPct: 0.12, dlerTarget: 2.4, opexPctTarget: 0.34, dsoTargetDays: 30, cashFloorCents: 3_000_000 };
  const harbor = tenant('Harbor Family Dental — SYNTHETIC DEMO', 'portal-client-1002', 'Medical & Med Spas', harborSettings);
  load(harbor, generate(PROFILES.harbor(end)), end);
  member(advisor2, harbor, 'advisor'); member(user('owner@harbordental.demo', 'Harper Owner (demo)'), harbor, 'client_owner');
  publish(harbor, svc.loadSettings(db, harbor), { profitability: { comment: 'Profit is healthy and on target.' } });

  // ---- Lakeside Auto Repair: a new client with no data yet — import examples/imports/lakeside-*.csv to walk the onboarding workflow
  const lakeside = tenant('Lakeside Auto Repair — SYNTHETIC DEMO', 'portal-client-1003', 'Automotive Services', { pretaxTargetPct: 0.10, dlerTarget: 2.2 });
  member(advisor, lakeside, 'advisor'); member(analyst, lakeside, 'analyst'); member(user('owner@lakesideauto.demo', 'Lee Owner (demo)'), lakeside, 'client_owner');
  db.audit(null, null, 'seed.completed', undefined, undefined, { synthetic: true });
  return true;
}
