// Import pipeline: preview → stage → map → validate → commit → (rollback). Nothing reaches reports until it is committed,
// and nothing commits while a blocking validation error is open.
import { createHash } from 'node:crypto';
import { BS_ASSET_LINES, BS_LIAB_EQUITY_LINES, BS_LINES, PNL_LINES, addMonths, fmtMoney, monthsBetween, periodLabel } from '../engine/core.ts';
import { type Db, now, uid } from './db.ts';
import { type Cell, type Sheet, parseAmount, parsePeriod, readCsv, readXlsx } from './xlsx.ts';

export const SPECIAL_LINES = ['ignore', 'control_pretax'] as const;
export const validLines = (statement: string) => [...(statement === 'pnl' ? PNL_LINES : BS_LINES), ...(statement === 'pnl' ? SPECIAL_LINES : ['ignore'])] as string[];

export interface Issue { severity: 'error' | 'warning' | 'info'; code: string; message: string; detail?: string[] }

export function readSheets(filename: string, data: Buffer): Sheet[] {
  if (/\.csv$/i.test(filename)) return [{ name: 'CSV', rows: readCsv(data.toString('utf8')) }];
  if (/\.xlsx$/i.test(filename)) return readXlsx(data);
  throw new Error('Unsupported file type. Upload an .xlsx or .csv file.');
}

export interface Layout { headerRow: number; periodCols: { col: number; period: string }[]; nameCol: number }
/** Source detection: find the heading row that contains month columns ("wide" statement layout exported by accounting systems). */
export function detectLayout(rows: Cell[][]): Layout | null {
  let best: Layout | null = null;
  for (let r = 0; r < Math.min(rows.length, 25); r++) {
    const cols = (rows[r] ?? []).map((c, col) => ({ col, period: parsePeriod(c) })).filter((x): x is { col: number; period: string } => x.period !== null && x.col > 0);
    if (cols.length > (best?.periodCols.length ?? 0)) best = { headerRow: r, periodCols: cols, nameCol: 0 };
  }
  return best;
}

export function preview(filename: string, data: Buffer) {
  const sheets = readSheets(filename, data);
  return sheets.map((s) => {
    const layout = detectLayout(s.rows);
    return { name: s.name, rowCount: s.rows.length, detected: layout ? { headerRow: layout.headerRow + 1, periods: layout.periodCols.map((p) => p.period) } : null, sample: s.rows.slice(0, 12).map((r) => r.slice(0, 8)) };
  });
}

/** Mapping suggestions for new accounts. Suggestions are shown to the advisor; they are never applied silently. */
export function suggestLine(statement: string, name: string): string | null {
  const n = name.toLowerCase();
  const rules: [RegExp, string][] = statement === 'pnl' ? [
    [/^total |gross profit|gross margin|contribution margin|net operating income|operating income$|^net other/, 'ignore'],
    [/net income|pre-?tax/, 'control_pretax'],
    [/interest expense/, 'interest_expense'], [/depreciation|amortization/, 'depreciation'],
    [/other income|interest earned|other expense|miscellaneous/, 'other_income_expense'],
    [/payroll tax|benefit|health insurance|401|retirement|workers.? comp/, 'payroll_taxes_benefits'],
    [/direct labor|field labor|field wages|production wages|technician wages|labor - direct|cost of labor/, 'direct_labor'],
    [/officer|admin|management|office (salar|wages)|salaries/, 'mgmt_labor'],
    [/cost of goods|cogs|cost of sales/, 'cogs'], [/\bsales\b|revenue|fees earned/, 'revenue'],
    [/materials|subcontract|purchases|parts|supplies - job|equipment rental/, 'cogs'],
    [/rent|lease|utilit|facilit|repairs/, 'facilities'], [/advertis|marketing|promotion/, 'marketing'],
    [/revenue|sales|income|fees earned/, 'revenue'],
    [/expense|insurance|software|professional|travel|office|dues|bank|telephone|vehicle|meals|licenses/, 'other_opex'],
  ] : [
    [/^total /, 'ignore'], [/line of credit|loc\b/, 'line_of_credit'], [/credit card/, 'credit_cards'],
    [/accounts receivable|a\/r/, 'accounts_receivable'], [/accounts payable|a\/p/, 'accounts_payable'],
    [/accumulated dep/, 'accumulated_depreciation'], [/checking|savings|cash|bank/, 'cash'],
    [/note|loan|long.?term/, 'notes_payable'], [/equipment|vehicle|fixed asset|furniture|leasehold/, 'fixed_assets'],
    [/equity|retained|capital|stock|distribution|draw|net income/, 'equity'],
    [/payroll liab|sales tax|accrued|deferred|current liab/, 'other_current_liabilities'],
    [/prepaid|inventory|undeposited|other current asset/, 'other_current_assets'], [/deposit|other asset/, 'other_assets'],
  ];
  return rules.find(([re]) => re.test(n))?.[1] ?? null;
}

export function stage(db: Db, tenantId: string, userId: string, o: { filename: string; data: Buffer; statement: 'pnl' | 'bs'; sheet?: string }): { batchId: string } {
  const sheets = readSheets(o.filename, o.data);
  const sheet = (o.sheet ? sheets.find((s) => s.name === o.sheet) : sheets[0]);
  if (!sheet) throw new Error('The selected sheet was not found in the file.');
  const layout = detectLayout(sheet.rows);
  if (!layout) throw new Error('No month columns were found. The file needs a heading row with months (for example "Jan 2026" or "2026-01") and account names in the first column.');
  const issues: Issue[] = []; const invalid: string[] = []; const dupes: string[] = [];
  const seenCols = new Map<string, number>();
  for (const pc of layout.periodCols) { if (seenCols.has(pc.period)) issues.push({ severity: 'error', code: 'duplicate_period_column', message: `The month ${periodLabel(pc.period)} appears in more than one column.` }); seenCols.set(pc.period, pc.col); }
  const periods = [...seenCols.keys()].sort();
  const byAccount = new Map<string, Map<string, number>>();
  for (let r = layout.headerRow + 1; r < sheet.rows.length; r++) {
    const row = sheet.rows[r] ?? []; const rawName = row[layout.nameCol];
    if (rawName === null || rawName === undefined || String(rawName).trim() === '') continue;
    const name = String(rawName).trim().replace(/\s+/g, ' ');
    let any = false; const vals = new Map<string, number>();
    for (const [period, col] of seenCols) {
      const a = parseAmount(row[col] ?? null);
      if (a === 'invalid') { invalid.push(`${name}, ${periodLabel(period)}: "${String(row[col])}"`); any = true; }
      else if (a !== 'blank') { vals.set(period, a); any = true; }
    }
    if (!any) continue; // section heading
    if (byAccount.has(name)) { dupes.push(name); const ex = byAccount.get(name)!; for (const [p, v] of vals) ex.set(p, (ex.get(p) ?? 0) + v); }
    else byAccount.set(name, vals);
  }
  if (invalid.length) issues.push({ severity: 'error', code: 'non_numeric', message: `${invalid.length} cell(s) contain text or spreadsheet errors where an amount is expected. Correct the source file and re-import.`, detail: invalid.slice(0, 20) });
  if (dupes.length) issues.push({ severity: 'warning', code: 'duplicate_accounts', message: `${dupes.length} account name(s) appear more than once in the file; their amounts were added together.`, detail: [...new Set(dupes)].slice(0, 20) });
  if (!byAccount.size) throw new Error('No account rows with amounts were found below the heading row.');

  const batchId = uid(); const sha256 = createHash('sha256').update(o.data).digest('hex');
  db.tx(() => {
    db.run('INSERT INTO import_batches (id, tenant_id, statement, filename, sha256, sheet, status, period_from, period_to, row_count, parse_issues_json, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      batchId, tenantId, o.statement, o.filename.slice(0, 200), sha256, sheet.name, 'staged', periods[0], periods[periods.length - 1], byAccount.size, JSON.stringify(issues), userId, now());
    for (const [name, vals] of byAccount) {
      let acct = db.get('SELECT id FROM accounts WHERE tenant_id = ? AND statement = ? AND name = ?', tenantId, o.statement, name);
      if (!acct) { acct = { id: uid() }; db.run('INSERT INTO accounts (id, tenant_id, statement, name) VALUES (?,?,?,?)', acct.id, tenantId, o.statement, name); }
      for (const [period, cents] of vals) db.run('INSERT INTO facts (tenant_id, batch_id, account_id, period, amount_cents, active) VALUES (?,?,?,?,?,0)', tenantId, batchId, acct.id, period, cents);
    }
    db.audit(tenantId, userId, 'import.staged', 'import_batch', batchId, { filename: o.filename, statement: o.statement, accounts: byAccount.size });
  });
  return { batchId };
}

export interface BatchReview {
  batch: Record<string, any>; accounts: { id: string; name: string; line: string | null; sign: number; suggested: string | null; total: number }[];
  issues: Issue[]; canCommit: boolean; periods: string[];
}

export function review(db: Db, tenantId: string, batchId: string): BatchReview | null {
  const batch = db.get('SELECT * FROM import_batches WHERE id = ? AND tenant_id = ?', batchId, tenantId);
  if (!batch) return null;
  const facts = db.all('SELECT f.period, f.amount_cents, a.id AS account_id, a.name, a.line, a.sign FROM facts f JOIN accounts a ON a.id = f.account_id WHERE f.batch_id = ? AND f.tenant_id = ?', batchId, tenantId);
  const issues: Issue[] = JSON.parse(batch.parse_issues_json);
  const accounts = new Map<string, BatchReview['accounts'][number]>();
  for (const f of facts) {
    const a = accounts.get(f.account_id) ?? { id: f.account_id, name: f.name, line: f.line, sign: f.sign, suggested: f.line ? null : suggestLine(batch.statement, f.name), total: 0 };
    a.total += f.amount_cents; accounts.set(f.account_id, a);
  }
  const periods = [...new Set(facts.map((f) => f.period as string))].sort();
  const unmapped = [...accounts.values()].filter((a) => !a.line);
  if (unmapped.length) issues.push({ severity: 'error', code: 'unmapped_accounts', message: `${unmapped.length} account(s) are not mapped to the management ${batch.statement === 'pnl' ? 'P&L' : 'balance sheet'}. Map each one (or mark it as a subtotal to ignore) before committing.`, detail: unmapped.map((a) => a.name).slice(0, 30) });

  // Missing months inside the file.
  const missing: string[] = [];
  for (let p = periods[0]; p && p < periods[periods.length - 1]; p = addMonths(p, 1)) if (!periods.includes(p)) missing.push(periodLabel(p));
  if (missing.length) issues.push({ severity: 'warning', code: 'missing_months', message: `The file skips ${missing.length} month(s). Rolling-12 and trend figures that span them would be understated.`, detail: missing });
  // Gap between existing data and this file.
  const existing = db.get("SELECT MAX(f.period) AS mx FROM facts f JOIN accounts a ON a.id = f.account_id WHERE f.tenant_id = ? AND f.active = 1 AND a.statement = ?", tenantId, batch.statement);
  if (existing?.mx && periods.length && monthsBetween(existing.mx, periods[0]) > 1) issues.push({ severity: 'warning', code: 'gap_after_existing', message: `Existing data ends ${periodLabel(existing.mx)} and this file starts ${periodLabel(periods[0])}, leaving a gap.` });
  const thisMonth = now().slice(0, 7);
  const future = periods.filter((p) => p > thisMonth);
  if (future.length) issues.push({ severity: 'warning', code: 'future_periods', message: `${future.length} month(s) are in the future. Actuals should not include months that have not happened; forecasts belong in scenarios.`, detail: future.map(periodLabel) });
  if (batch.status === 'staged') {
    const dup = db.get("SELECT id, committed_at FROM import_batches WHERE tenant_id = ? AND sha256 = ? AND status = 'committed' AND id <> ?", tenantId, batch.sha256, batchId);
    if (dup) issues.push({ severity: 'error', code: 'duplicate_file', message: `This exact file was already imported on ${String(dup.committed_at).slice(0, 10)}. Importing it again would duplicate nothing but is blocked to keep the history clean.` });
    const overlap = db.all("SELECT DISTINCT f.period FROM facts f JOIN accounts a ON a.id = f.account_id WHERE f.tenant_id = ? AND f.active = 1 AND a.statement = ? AND f.period >= ? AND f.period <= ?", tenantId, batch.statement, periods[0] ?? '', periods[periods.length - 1] ?? '').map((r) => r.period as string).filter((p) => periods.includes(p));
    if (overlap.length) {
      const approved = db.all("SELECT period FROM period_status WHERE tenant_id = ? AND status = 'approved'", tenantId).map((r) => r.period as string).filter((p) => overlap.includes(p));
      issues.push({ severity: 'warning', code: 'supersedes', message: `${overlap.length} month(s) already have data and will be replaced by this import${approved.length ? `; ${approved.length} of them are advisor-approved and will return to "preliminary"` : ''}. A rollback restores the earlier figures.`, detail: overlap.map(periodLabel) });
    }
  }
  // Statement-level integrity checks on the mapped figures.
  const sums = new Map<string, Record<string, number>>();
  for (const f of facts) { if (!f.line || f.line === 'ignore') continue; const s = sums.get(f.period) ?? {}; s[f.line] = (s[f.line] ?? 0) + f.amount_cents * f.sign; sums.set(f.period, s); }
  if (!unmapped.length) {
    if (batch.statement === 'pnl') {
      const noRev: string[] = [], mismatch: string[] = [];
      for (const p of periods) {
        const s = sums.get(p) ?? {}; const g = (k: string) => s[k] ?? 0;
        const expenses = g('cogs') + g('direct_labor') + g('facilities') + g('marketing') + g('mgmt_labor') + g('payroll_taxes_benefits') + g('other_opex');
        if (g('revenue') <= 0 && expenses > 0) noRev.push(periodLabel(p));
        if ('control_pretax' in s) {
          const pretax = g('revenue') - expenses - g('depreciation') - g('interest_expense') + g('other_income_expense');
          if (Math.abs(pretax - s.control_pretax) > 100) mismatch.push(`${periodLabel(p)}: mapped accounts give ${fmtMoney(pretax)}, the file's net income line says ${fmtMoney(s.control_pretax)} (difference ${fmtMoney(pretax - s.control_pretax)})`);
        }
      }
      if (noRev.length) issues.push({ severity: 'warning', code: 'no_revenue', message: `${noRev.length} month(s) have expenses but no revenue. Margins and labor yield will show N/A for them.`, detail: noRev });
      if (mismatch.length) issues.push({ severity: 'error', code: 'control_total_mismatch', message: 'The mapped accounts do not reconcile to the net income line in the file. An account is probably missing, mapped twice, or mapped with the wrong sign.', detail: mismatch.slice(0, 24) });
    } else {
      const off: string[] = [];
      for (const p of periods) {
        const s = sums.get(p) ?? {}; const assets = BS_ASSET_LINES.reduce((a, k) => a + (s[k] ?? 0), 0); const le = BS_LIAB_EQUITY_LINES.reduce((a, k) => a + (s[k] ?? 0), 0);
        if (Math.abs(assets - le) > 100) off.push(`${periodLabel(p)}: assets ${fmtMoney(assets)} vs liabilities + equity ${fmtMoney(le)} (difference ${fmtMoney(assets - le)})`);
      }
      if (off.length) issues.push({ severity: 'error', code: 'bs_out_of_balance', message: `The balance sheet does not balance in ${off.length} month(s). Cash and operating reserve figures cannot be trusted until it does.`, detail: off.slice(0, 24) });
    }
  }
  const hasErr = issues.some((i) => i.severity === 'error');
  return { batch, accounts: [...accounts.values()].sort((a, b) => a.name.localeCompare(b.name)), issues, canCommit: batch.status === 'staged' && !hasErr, periods };
}

export function commit(db: Db, tenantId: string, userId: string, batchId: string, acknowledgeWarnings: boolean): { ok: true } | { ok: false; error: string; issues: Issue[] } {
  const r = review(db, tenantId, batchId);
  if (!r) return { ok: false, error: 'Import not found.', issues: [] };
  if (r.batch.status !== 'staged') return { ok: false, error: `This import is already ${r.batch.status.replace('_', ' ')}.`, issues: r.issues };
  if (!r.canCommit) return { ok: false, error: 'Resolve the validation errors before committing.', issues: r.issues };
  if (r.issues.some((i) => i.severity === 'warning') && !acknowledgeWarnings) return { ok: false, error: 'Review and acknowledge the warnings before committing.', issues: r.issues };
  db.tx(() => {
    // Supersede (never delete) earlier facts for the same statement and months.
    db.run(`UPDATE facts SET active = 0, superseded_by = ? WHERE tenant_id = ? AND active = 1 AND period IN (SELECT DISTINCT period FROM facts WHERE batch_id = ?)
            AND account_id IN (SELECT id FROM accounts WHERE tenant_id = ? AND statement = ?)`, batchId, tenantId, batchId, tenantId, r.batch.statement);
    db.run('UPDATE facts SET active = 1 WHERE batch_id = ? AND tenant_id = ?', batchId, tenantId);
    db.run("UPDATE import_batches SET status = 'committed', committed_at = ? WHERE id = ? AND tenant_id = ?", now(), batchId, tenantId);
    for (const p of r.periods) db.run("INSERT INTO period_status (tenant_id, period, status, updated_by, updated_at) VALUES (?,?,'preliminary',?,?) ON CONFLICT (tenant_id, period) DO UPDATE SET status = 'preliminary', updated_by = excluded.updated_by, updated_at = excluded.updated_at", tenantId, p, userId, now());
    db.audit(tenantId, userId, 'import.committed', 'import_batch', batchId, { periods: r.periods.length, warningsAcknowledged: r.issues.filter((i) => i.severity === 'warning').map((i) => i.code) });
  });
  return { ok: true };
}

export function rollback(db: Db, tenantId: string, userId: string, batchId: string): boolean {
  const b = db.get("SELECT id FROM import_batches WHERE id = ? AND tenant_id = ? AND status = 'committed'", batchId, tenantId);
  if (!b) return false;
  db.tx(() => {
    const periods = db.all('SELECT DISTINCT period FROM facts WHERE batch_id = ? AND tenant_id = ?', batchId, tenantId).map((r) => r.period as string);
    db.run('UPDATE facts SET active = 0 WHERE batch_id = ? AND tenant_id = ?', batchId, tenantId);
    db.run('UPDATE facts SET active = 1, superseded_by = NULL WHERE superseded_by = ? AND tenant_id = ?', batchId, tenantId);
    db.run("UPDATE import_batches SET status = 'rolled_back', rolled_back_at = ? WHERE id = ? AND tenant_id = ?", now(), batchId, tenantId);
    for (const p of periods) db.run("UPDATE period_status SET status = 'preliminary', updated_by = ?, updated_at = ? WHERE tenant_id = ? AND period = ?", userId, now(), tenantId, p);
    db.audit(tenantId, userId, 'import.rolled_back', 'import_batch', batchId);
  });
  return true;
}
