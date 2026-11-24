// End-to-end tests over real HTTP against an in-memory database: the six acceptance workflows,
// tenant isolation, portal sign-on, import integrity and scenario persistence.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { type Server } from 'node:http';
import { Db } from '../src/server/db.ts';
import { App } from '../src/server/app.ts';
import { loadConfig } from '../src/server/config.ts';
import { DEMO_PASSWORD, seed } from '../src/server/seed.ts';
import { mintLaunchToken } from '../src/server/auth.ts';
import { defaultHiringInputs } from '../src/engine/hiring.ts';
import { addMonths } from '../src/engine/core.ts';
import { readXlsx } from '../src/server/xlsx.ts';
import { loadPacks, syncKpiLibrary } from '../src/server/library.ts';
import { evaluateFormula, formulaVariables, isFinancialVariable } from '../src/engine/kpi.ts';

const SECRET = 'test-secret-test-secret-test-secret-1234';
let server: Server, base: string, db: Db;
const T: Record<string, string> = {};

class Client {
  cookie = ''; bearer = '';
  async call(method: string, path: string, body?: unknown, raw = false) {
    const headers: Record<string, string> = { 'x-requested-with': 'cfo' };
    if (this.bearer) headers.authorization = `Bearer ${this.bearer}`; else if (this.cookie) headers.cookie = this.cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.get('set-cookie'); if (set) this.cookie = set.split(';')[0];
    return { status: res.status, body: raw ? await res.text() : await res.json() as any, headers: res.headers };
  }
  async raw(path: string, o: { method?: string; body?: unknown } = {}) { const headers: Record<string, string> = { 'x-requested-with': 'cfo', cookie: this.cookie }; if (o.body !== undefined) headers['content-type'] = 'application/json'; return fetch(base + path, { method: o.method ?? 'GET', headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) }); }
  get = (p: string) => this.call('GET', p); post = (p: string, b: unknown = {}) => this.call('POST', p, b); put = (p: string, b: unknown = {}) => this.call('PUT', p, b);
}
async function login(email: string) { const c = new Client(); const r = await c.post('/api/auth/login', { email, password: DEMO_PASSWORD }); assert.equal(r.status, 200, JSON.stringify(r.body)); return c; }
const file = (name: string) => ({ filename: name, contentBase64: readFileSync(`examples/imports/${name}`).toString('base64') });

before(async () => {
  db = new Db(':memory:'); seed(db);
  const app = new App(db, loadConfig({ portalSsoSecret: SECRET, embedAllowedOrigins: ['https://portal.sjats.example'], cookieSecure: false, production: false }));
  server = await app.listen(0); base = `http://127.0.0.1:${(server.address() as any).port}`;
  for (const t of db.all('SELECT id, name FROM tenants')) T[t.name.split(' ')[0].toLowerCase()] = t.id;
});
after(() => { server.close(); db.close(); });

test('Workflow 1: advisor imports statements, maps accounts, approves and publishes a scorecard', async () => {
  const adv = await login('advisor@sjats.demo'); const t = `/api/t/${T.lakeside}`;
  const pre = await adv.post(`${t}/imports/preview`, file('lakeside-pnl-2025-2026.csv'));
  assert.equal(pre.body.sheets[0].detected.periods.length, 22);
  const staged = await adv.post(`${t}/imports`, { ...file('lakeside-pnl-2025-2026.csv'), statement: 'pnl' });
  assert.equal(staged.status, 200); const id = staged.body.batch.id;
  assert.equal(staged.body.canCommit, false); assert.ok(staged.body.issues.some((i: any) => i.code === 'unmapped_accounts'));
  assert.equal((await adv.post(`${t}/imports/${id}/commit`, { acknowledgeWarnings: true })).status, 409); // cannot commit unmapped data
  assert.ok(staged.body.accounts.every((a: any) => a.suggested), 'every account receives a mapping suggestion');
  await adv.put(`${t}/accounts`, { mappings: staged.body.accounts.map((a: any) => ({ id: a.id, line: a.suggested, sign: 1 })) });
  const rev = await adv.get(`${t}/imports/${id}`); assert.equal(rev.body.canCommit, true, JSON.stringify(rev.body.issues));
  assert.equal((await adv.post(`${t}/imports/${id}/commit`, { acknowledgeWarnings: true })).status, 200);
  const bs = await adv.post(`${t}/imports`, { ...file('lakeside-balance-sheet-2025-2026.csv'), statement: 'bs' });
  await adv.put(`${t}/accounts`, { mappings: bs.body.accounts.map((a: any) => ({ id: a.id, line: a.suggested, sign: 1 })) });
  const c2 = await adv.post(`${t}/imports/${bs.body.batch.id}/commit`, { acknowledgeWarnings: true }); assert.equal(c2.status, 200, JSON.stringify(c2.body));
  // The same file twice is refused.
  const again = await adv.post(`${t}/imports`, { ...file('lakeside-pnl-2025-2026.csv'), statement: 'pnl' });
  assert.ok(again.body.issues.some((i: any) => i.code === 'duplicate_file')); assert.equal(again.body.canCommit, false);
  // Mapping is reused: no unmapped accounts the second time.
  assert.ok(!again.body.issues.some((i: any) => i.code === 'unmapped_accounts'));

  const owner = await login('owner@lakesideauto.demo');
  assert.equal((await owner.get(`${t}/overview`)).body.empty, true, 'client sees nothing until the advisor approves');
  assert.equal((await adv.put(`${t}/scorecard`, { publish: true })).status, 409, 'cannot publish a scorecard for an unapproved period');
  const periods = (await adv.get(`${t}/periods`)).body.periods.map((p: any) => p.period);
  assert.equal((await adv.put(`${t}/periods/status`, { periods, status: 'approved' })).status, 200);
  const pub = await adv.put(`${t}/scorecard`, { publish: true, commentary: { profitability: { comment: 'Solid first year.' } }, internalNotes: 'INTERNAL: watch owner pay.' });
  assert.equal(pub.body.status, 'published');
  const seen = await owner.get(`${t}/scorecard`);
  assert.equal(seen.body.current.status, 'published'); assert.equal(seen.body.current.commentary.profitability.comment, 'Solid first year.');
  assert.ok(!JSON.stringify(seen.body).includes('INTERNAL'), 'internal notes never reach the client');
  assert.equal((await owner.get(`${t}/overview?view=r12`)).body.cards.length, 8);
});

test('Workflow 2 + tenant isolation: a client sees only their own approved information', async () => {
  const cedar = await login('owner@cedarridge.demo');
  const me = await cedar.get('/api/me'); assert.deepEqual(me.body.tenants.map((t: any) => t.id), [T.cedar]);
  const ov = await cedar.get(`/api/t/${T.cedar}/overview`);
  const lastApproved = db.get("SELECT MAX(period) AS p FROM period_status WHERE tenant_id = ? AND status = 'approved'", T.cedar)!.p;
  assert.equal(ov.body.header.period, lastApproved); assert.equal(ov.body.header.status, 'approved');
  const fin = await cedar.get(`/api/t/${T.cedar}/financials`); assert.ok(fin.body.months.every((m: any) => m.status === 'approved'), 'no preliminary month leaks to the client');
  // Every route for another tenant answers 404 — by URL, by id, by export, by write.
  for (const p of ['overview', 'financials', 'scorecard', 'weekly', 'cash', 'scenarios', 'kpis', 'actions', 'export/pnl.csv', 'settings', 'imports', 'audit', 'users']) assert.equal((await cedar.get(`/api/t/${T.harbor}/${p}`)).status, 404, p);
  assert.equal((await cedar.post(`/api/t/${T.harbor}/scenarios`, { type: 'hiring', name: 'x', inputs: defaultHiringInputs('2027-01') })).status, 404);
  assert.equal((await cedar.get('/api/t/does-not-exist/overview')).status, 404);
  // An object id from another tenant cannot be read through one's own tenant path.
  const harborScenario = (await (await login('owner@harbordental.demo')).post(`/api/t/${T.harbor}/scenarios`, { type: 'hiring', name: 'Harbor hire', inputs: defaultHiringInputs(addMonths(lastApproved, 3)) })).body.id;
  assert.ok(harborScenario); assert.equal((await cedar.get(`/api/t/${T.cedar}/scenarios/${harborScenario}`)).status, 404);
  assert.equal((await cedar.post(`/api/t/${T.cedar}/comments`, { entity: 'scenario', entityId: harborScenario, body: 'hi' })).status, 404);
  // Client roles cannot reach advisor functions, and an advisor not assigned to a client cannot see it.
  assert.equal((await cedar.get(`/api/t/${T.cedar}/imports`)).status, 403); assert.equal((await cedar.get('/api/portfolio')).status, 404);
  const adv2 = await login('advisor2@sjats.demo'); assert.equal((await adv2.get(`/api/t/${T.cedar}/overview`)).status, 404);
  assert.deepEqual((await adv2.get('/api/portfolio')).body.clients.map((c: any) => c.id), [T.harbor]);
  assert.equal((await new Client().get(`/api/t/${T.cedar}/overview`)).status, 401);
  const viewer = await login('viewer@cedarridge.demo'); assert.equal((await viewer.post(`/api/t/${T.cedar}/scenarios`, { type: 'hiring', name: 'x', inputs: {} })).status, 403);
});

test('Portal sign-on: single-use launch token, session pinned to one client, no second login', async () => {
  const c = new Client(); const tok = mintLaunchToken(SECRET, { sub: 'owner@cedarridge.demo', client: 'portal-client-1001' });
  const ex = await c.post('/api/auth/exchange', { token: tok }); assert.equal(ex.status, 200); assert.equal(ex.body.tenantId, T.cedar);
  assert.equal((await c.get(`/api/t/${T.cedar}/overview`)).status, 200);
  assert.equal((await new Client().post('/api/auth/exchange', { token: tok })).status, 401, 'replay refused');
  const b = new Client(); b.bearer = ex.body.sessionToken; assert.equal((await b.get('/api/me')).body.embedded, true); // works without cookies
  // A staff member launched for one client is pinned to that client even though they could otherwise see more.
  const s = new Client(); await s.post('/api/auth/exchange', { token: mintLaunchToken(SECRET, { sub: 'advisor@sjats.demo', client: 'portal-client-1001' }) });
  assert.equal((await s.get(`/api/t/${T.lakeside}/overview`)).status, 404); assert.equal((await s.get(`/api/t/${T.cedar}/overview`)).status, 200);
  for (const bad of [mintLaunchToken('wrong-secret-wrong-secret-wrong-secret', { sub: 'owner@cedarridge.demo', client: 'portal-client-1001' }), mintLaunchToken(SECRET, { sub: 'owner@cedarridge.demo', client: 'portal-client-1002' }), mintLaunchToken(SECRET, { sub: 'owner@cedarridge.demo', client: 'portal-client-1001', ttlSeconds: -5 }), mintLaunchToken(SECRET, { sub: 'owner@cedarridge.demo', client: 'portal-client-1001', ttlSeconds: 3600 }), mintLaunchToken(SECRET, { sub: 'owner@cedarridge.demo', client: 'portal-client-1001', iss: 'someone-else' }), 'a.b.c'])
    assert.equal((await new Client().post('/api/auth/exchange', { token: bad })).status, 401);
  await c.post('/api/auth/logout'); assert.equal((await c.get('/api/me')).status, 401, 'revoked session is dead');
  const page = await fetch(base + '/'); assert.match(page.headers.get('content-security-policy')!, /frame-ancestors 'self' https:\/\/portal\.sjats\.example/);
  const noHeader = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@cedarridge.demo', password: DEMO_PASSWORD }) });
  assert.equal(noHeader.status, 403, 'cross-site form posts are refused');
});

test('Workflow 3: client builds a hiring scenario, changes pay and revenue, results update and persist', async () => {
  const c = await login('owner@cedarridge.demo'); const t = `/api/t/${T.cedar}`;
  const base0 = (await c.get(`${t}/scenarios/baseline`)).body; const start = addMonths(base0.baseline.asOf, 2);
  const inputs = { ...defaultHiringInputs(start), title: 'Lead carpenter', annualSalaryCents: 7_200_000, expectedMonthlyRevenueCents: 2_400_000 };
  const s1 = await c.post(`${t}/scenarios`, { type: 'hiring', name: 'Lead carpenter', inputs }); assert.equal(s1.status, 200, JSON.stringify(s1.body));
  const r1 = s1.body.result; assert.ok(r1.cost.monthlyLoadedCents > 600_000); assert.match(r1.decisionSummary, /additional \$[\d,]+ in monthly gross profit/);
  const s2 = await c.put(`${t}/scenarios/${s1.body.id}`, { inputs: { ...inputs, annualSalaryCents: 9_000_000, expectedMonthlyRevenueCents: 1_200_000 } });
  const r2 = s2.body.result;
  assert.ok(r2.cost.monthlyLoadedCents > r1.cost.monthlyLoadedCents, 'higher pay raises cost'); assert.ok(r2.scenario.pretax < r1.scenario.pretax, 'profit falls');
  assert.ok(r2.scenario.minCash < r1.scenario.minCash, 'cash falls'); assert.ok(r2.scenario.dLER.value < r1.scenario.dLER.value, 'labor yield falls');
  const reopened = await c.get(`${t}/scenarios/${s1.body.id}`); assert.equal(reopened.body.inputs.annualSalaryCents, 9_000_000); assert.deepEqual(reopened.body.result.scenario, r2.scenario);
  const dup = await c.post(`${t}/scenarios/${s1.body.id}/duplicate`); assert.match(dup.body.name, /\(copy\)/);
  assert.equal((await c.post(`${t}/scenarios/${s1.body.id}/status`, { status: 'approved' })).status, 403, 'clients cannot approve their own scenario');
  assert.equal((await c.post(`${t}/scenarios/${s1.body.id}/status`, { status: 'approval_requested' })).status, 200);
  const adv = await login('advisor@sjats.demo'); assert.equal((await adv.post(`${t}/scenarios/${s1.body.id}/status`, { status: 'approved' })).status, 200);
  assert.equal((await c.put(`${t}/scenarios/${s1.body.id}`, { inputs })).status, 409, 'approved scenarios are locked');
  // Scenarios never touch actuals.
  const before = db.get('SELECT COUNT(*) AS n, SUM(amount_cents) AS s FROM facts WHERE tenant_id = ? AND active = 1', T.cedar);
  await c.post(`${t}/scenarios`, { type: 'profit_plan', name: 'Plan', inputs: { debtPrincipalCents: 3_000_000, ownerDistributionsCents: 7_200_000, estimatedTaxRate: 0.25 } });
  assert.deepEqual(db.get('SELECT COUNT(*) AS n, SUM(amount_cents) AS s FROM facts WHERE tenant_id = ? AND active = 1', T.cedar), before);
  const mgr = await login('manager@cedarridge.demo'); const list = (await mgr.get(`${t}/scenarios`)).body.scenarios;
  assert.ok(list.some((x: any) => x.id === s1.body.id) && !list.some((x: any) => x.id === dup.body.id), 'drafts are private to their author; shared ones are visible');
});

test('Workflow 4: advisor drafts, edits and publishes a weekly report with next steps; history is frozen', async () => {
  const adv = await login('advisor@sjats.demo'); const owner = await login('owner@cedarridge.demo'); const t = `/api/t/${T.cedar}`;
  const wk = (await adv.get(`${t}/weekly`)).body; const latest = wk.rows.at(-1).weekStart;
  assert.ok(!(await owner.get(`${t}/weekly`)).body.rows.some((r: any) => r.weekStart === latest), 'unpublished week is not visible to the client');
  const draft = await adv.post(`${t}/weekly/reports`, { weekStart: latest }); assert.equal(draft.status, 200, JSON.stringify(draft.body));
  assert.match(draft.body.briefing.performance, /Sales were \$[\d,]+/);
  assert.equal((await owner.get(`${t}/weekly/reports/${draft.body.id}`)).status, 404, 'drafts are invisible to clients');
  assert.equal((await adv.put(`${t}/weekly/reports/${draft.body.id}`, { publish: true, briefing: draft.body.briefing, nextSteps: [] })).status, 400, 'publishing requires specific next steps');
  const analyst = await login('analyst@sjats.demo'); assert.equal((await analyst.put(`${t}/weekly/reports/${draft.body.id}`, { publish: true, briefing: draft.body.briefing, nextSteps: [{ text: 'x' }] })).status, 403, 'analysts cannot publish');
  const pub = await adv.put(`${t}/weekly/reports/${draft.body.id}`, { publish: true, briefing: { ...draft.body.briefing, actions: 'Call Maple St. GC about retainage release.' }, internalNotes: 'INTERNAL margin worry', nextSteps: [{ text: 'Call Maple St. GC about retainage release.', owner: 'Casey', due: '2026-12-01' }] });
  assert.equal(pub.body.status, 'published');
  const seen = await owner.get(`${t}/weekly/reports/${draft.body.id}`); assert.equal(seen.body.nextSteps[0].owner, 'Casey'); assert.equal(seen.body.internalNotes, undefined);
  assert.equal((await adv.put(`${t}/weekly/reports/${draft.body.id}`, { briefing: {}, nextSteps: [] })).status, 409, 'published reports are immutable');
  assert.equal((await adv.put(`${t}/weekly/entries`, { weekStart: latest, revenueCents: 1, cogsCents: 0, directLaborCents: 0 })).status, 409, 'published weeks are not rewritten');
  assert.equal((await owner.post(`${t}/comments`, { entity: 'weekly_report', entityId: draft.body.id, body: 'Will do.', visibility: 'internal' })).status, 200);
  await adv.post(`${t}/comments`, { entity: 'weekly_report', entityId: draft.body.id, body: 'private note', visibility: 'internal' });
  const thread = (await owner.get(`${t}/weekly/reports/${draft.body.id}`)).body.comments; assert.deepEqual(thread.map((m: any) => m.body), ['Will do.']); // client cannot post or read internal notes
  assert.equal((await owner.post(`${t}/weekly/reports/${draft.body.id}/acknowledge`)).status, 200);
});

test('Workflow 5: advisor adds an industry KPI with a formula — no code change — and it calculates', async () => {
  const adv = await login('advisor@sjats.demo'); const t = `/api/t/${T.cedar}`;
  const lib = (await adv.get('/api/kpi-library')).body; const construction = lib.industries.find((i: any) => i.name === 'Construction').id;
  assert.equal((await adv.post('/api/kpi-library/definitions', { industryId: construction, key: 'bad', name: 'Bad', formula: 'process.exit(1)', unit: 'number' })).status, 400);
  const v = (await adv.post('/api/kpi-library/validate', { formula: 'warranty_cost / revenue' })).body; assert.deepEqual(v, { valid: true, financial: ['revenue'], inputs: ['warranty_cost'] });
  const made = await adv.post('/api/kpi-library/definitions', { industryId: construction, key: 'warranty_rate', name: 'Warranty cost % of revenue', formula: 'warranty_cost / revenue', unit: 'percent', direction: 'lower', description: 'Cost of callbacks.', recommendedAction: 'Review punch-list process.', dataSource: 'Job costing' });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  await adv.put(`${t}/kpis/${made.body.id}`, { target: 0.01, alertThreshold: 0.02, clientVisible: true });
  let k = (await adv.get(`${t}/kpis`)).body.kpis.find((x: any) => x.key === 'warranty_rate'); assert.equal(k.value, null); assert.match(k.reason, /missing input warranty_cost/);
  const p = (await adv.get(`${t}/kpis`)).body.period; await adv.put(`${t}/kpi-inputs`, { inputs: [{ key: 'warranty_cost', period: p, value: 4200 }] });
  k = (await adv.get(`${t}/kpis`)).body.kpis.find((x: any) => x.key === 'warranty_rate');
  const rev = (await adv.get(`${t}/financials`)).body.months.at(-1).pnl.lines.revenue / 100;
  assert.ok(Math.abs(k.value - 4200 / rev) < 1e-9); assert.equal(k.status, k.value <= 0.01 ? 'on_target' : k.value > 0.02 ? 'alert' : 'watch');
  const owner = await login('owner@cedarridge.demo'); assert.equal((await owner.post('/api/kpi-library/definitions', {})).status, 404, 'clients cannot reach the library');
  assert.ok((await owner.get(`${t}/kpis`)).body.kpis.some((x: any) => x.key === 'warranty_rate'));
});

test('Workflow 6: a flawed import produces specific warnings and is blocked, not reported', async () => {
  const adv = await login('advisor@sjats.demo'); const t = `/api/t/${T.lakeside}`;
  const before = (await adv.get(`${t}/financials`)).body.months.map((m: any) => m.pnl.pretax);
  const r = await adv.post(`${t}/imports`, { ...file('lakeside-pnl-WITH-ERRORS.csv'), statement: 'pnl' });
  const codes = r.body.issues.map((i: any) => i.code);
  for (const c of ['non_numeric', 'missing_months', 'control_total_mismatch', 'supersedes']) assert.ok(codes.includes(c), `${c} in ${codes}`);
  assert.match(r.body.issues.find((i: any) => i.code === 'non_numeric').detail[0], /Rent.*#REF!/);
  assert.equal(r.body.canCommit, false); const c = await adv.post(`${t}/imports/${r.body.batch.id}/commit`, { acknowledgeWarnings: true }); assert.equal(c.status, 409);
  assert.deepEqual((await adv.get(`${t}/financials`)).body.months.map((m: any) => m.pnl.pretax), before, 'rejected import changed nothing');
  const bs = await adv.post(`${t}/imports`, { ...file('lakeside-balance-sheet-OUT-OF-BALANCE.csv'), statement: 'bs' });
  assert.ok(bs.body.issues.some((i: any) => i.code === 'bs_out_of_balance')); assert.equal(bs.body.canCommit, false);
  assert.equal((await adv.post(`${t}/imports`, { filename: 'notes.csv', contentBase64: Buffer.from('hello,world\n1,2\n').toString('base64'), statement: 'pnl' })).status, 422);
  assert.equal((await adv.post(`${t}/imports`, { filename: 'x.xlsx', contentBase64: Buffer.from('not a zip').toString('base64'), statement: 'pnl' })).status, 422);
});

test('import supersede and rollback restore earlier figures; approvals reset', async () => {
  const adv = await login('advisor@sjats.demo'); const t = `/api/t/${T.lakeside}`;
  const orig = (await adv.get(`${t}/financials`)).body.months; const csv = readFileSync('examples/imports/lakeside-pnl-2025-2026.csv', 'utf8').split('\n');
  const cols = csv[0].split(','); const lastTwo = [0, cols.length - 2, cols.length - 1];
  const revised = csv.filter(Boolean).map((l) => { const c = l.split(','); const row = lastTwo.map((i) => c[i]); if (c[0] === '4000 Labor Sales') row[2] = (Number(row[2]) + 1000).toFixed(2); if (c[0] === 'Total Income' || c[0] === 'Gross Profit' || c[0] === 'Net Income') row[2] = (Number(row[2]) + 1000).toFixed(2); return row.join(','); }).join('\n');
  const r = await adv.post(`${t}/imports`, { filename: 'revision.csv', contentBase64: Buffer.from(revised).toString('base64'), statement: 'pnl' });
  assert.equal(r.body.canCommit, true, JSON.stringify(r.body.issues)); assert.match(r.body.issues.find((i: any) => i.code === 'supersedes').message, /advisor-approved/);
  assert.equal((await adv.post(`${t}/imports/${r.body.batch.id}/commit`, {})).status, 409, 'warnings must be acknowledged');
  assert.equal((await adv.post(`${t}/imports/${r.body.batch.id}/commit`, { acknowledgeWarnings: true })).status, 200);
  const after = (await adv.get(`${t}/financials`)).body.months;
  assert.equal(after.at(-1).pnl.lines.revenue, orig.at(-1).pnl.lines.revenue + 100_000); assert.equal(after.at(-1).status, 'preliminary'); assert.equal(after.at(-3).status, 'approved');
  assert.equal((await adv.post(`${t}/imports/${r.body.batch.id}/rollback`)).status, 200);
  assert.equal((await adv.get(`${t}/financials`)).body.months.at(-1).pnl.lines.revenue, orig.at(-1).pnl.lines.revenue);
});

test('adjustments are separate, documented and reversible; settings validate; audit trail records it', async () => {
  const adv = await login('advisor@sjats.demo'); const t = `/api/t/${T.lakeside}`;
  const p = (await adv.get(`${t}/financials`)).body.months.at(-1); 
  assert.equal((await adv.post(`${t}/adjustments`, { from: p.period, amountCents: 300_000 })).status, 400, 'a note is required');
  await adv.post(`${t}/adjustments`, { from: p.period, amountCents: 300_000, note: 'Owner underpaid vs market (test)' });
  const q = (await adv.get(`${t}/financials`)).body.months.at(-1); assert.equal(q.pnl.adjustedPretax, p.pnl.pretax - 300_000); assert.equal(q.pnl.pretax, p.pnl.pretax, 'reported profit is untouched');
  const adj = (await adv.get(`${t}/periods`)).body.adjustments[0]; await adv.post(`${t}/adjustments/${adj.id}/reverse`);
  assert.equal((await adv.get(`${t}/financials`)).body.months.at(-1).pnl.adjustedPretax, p.pnl.pretax);
  // Sweat equity: underpay accrues; an entered distribution replaces the balance-sheet figure and reduces the balance.
  const prior = (await adv.get(`${t}/financials`)).body.months.at(-1).sweat;
  await adv.post(`${t}/adjustments`, { from: p.period, amountCents: 900_000, note: 'Owner underpaid (test)' });
  await adv.post(`${t}/adjustments`, { kind: 'owner_distribution', from: p.period, amountCents: 200_000, note: 'Distribution taken (test)' });
  const sw = (await adv.get(`${t}/financials`)).body.months.at(-1).sweat;
  assert.equal(sw.underpay, 900_000); assert.equal(sw.distributions, 200_000); assert.equal(sw.distributionSource, 'entered'); assert.equal(sw.balance, Math.max(0, prior.balanceBefore + 700_000));
  assert.equal((await adv.post(`${t}/adjustments`, { kind: 'owner_distribution', from: p.period, amountCents: -5, note: 'x' })).status, 400);
  assert.equal((await adv.put(`${t}/settings`, { settings: { pretaxTargetPct: 4 } })).status, 400);
  assert.equal((await adv.put(`${t}/settings`, { settings: { pretaxTargetPct: 0.15, dlerTarget: 2.4 } })).body.settings.pretaxTargetPct, 0.15);
  const audit = (await adv.get(`${t}/audit`)).body.entries.map((e: any) => e.action);
  for (const a of ['settings.updated', 'adjustment.reversed', 'adjustment.created', 'import.rolled_back', 'import.committed', 'scorecard.published']) assert.ok(audit.includes(a), a);
});

test('cash what-if does not change the saved plan; portfolio raises alerts', async () => {
  const adv = await login('advisor@sjats.demo'); const t = `/api/t/${T.cedar}`;
  const cash = (await adv.get(`${t}/cash`)).body; assert.equal(cash.forecast.weeks.length, 13);
  const big = cash.items.find((i: any) => i.category === 'known_receivable');
  const wi = (await adv.post(`${t}/cash/what-if`, { delays: [{ itemId: big.id, days: 30 }] })).body;
  assert.ok(wi.scenario.lowestCents <= wi.forecast.lowestCents); assert.deepEqual((await adv.get(`${t}/cash`)).body.forecast, cash.forecast);
  const pf = (await adv.get('/api/portfolio')).body.clients; const cedar = pf.find((c: any) => c.id === T.cedar);
  assert.ok(cedar.alerts.some((a: any) => a.type === 'targets')); assert.ok(cedar.alerts.some((a: any) => a.type === 'reporting'));
});

test('xlsx reader parses a real workbook layout (generated fixture)', () => {
  const sheets = readXlsx(readFileSync('tests/fixtures/sample-pnl.xlsx'));
  assert.equal(sheets[0].name, 'P&L'); assert.deepEqual(sheets[0].rows[0].slice(0, 3), ['Account', '2026-01-31', '2026-02-28']);
  assert.deepEqual(sheets[0].rows[1], ['4000 Sales & "Service"', 1200.5, 1300]); assert.equal(sheets[0].rows[3][1], '#DIV/0!'); assert.equal(sheets[0].rows[4][2], 300.25);
});

test('KPI library: every pack formula is valid, sync is idempotent, packs apply to a client, balance-sheet KPIs calculate', async () => {
  const packs = loadPacks(); assert.ok(packs.length >= 13);
  for (const p of packs) { assert.equal(new Set(p.kpis.map((k) => k.key)).size, p.kpis.length, `${p.industry}: duplicate key`); for (const k of p.kpis) { const vars = formulaVariables(k.formula); const r = evaluateFormula(k.formula, Object.fromEntries(vars.map((v) => [v, 7]))); assert.ok(r.value !== null, `${p.industry}/${k.key}`); } }
  for (const name of ['Home Services — HVAC, Plumbing & Electrical', 'Roofing & Exteriors', 'Optometry & Eye Care', 'Property Management', 'Legal', 'Medical & Med Spas', 'Restaurant & Food', 'Construction', 'Real Estate']) assert.ok(packs.some((p) => p.industry === name), name);
  assert.deepEqual(syncKpiLibrary(db), { industries: 0, kpis: 0 }, 'second sync adds nothing and overwrites nothing');
  const added = syncKpiLibrary(db, [{ industry: 'Veterinary (test add-on)', sources: [], kpis: [{ key: 'revenue_per_vet', name: 'Revenue per veterinarian', formula: 'revenue / veterinarians', unit: 'currency', direction: 'higher', basis: 'month', description: '', recommendedAction: '', dataSource: '', benchmarkNote: null }] }]);
  assert.deepEqual(added, { industries: 1, kpis: 1 }, 'a future industry is a data-only addition');
  assert.throws(() => syncKpiLibrary(db, [{ industry: 'Bad', sources: [], kpis: [{ key: 'x', name: 'x', formula: 'process.exit()', unit: 'number', direction: 'higher', basis: 'month', description: '', recommendedAction: '', dataSource: '', benchmarkNote: null }] }]));
  assert.equal(db.get("SELECT COUNT(*) AS n FROM industries WHERE name = 'Bad'")!.n, 0, 'a bad pack is rolled back entirely');
  const adv = await login('advisor@sjats.demo'); const t = `/api/t/${T.lakeside}`;
  const k0 = (await adv.get(`${t}/kpis`)).body; const opt = k0.packs.find((p: any) => p.name === 'Optometry & Eye Care');
  const ap = await adv.post(`${t}/kpis/apply-pack`, { industryId: opt.id }); assert.equal(ap.body.added, opt.kpis); assert.equal((await adv.post(`${t}/kpis/apply-pack`, { industryId: opt.id })).body.added, 0);
  const ks = (await adv.get(`${t}/kpis`)).body.kpis; const fin = (await adv.get(`${t}/financials`)).body.months;
  const ar = ks.find((x: any) => x.key === 'ar_days' && x.industry === 'Optometry & Eye Care'); const r12rev = fin.slice(-12).reduce((a: number, m: any) => a + m.pnl.lines.revenue, 0);
  assert.ok(Math.abs(ar.value - fin.at(-1).bs.accounts_receivable / r12rev * 365) < 1e-6, 'AR days = receivables / rolling-12 revenue x 365');
  const inv = ks.find((x: any) => x.key === 'days_in_inventory'); assert.equal(inv.value, null); assert.match(inv.reason, /missing input inventory/); assert.deepEqual(inv.inputsNeeded, ['inventory']);
  assert.ok(isFinancialVariable('total_assets') && !isFinancialVariable('inventory'));
  assert.equal((await (await login('owner@lakesideauto.demo')).post(`${t}/kpis/apply-pack`, { industryId: opt.id })).status, 403);
});

test('owner market-wage plan: advisor saves, approves and applies it; it drives true profit; clients see approved plans only', async () => {
  const adv = await login('advisor@sjats.demo'); const owner = await login('owner@harbordental.demo'); const adv2 = await login('advisor2@sjats.demo'); const t = `/api/t/${T.harbor}`;
  const input = { year: 2026, isSCorp: true, analysisDate: '2026-10-01', owners: [{ name: 'Harper Owner', ownershipPct: 1, approach: 'cost', roles: [{ title: 'Dentist', hoursPerYear: 1600, hourlyWageCents: 9000, source: 'BLS OEWS', sourceDate: '2026-05-01' }, { title: 'Practice manager', hoursPerYear: 400, hourlyWageCents: 4000, source: 'BLS OEWS', sourceDate: '2026-05-01' }], actualW2AnnualCents: 10_000_000, plannedDistributionsAnnualCents: 8_400_000 }] };
  assert.equal((await adv.put(`${t}/owner-wage`, { input })).status, 404, 'an advisor not assigned to the client cannot reach it');
  assert.equal((await owner.put(`${t}/owner-wage`, { input })).status, 403);
  const saved = await adv2.put(`${t}/owner-wage`, { input }); assert.equal(saved.status, 200, JSON.stringify(saved.body)); assert.equal(saved.body.result.totalReasonableAnnualCents, 16_000_000); assert.equal(saved.body.result.monthlyAdjustmentCents, 500_000);
  assert.equal((await owner.get(`${t}/owner-wage`)).body.plans.length, 0, 'drafts are not visible to the client');
  assert.equal((await adv2.post(`${t}/owner-wage/${saved.body.id}/apply`, { from: '2026-01', to: '2026-12' })).status, 409, 'must be approved first');
  const before = (await adv2.get(`${t}/financials`)).body.months.at(-1);
  await adv2.put(`${t}/owner-wage`, { input, approve: true });
  const ap = await adv2.post(`${t}/owner-wage/${saved.body.id}/apply`, { from: '2026-01', to: '2026-12' }); assert.equal(ap.body.monthlyAmountCents, 500_000); assert.ok(ap.body.applied >= 1);
  const after = (await adv2.get(`${t}/financials`)).body.months.at(-1);
  assert.equal(after.pnl.ownerAdj, 500_000); assert.equal(after.pnl.adjustedPretax, before.pnl.pretax - 500_000); assert.equal(after.pnl.pretax, before.pnl.pretax); assert.equal(after.sweat.underpay, 500_000);
  await adv2.post(`${t}/owner-wage/${saved.body.id}/apply`, { from: '2026-01', to: '2026-12' }); assert.equal((await adv2.get(`${t}/financials`)).body.months.at(-1).pnl.ownerAdj, 500_000, 're-applying replaces, never stacks');
  const seen = (await owner.get(`${t}/owner-wage`)).body.plans; assert.equal(seen.length, 1); assert.equal(seen[0].status, 'approved');
});

test('Cash Flow Waterfall view: built from the client\'s own cash, profit, debt and operating reserve; taxes paid reduce the set-aside', async () => {
  const adv = await login('advisor@sjats.demo'); const owner = await login('owner@cedarridge.demo'); const t = `/api/t/${T.cedar}`;
  const v = (await adv.get(`${t}/four-forces`)).body; assert.equal(v.available, true); assert.equal(v.forces.steps.length, 5); assert.equal(v.taxRate, 0.4);
  const fin = (await adv.get(`${t}/financials`)).body.months; assert.equal(v.forces.cashCents, fin.at(-1).bs.cash);
  assert.equal(v.walk.endingCashCents, v.walk.reportedEndingCashCents - 0 + v.walk.differenceCents * 0, 'walk ties to the balance sheet'); assert.equal(v.walk.differenceCents, 0);
  assert.equal((await owner.put(`${t}/four-forces/taxes-paid`, { fiscalYear: Number(v.fiscalYear), cents: 100 })).status, 403);
  await adv.put(`${t}/four-forces/taxes-paid`, { fiscalYear: Number(v.fiscalYear), cents: 1_000_000 });
  const v2 = (await adv.get(`${t}/four-forces`)).body; assert.equal(v2.forces.taxReserveNeededCents, Math.max(0, v.forces.taxReserveNeededCents - 1_000_000));
  await adv.put(`${t}/four-forces/taxes-paid`, { fiscalYear: Number(v.fiscalYear), projectedCents: 9_000_000 });
  const v3 = (await adv.get(`${t}/four-forces`)).body; assert.equal(v3.projectedTaxCents, 9_000_000); assert.equal(v3.forces.taxReserveNeededCents, 8_000_000, 'projection less taxes paid');
  await adv.put(`${t}/four-forces/taxes-paid`, { fiscalYear: Number(v.fiscalYear), projectedCents: null }); assert.equal((await adv.get(`${t}/four-forces`)).body.forces.taxReserveNeededCents, v2.forces.taxReserveNeededCents, 'clearing returns to the planning rate');
  assert.equal((await adv.put(`${t}/settings`, { settings: { dlerTarget: 2.0 } })).status, 200); assert.equal((await adv.get(`${t}/four-forces`)).body.taxesPaidCents, 1_000_000, 'saving settings keeps the tax figures');
  const cv = (await owner.get(`${t}/four-forces`)).body; assert.equal(cv.status, 'approved'); assert.notEqual(cv.asOf, v.asOf, 'the client view stops at the last approved month');
  assert.equal((await (await login('owner@lakesideauto.demo')).get(`/api/t/${T.cedar}/four-forces`)).status, 404);
});

test('daily cash report, two-week forecast report, return on investment and buy-in scenario', async () => {
  const adv = await login('advisor@sjats.demo'); const owner = await login('owner@cedarridge.demo'); const t = `/api/t/${T.cedar}`; const today = new Date().toISOString().slice(0, 10);
  // Daily cash is the client's bank information. Staff are locked out until the client owner allows access; staff cannot allow it themselves.
  const viewer = await login('viewer@cedarridge.demo'); const manager = await login('manager@cedarridge.demo');
  assert.equal((await adv.put(`${t}/daily-cash`, { date: today, cashBalanceCents: 1 })).status, 403, 'staff blocked without client consent');
  assert.equal((await adv.put(`${t}/bank-feed-consent`, { allowed: true })).status, 403, 'staff cannot grant themselves access'); assert.equal((await manager.put(`${t}/bank-feed-consent`, { allowed: true })).status, 403); assert.equal((await (await login('owner@harbordental.demo')).put(`${t}/bank-feed-consent`, { allowed: true })).status, 404);
  assert.equal((await viewer.put(`${t}/daily-cash`, { date: today, cashBalanceCents: 1 })).status, 403); assert.equal((await manager.put(`${t}/daily-cash`, { date: today, cashBalanceCents: 100 })).status, 200, 'the client enters its own daily cash'); assert.equal((await owner.put(`${t}/daily-cash`, { date: today, cashBalanceCents: 200 })).status, 200);
  assert.equal((await owner.get(`${t}/cash-reports`)).body.consent.allowed, false); assert.equal((await owner.put(`${t}/bank-feed-consent`, { allowed: 'yes' })).status, 400);
  const g = await owner.put(`${t}/bank-feed-consent`, { allowed: true }); assert.equal(g.status, 200); assert.equal(g.body.allowed, true); assert.ok(g.body.decidedBy);
  assert.equal((await (await login('admin@sjats.demo')).put(`/api/t/${T.harbor}/daily-cash`, { date: today, cashBalanceCents: 1 })).status, 403, 'consent from one client does not open another');
  assert.equal((await adv.put(`${t}/daily-cash`, { date: '2999-01-01', cashBalanceCents: 1 })).status, 400);
  const save = await adv.put(`${t}/daily-cash`, { date: today, cashBalanceCents: 8_265_271, deposits: [{ payer: 'Bob\'s Auto Repair', cents: 200_000 }, { payer: 'XYZ Engineering', cents: 150_000 }, { payer: 'Fred and Mary Smith', cents: 75_000 }], aging: { d0_30: 8_437_530, d31_60: 1_064_590, d61_90: 1_906_300, over90: 6_585_380 }, missedOwnerPayCents: 450_000 });
  assert.equal(save.status, 200, JSON.stringify(save.body));
  await adv.put(`${t}/settings`, { settings: { locLimitCents: 10_000_000 } });
  const rep = (await owner.get(`${t}/cash-reports`)).body;
  assert.equal(rep.days[0].deposits.reduce((a: number, d: any) => a + d.cents, 0), 425_000); assert.equal(rep.position.cents, 8_265_271, 'the latest daily balance becomes the starting cash'); assert.equal(rep.twoWeek.weeks.length, 2);
  assert.equal(rep.twoWeek.weeks[0].beginCents, 8_265_271); assert.equal(rep.twoWeek.weeks[0].payables.length, 6); assert.equal(rep.loc.limitCents, 10_000_000); assert.equal(rep.loc.availableCents, 10_000_000 - rep.loc.balanceCents);
  assert.equal(rep.aging.over90, 6_585_380); assert.equal(rep.missedOwnerPay.cents, 450_000);
  assert.equal((await (await login('owner@harbordental.demo')).get(`${t}/cash-reports`)).status, 404);
  // Withdrawing consent locks staff out again; what was already entered stays.
  assert.equal((await owner.put(`${t}/bank-feed-consent`, { allowed: false })).status, 200); assert.equal((await adv.put(`${t}/daily-cash`, { date: today, cashBalanceCents: 1 })).status, 403); assert.equal((await adv.get(`${t}/cash-reports`)).body.days[0].cashBalanceCents, 8_265_271);
  const last = (await adv.get(`${t}/financials`)).body.months.at(-1); assert.ok(last.capital); assert.ok(Math.abs(last.capital.returnOnEquity.value - last.r12.adjustedPretax / last.bs.equity) < 1e-9); assert.equal(last.capital.sweatEquityCents, last.sweat.balance);
  const b = await adv.post(`${t}/scenarios`, { type: 'buy_in', name: 'Key employee buy-in', inputs: { grossBonusCents: 5_000_000, bonusTaxRate: 0.4, avgPretaxCents: 15_000_000, equityCents: 30_000_000, profitMultiple: 3, discountPct: 0.4, sharesOutstanding: 750000, ownerTaxRate: 0.4 } });
  assert.equal(b.status, 200, JSON.stringify(b.body)); assert.equal(b.body.result.businessValueCents, 75_000_000); assert.ok(Math.abs(b.body.result.buyerOwnership - 0.0625) < 1e-9);
  assert.equal((await adv.post(`${t}/scenarios`, { type: 'buy_in', name: 'x', inputs: { sharesOutstanding: 0 } })).status, 400);
});

test('rolling-twelve view, productivity report with office payroll, report rhythm and bill-pay day over HTTP', async () => {
  const adv = await login('advisor@sjats.demo'); const owner = await login('owner@cedarridge.demo'); const t = `/api/t/${T.cedar}`;
  const fin = (await owner.get(`${t}/financials`)).body; assert.ok(fin.rolling.length >= 1 && fin.rolling.length <= 13); const last = fin.rolling.at(-1); const m = fin.months.at(-1);
  assert.equal(last.period, m.period); assert.equal(last.pretax, m.r12.adjustedPretax); assert.equal(last.salaryCap, m.r12.salaryCap); assert.equal(last.aboveBelowCents, last.pretax - last.targetCents); assert.ok(Array.isArray(fin.expenseChecks)); assert.ok(['on_time', 'late', 'due', 'overdue'].includes(fin.reporting.status));
  const wk = (await adv.get(`${t}/weekly`)).body; assert.ok(wk.productivity.rows.some((r: any) => r.kind === 'month')); assert.equal(wk.productivity.weeksMissingLabor, 0);
  assert.equal((await adv.put(`${t}/settings`, { settings: { billPayWeekday: 9 } })).status, 400); assert.equal((await owner.put(`${t}/settings`, { settings: { billPayWeekday: 1 } })).status, 403);
  const before = (await adv.get(`${t}/cash`)).body.forecast; assert.equal((await adv.put(`${t}/settings`, { settings: { billPayWeekday: 1, stretchPretaxPct: 0.2, reportDueDay: 10 } })).status, 200);
  const after = (await adv.get(`${t}/cash`)).body; const moved = after.forecast.weeks.flatMap((w: any) => w.lines).filter((l: any) => l.dueDate);
  assert.ok(moved.every((l: any) => new Date(l.date + 'T00:00:00Z').getUTCDay() === 1 || l.date === after.startDate) && moved.every((l: any) => ['vendor', 'credit_card'].includes(l.category) && l.date < l.dueDate)); assert.ok(after.forecast.totalOut >= before.totalOut);
  assert.equal((await adv.get(`${t}/financials`)).body.rolling.at(-1).stretchPct, 0.2);
  await adv.put(`${t}/settings`, { settings: { billPayWeekday: null, stretchPretaxPct: 0.15, reportDueDay: 5 } });
  assert.equal((await (await login('owner@harbordental.demo')).get(`${t}/weekly`)).status, 404);
});

test('P&L drill-down, accounting-basis flag and valuation scenario', async () => {
  const adv = await login('advisor@sjats.demo'); const owner = await login('owner@cedarridge.demo'); const other = await login('owner@harbordental.demo'); const t = `/api/t/${T.cedar}`;
  const fin = (await adv.get(`${t}/financials`)).body; const last = fin.rolling.at(-1);
  // Each line's accounts add back to the rolling-twelve figure.
  for (const [line, key] of [['revenue', 'revenue'], ['cogs', 'cogs'], ['labor', 'labor'], ['marketing', 'marketing'], ['facilities', 'facilities'], ['payroll_taxes_benefits', 'payrollTaxesBenefits'], ['other_opex', 'otherOpex'], ['other_net', 'otherNet']]) {
    const d = await adv.get(`${t}/financials/line-accounts?line=${line}&to=${last.period}`); assert.equal(d.status, 200, line); assert.equal(d.body.totalCents, last[key], `${line} accounts tie to the rolling-twelve line`); assert.equal(d.body.complete, true); assert.ok(d.body.accounts.length >= 1);
  }
  assert.equal((await adv.get(`${t}/financials/line-accounts?line=equity&to=${last.period}`)).status, 400); assert.equal((await adv.get(`${t}/financials/line-accounts?line=revenue&to=nope`)).status, 400);
  assert.equal((await other.get(`${t}/financials/line-accounts?line=revenue&to=${last.period}`)).status, 404, 'another tenant cannot drill in');
  const ownerFin = (await owner.get(`${t}/financials`)).body; const od = await owner.get(`${t}/financials/line-accounts?line=revenue&to=${last.period}`);
  if (ownerFin.months.at(-1).period !== last.period) assert.ok(od.status === 404 || !od.body.periods.includes(last.period), 'clients never see unapproved months through the drill-down');
  // Accounting basis: seeded as accrual; flipping one P&L import to cash is reported, and clients cannot change it.
  assert.equal(fin.basis.value, 'accrual'); const batches = (await adv.get(`${t}/imports`)).body.batches; const pnl = batches.find((b: any) => b.statement === 'pnl' && b.status === 'committed'); assert.equal(pnl.accounting_basis, 'accrual');
  assert.equal((await owner.put(`${t}/imports/${pnl.id}/basis`, { basis: 'cash' })).status, 403); assert.equal((await adv.put(`${t}/imports/${pnl.id}/basis`, { basis: 'modified' })).status, 400);
  assert.equal((await adv.put(`/api/t/${T.harbor}/imports/${pnl.id}/basis`, { basis: 'cash' })).status, 404, 'a batch id from another tenant is not found');
  assert.equal((await adv.put(`${t}/imports/${pnl.id}/basis`, { basis: 'cash' })).status, 200); const b2 = (await adv.get(`${t}/financials`)).body.basis; assert.ok(['cash', 'mixed'].includes(b2.value)); assert.match(b2.text, /cash/);
  await adv.put(`${t}/imports/${pnl.id}/basis`, { basis: 'accrual' });
  // Valuation: base figures come from the server even if the request tries to supply them.
  const vb = fin.valuationBase; const v = await adv.post(`${t}/scenarios`, { type: 'valuation', name: 'Estimated business value', inputs: { stakePct: 0.5, taxRate: 0.4, ebitdaMultiple: 5, revenueMultiple: 1, equityAdjustmentCents: -1_000_000, equityAdjustmentNote: 'Old receivable not collectible', pretaxCents: 999_999_999_00, elements: { customers: { rating: 'strong', note: 'Repeat work' }, bogus: { rating: 'strong', note: 'x' } } } });
  assert.equal(v.status, 200, JSON.stringify(v.body)); const r = v.body.result; assert.equal(r.adjustedEquityCents, vb.equityCents - 1_000_000); assert.equal(r.base.pretaxCents, vb.pretaxCents); assert.equal(r.valueCents, r.method === 'blended' ? r.threeYearPretaxCents + r.adjustedEquityCents : r.adjustedEquityCents); assert.deepEqual(Object.keys(v.body.inputs.elements), ['customers']);
  assert.equal((await adv.post(`${t}/scenarios`, { type: 'valuation', name: 'x', inputs: { stakePct: 0 } })).status, 400); assert.equal((await adv.post(`${t}/scenarios`, { type: 'valuation', name: 'x', inputs: { elements: { customers: { rating: 'superb' } } } })).status, 400);
  assert.equal(r.discountedValueCents, r.valueCents - r.marketabilityDiscountCents - r.controlDiscountCents); assert.equal(v.body.inputs.noteYears, 5); assert.equal((await adv.post(`${t}/scenarios`, { type: 'valuation', name: 'x', inputs: { marketabilityDiscount: 0.9 } })).status, 400);
  assert.equal((await other.get(`${t}/scenarios/${v.body.id}`)).status, 404);
  const pl = await owner.post(`${t}/scenarios`, { type: 'profit_levels', name: 'Profit tiers', inputs: { startEquityCents: 5_000_000, revenueCents: [105_000_000, 192_000_000, 207_000_000, 285_000_000, 300_000_000], levels: [0.05, 0.1, 0.15], taxRate: 0.4, coreCapitalMonths: 2 } });
  assert.equal(pl.status, 200, JSON.stringify(pl.body)); assert.deepEqual(pl.body.result.map((x: any) => x.endingValueCents), [83_270_000, 140_550_000, 187_075_000]);
  assert.equal((await owner.post(`${t}/scenarios`, { type: 'profit_levels', name: 'x', inputs: { revenueCents: [], levels: [0.1] } })).status, 400); assert.equal((await owner.post(`${t}/scenarios`, { type: 'profit_levels', name: 'x', inputs: { revenueCents: [1], levels: [5] } })).status, 400);
});

test('what-if forecast: clients run and save their own, on approved figures only, inside their own tenant', async () => {
  const adv = await login('advisor@sjats.demo'); const owner = await login('owner@cedarridge.demo'); const viewer = await login('viewer@cedarridge.demo'); const other = await login('owner@harbordental.demo'); const t = `/api/t/${T.cedar}`;
  const base = (await owner.get(`${t}/what-if`)).body; assert.equal(base.available, true); assert.equal(base.months.length, 12); assert.equal(base.baseStatus, 'approved', 'a client forecast starts from approved months'); assert.equal(base.summary.vsBaseline.pretax, 0);
  const staffBase = (await adv.get(`${t}/what-if`)).body; const approved = (await owner.get(`${t}/financials`)).body.months.at(-1).period; assert.equal(base.basePeriod, approved); assert.ok(staffBase.basePeriod >= base.basePeriod);
  const up = (await owner.post(`${t}/what-if`, { levers: { salesChangePct: 0.1, dsoDays: Math.max(0, (base.defaults.dsoDays ?? 30) - 10) } })).body;
  assert.ok(up.summary.vsBaseline.pretax > 0); assert.equal(up.levers.salesChangePct, 0.1); assert.equal(up.levers.grossProfitPct, base.defaults.grossProfitPct, 'levers left alone keep their defaults');
  assert.equal((await viewer.post(`${t}/what-if`, { levers: { salesChangePct: 0.05 } })).status, 200, 'anyone who can view may try a what-if');
  assert.equal((await owner.post(`${t}/what-if`, { levers: { salesChangePct: 9 } })).status, 400); assert.equal((await owner.post(`${t}/what-if`, { levers: { distributionPolicy: 'all' } })).status, 400); assert.equal((await owner.post(`${t}/what-if`, { levers: { debtPaydownMonthlyCents: -5 } })).status, 400);
  assert.equal((await other.get(`${t}/what-if`)).status, 404); assert.equal((await other.post(`${t}/what-if`, { levers: {} })).status, 404);
  // Saving: figures are recomputed on the server from the levers; anything else in the request is ignored.
  const saved = await owner.post(`${t}/scenarios`, { type: 'forecast', name: 'Grow 10% and collect faster', inputs: { salesChangePct: 0.1, months: [{ cashEnd: 1 }], summary: { fake: true } } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body)); assert.deepEqual(Object.keys(saved.body.inputs).sort(), Object.keys(base.defaults).sort()); assert.equal(saved.body.result.months.length, 12); assert.ok(saved.body.result.summary.vsBaseline.pretax > 0);
  assert.equal((await viewer.post(`${t}/scenarios`, { type: 'forecast', name: 'x', inputs: {} })).status, 403); assert.equal((await other.get(`${t}/scenarios/${saved.body.id}`)).status, 404);
  const listed = (await adv.get(`${t}/scenarios`)).body.scenarios.find((x: any) => x.id === saved.body.id); assert.equal(listed.type, 'forecast'); assert.ok(listed.summary.pretaxDelta > 0);
  // Tax implications line on the scorecard: advisor comment and grade.
  const sc = await adv.put(`${t}/scorecard`, { commentary: { tax: { grade: 'OK', comment: 'Hold cash until the September estimate is set aside.' } }, publish: false }); assert.equal(sc.status, 200, JSON.stringify(sc.body));
  assert.equal((await adv.get(`${t}/scorecard`)).body.current.commentary.tax.grade, 'OK'); assert.equal((await adv.put(`${t}/scorecard`, { commentary: { tax: { grade: 'Superb' } }, publish: false })).status, 400);
});

test('client communications: staff only, approved figures only, packet PDF and draft email', async () => {
  const adv = await login('advisor@sjats.demo'); const t = `/api/t/${T.cedar}`;
  // Every client role is refused on every route; another tenant's client cannot even see that it exists.
  for (const who of ['owner@cedarridge.demo', 'manager@cedarridge.demo', 'viewer@cedarridge.demo']) { const u = await login(who);
    assert.equal((await u.get(`${t}/comms`)).status, 403, who); assert.equal((await u.get(`${t}/comms/packet.pdf`)).status, 403); assert.equal((await u.put(`${t}/comms/template`, { subject: 'x', body: 'y' })).status, 403); assert.equal((await u.post(`${t}/comms/email.eml`, { to: [], subject: 'x', body: 'y' })).status, 403); }
  assert.equal((await (await login('owner@harbordental.demo')).get(`${t}/comms`)).status, 404);
  const d = (await adv.get(`${t}/comms`)).body; assert.equal(d.ready, true); const approved = (await (await login('owner@cedarridge.demo')).get(`${t}/financials`)).body.months.at(-1).period; assert.equal(d.period, approved, 'the packet covers the latest approved month, not a later unapproved one');
  assert.ok(d.notices.some((n: string) => /not approved/.test(n))); assert.equal(d.recipients[0].email, 'owner@cedarridge.demo'); assert.equal(d.draft.unknown.length, 0); assert.doesNotMatch(d.draft.body, /\{\{/);
  assert.match(d.draft.subject, /^Cedar Ridge Builders: [A-Z][a-z]+ \d{4} financial statements/); assert.match(d.draft.body, /^Hi Casey,/); assert.ok(d.draft.body.includes(d.values.revenue)); assert.match(d.draft.body, /Avery Advisor\nSJ Advisory & Tax/);
  assert.doesNotMatch(d.draft.body, /\n\n\n/, 'an empty personal note leaves no gap'); assert.ok((await adv.get(`${t}/comms?note=${encodeURIComponent('Good to see the Maple Street job close out.')}`)).body.draft.body.includes('Maple Street job'));
  // Meeting script: figures come from the same approved data; internal notes are present.
  assert.ok(d.script.sections.length >= 5); assert.ok(d.script.sections[1].say.some((l: string) => l.includes(d.values.revenue))); assert.match(d.scriptText, /Internal document: not for the client/); assert.ok(d.script.sections.every((x: any) => x.say.every((l: string) => !/undefined|NaN/.test(l))));
  // Template: per client, validated, resettable; another client keeps the default.
  assert.equal((await adv.put(`${t}/comms/template`, { subject: 'Hi {{frist_name}}', body: 'x' })).status, 400);
  const saved = await adv.put(`${t}/comms/template`, { subject: '{{period}} numbers for {{client_name}}', body: 'Dear {{first_name}},\n\n{{highlights}}\n\n{{personal_note}}\n\nSee {{dashboard_url}}\n\n{{advisor_name}}' }); assert.equal(saved.status, 200); assert.equal(saved.body.custom, true);
  const d2 = (await adv.get(`${t}/comms`)).body; assert.match(d2.draft.subject, /numbers for Cedar Ridge Builders$/); assert.match(d2.draft.body, /^Dear Casey,/); assert.equal((await (await login('admin@sjats.demo')).get(`/api/t/${T.harbor}/comms`)).body.template.custom, false);
  // Packet: a real PDF with one page object per page and a consistent cross-reference table.
  const pdf = await adv.raw(`${t}/comms/packet.pdf`); assert.equal(pdf.status, 200); assert.equal(pdf.headers.get('content-type'), 'application/pdf'); const bytes = Buffer.from(await pdf.arrayBuffer()); const txt = bytes.toString('latin1');
  assert.ok(txt.startsWith('%PDF-1.4')); assert.ok(txt.trimEnd().endsWith('%%EOF')); const pages = (txt.match(/\/Type \/Page /g) ?? []).length; assert.ok(pages >= 3); assert.match(txt, new RegExp(`/Count ${pages} `));
  const xref = Number(txt.match(/startxref\n(\d+)/)![1]); assert.equal(txt.slice(xref, xref + 4), 'xref'); for (const m of txt.slice(xref).matchAll(/^(\d{10}) 00000 n /gm)) assert.match(txt.slice(Number(m[1]), Number(m[1]) + 12), /^\d+ 0 obj/);
  { const g = (await import('../src/server/comms.ts')).gather(db, T.cedar, { advisorName: 'x', publicUrl: null }) as any; const b = g.months[g.idx].bs; const assets = b.cash + b.accounts_receivable + b.other_current_assets + b.fixed_assets + b.accumulated_depreciation + b.other_assets; const fm = (c: number) => `$${Math.round(c / 100).toLocaleString('en-US')}`;
    assert.equal((txt.match(new RegExp(`\\(${fm(assets).replace(/[$]/g, '\\$')}\\)`, 'g')) ?? []).length >= 2, true, 'total assets equals total liabilities and equity in the packet'); }
  assert.ok(txt.includes('(Management profit and loss)')); assert.ok(txt.includes('(Balance sheet)')); assert.ok(txt.includes('SYNTHETIC DEMO DATA')); assert.ok(txt.includes(`(${d.values.revenue})`), 'the packet and the email quote the same sales figure');
  // Draft email: unsent, addressed, with the packet attached; unfilled fields and bad addresses are refused.
  const eml = await adv.raw(`${t}/comms/email.eml`, { method: 'POST', body: { to: ['owner@cedarridge.demo'], subject: d.draft.subject, body: d.draft.body } }); assert.equal(eml.status, 200); const e = Buffer.from(await eml.arrayBuffer()).toString('utf8');
  assert.match(e, /^To: owner@cedarridge\.demo\r\n/); assert.match(e, /\r\nX-Unsent: 1\r\n/); assert.match(e, /Content-Type: application\/pdf; name="Cedar-Ridge-Builders-\d{4}-\d{2}-financial-statements\.pdf"/);
  const att = Buffer.from(e.split('Content-Disposition: attachment')[1].split('\r\n\r\n')[1].split('\r\n--')[0].replace(/\r\n/g, ''), 'base64'); assert.ok(att.toString('latin1').startsWith('%PDF-1.4')); assert.equal(att.length, bytes.length);
  const bodyPart = Buffer.from(e.split('Content-Transfer-Encoding: base64\r\n\r\n')[1].split('\r\n--')[0].replace(/\r\n/g, ''), 'base64').toString('utf8'); assert.ok(bodyPart.startsWith('Hi Casey,'));
  assert.equal((await adv.raw(`${t}/comms/email.eml`, { method: 'POST', body: { to: ['not-an-address'], subject: 's', body: 'b' } })).status, 400); assert.equal((await adv.raw(`${t}/comms/email.eml`, { method: 'POST', body: { to: [], subject: 'Hi {{first_name}}', body: 'b' } })).status, 400);
  assert.equal((await adv.raw(`${t}/comms/email.eml`, { method: 'POST', body: { to: ['a@b.co\r\nBcc: x@y.z'], subject: 's', body: 'b' } })).status, 400, 'header injection through a recipient is refused');
  assert.equal((await adv.put(`${t}/comms/template`, { reset: true })).body.custom, false);
});

test('rolling three is served with the financials and the scorecard, on the months each role may see', async () => {
  const adv = await login('advisor@sjats.demo'); const owner = await login('owner@cedarridge.demo'); const t = `/api/t/${T.cedar}`;
  const fin = (await owner.get(`${t}/financials`)).body; assert.equal(fin.recent.period, fin.months.at(-1).period); assert.deepEqual(fin.recent.signals.map((x: any) => x.key), ['profitability', 'sales', 'gross_profit', 'labor', 'opex']);
  const m3 = fin.months.slice(-3); const rev3 = m3.reduce((a: number, m: any) => a + m.pnl.lines.revenue, 0); assert.equal(fin.recent.signals[1].r3, rev3); assert.ok(Math.abs(fin.recent.signals[0].r3 - m3.reduce((a: number, m: any) => a + m.pnl.adjustedPretax, 0) / rev3) < 1e-9);
  const sc = (await owner.get(`${t}/scorecard`)).body; if (sc.current) assert.equal(sc.recent?.period ?? sc.current.period, sc.current.period);
  const staff = (await adv.get(`${t}/scorecard`)).body; assert.equal(staff.recent.period, staff.current.period); assert.ok(staff.recent.period >= fin.recent.period);
  assert.equal((await (await login('owner@harbordental.demo')).get(`${t}/scorecard`)).status, 404);
});
