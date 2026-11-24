-- CFO Intelligence — embedded (SQLite) schema used for local development, tests and the demo.
-- Every business table carries tenant_id; every query in src/server filters on it. The PostgreSQL target schema
-- (db/schema.postgres.sql) adds row-level security on the same columns. All money is INTEGER cents.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS industries (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'active');

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, portal_client_id TEXT UNIQUE, industry_id TEXT REFERENCES industries(id),
  settings_json TEXT NOT NULL DEFAULT '{}', is_synthetic INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, password_hash TEXT,
  staff_role TEXT CHECK (staff_role IN ('super_admin','advisor','analyst')), active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS memberships (
  user_id TEXT NOT NULL REFERENCES users(id), tenant_id TEXT NOT NULL REFERENCES tenants(id),
  role TEXT NOT NULL CHECK (role IN ('advisor','analyst','client_owner','client_manager','client_viewer')), PRIMARY KEY (user_id, tenant_id));

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), pinned_tenant_id TEXT REFERENCES tenants(id),
  via TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT);
CREATE TABLE IF NOT EXISTS launch_tokens_used (jti TEXT PRIMARY KEY, expires_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT, user_id TEXT, action TEXT NOT NULL, entity TEXT, entity_id TEXT, detail_json TEXT, at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS audit_tenant ON audit_log (tenant_id, at);

-- Client chart of accounts and its one-time mapping into the standardized management statements.
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), statement TEXT NOT NULL CHECK (statement IN ('pnl','bs')),
  name TEXT NOT NULL, line TEXT, sign INTEGER NOT NULL DEFAULT 1, UNIQUE (tenant_id, statement, name));

CREATE TABLE IF NOT EXISTS import_batches (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), statement TEXT NOT NULL, filename TEXT NOT NULL, sha256 TEXT NOT NULL,
  sheet TEXT, status TEXT NOT NULL CHECK (status IN ('staged','committed','rolled_back')), period_from TEXT, period_to TEXT,
  accounting_basis TEXT NOT NULL DEFAULT 'unknown', -- 'accrual' | 'cash' | 'unknown': how the source books were kept
  row_count INTEGER NOT NULL DEFAULT 0, parse_issues_json TEXT NOT NULL DEFAULT '[]', created_by TEXT NOT NULL, created_at TEXT NOT NULL, committed_at TEXT, rolled_back_at TEXT);

-- Stored accounting actuals. Never edited in place: a later import supersedes, a rollback restores.
CREATE TABLE IF NOT EXISTS facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL REFERENCES tenants(id), batch_id TEXT NOT NULL REFERENCES import_batches(id),
  account_id TEXT NOT NULL REFERENCES accounts(id), period TEXT NOT NULL, amount_cents INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 0, superseded_by TEXT);
CREATE INDEX IF NOT EXISTS facts_tenant ON facts (tenant_id, active, period);
CREATE INDEX IF NOT EXISTS facts_batch ON facts (batch_id);

CREATE TABLE IF NOT EXISTS period_status (
  tenant_id TEXT NOT NULL REFERENCES tenants(id), period TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('preliminary','reconciled','approved')),
  updated_by TEXT, updated_at TEXT, PRIMARY KEY (tenant_id, period));

-- Manual adjustments (owner compensation normalization). Separate from source records, documented, reversible.
CREATE TABLE IF NOT EXISTS adjustments (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), period TEXT NOT NULL, kind TEXT NOT NULL, amount_cents INTEGER NOT NULL,
  note TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL, reversed_by TEXT, reversed_at TEXT);

CREATE TABLE IF NOT EXISTS scorecards (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), period TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('draft','published')),
  snapshot_json TEXT NOT NULL, commentary_json TEXT NOT NULL DEFAULT '{}', internal_notes TEXT NOT NULL DEFAULT '', engine_version TEXT NOT NULL,
  published_by TEXT, published_at TEXT, updated_at TEXT NOT NULL, UNIQUE (tenant_id, period));

CREATE TABLE IF NOT EXISTS weekly_entries (
  tenant_id TEXT NOT NULL REFERENCES tenants(id), week_start TEXT NOT NULL, revenue_cents INTEGER NOT NULL, cogs_cents INTEGER NOT NULL,
  direct_labor_cents INTEGER NOT NULL, other_labor_cents INTEGER, cash_balance_cents INTEGER, source TEXT NOT NULL, entered_by TEXT, updated_at TEXT, PRIMARY KEY (tenant_id, week_start));

-- Weekly reports are immutable snapshots once published; history is never rewritten.
CREATE TABLE IF NOT EXISTS weekly_reports (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), week_start TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('draft','published')),
  snapshot_json TEXT NOT NULL, briefing_json TEXT NOT NULL, next_steps_json TEXT NOT NULL DEFAULT '[]', internal_notes TEXT NOT NULL DEFAULT '',
  published_by TEXT, published_at TEXT, acknowledged_by TEXT, acknowledged_at TEXT, updated_at TEXT NOT NULL, UNIQUE (tenant_id, week_start));

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), entity TEXT NOT NULL, entity_id TEXT NOT NULL, user_id TEXT NOT NULL,
  body TEXT NOT NULL, visibility TEXT NOT NULL CHECK (visibility IN ('client','internal')), created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS comments_entity ON comments (tenant_id, entity, entity_id);

CREATE TABLE IF NOT EXISTS cash_items (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), name TEXT NOT NULL, direction TEXT NOT NULL CHECK (direction IN ('in','out')),
  category TEXT NOT NULL, amount_cents INTEGER NOT NULL, cadence TEXT NOT NULL, anchor_date TEXT NOT NULL, end_date TEXT, second_day INTEGER, active INTEGER NOT NULL DEFAULT 1);

-- Scenario data lives apart from actuals and can never overwrite them.
CREATE TABLE IF NOT EXISTS scenarios (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), type TEXT NOT NULL, name TEXT NOT NULL, inputs_json TEXT NOT NULL,
  result_json TEXT, baseline_period TEXT, status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','shared','approval_requested','approved','declined')),
  engine_version TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS kpi_definitions (
  id TEXT PRIMARY KEY, industry_id TEXT NOT NULL REFERENCES industries(id), key TEXT NOT NULL, name TEXT NOT NULL, formula TEXT NOT NULL,
  unit TEXT NOT NULL, basis TEXT NOT NULL DEFAULT 'month' CHECK (basis IN ('month','r12')), frequency TEXT NOT NULL DEFAULT 'monthly',
  direction TEXT NOT NULL DEFAULT 'higher', default_target REAL, alert_threshold REAL, description TEXT NOT NULL DEFAULT '', recommended_action TEXT NOT NULL DEFAULT '',
  data_source TEXT NOT NULL DEFAULT '', benchmark_source TEXT, client_visible INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  updated_by TEXT, updated_at TEXT NOT NULL, UNIQUE (industry_id, key));
CREATE TABLE IF NOT EXISTS tenant_kpis (
  tenant_id TEXT NOT NULL REFERENCES tenants(id), kpi_id TEXT NOT NULL REFERENCES kpi_definitions(id), target REAL, alert_threshold REAL,
  client_visible INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (tenant_id, kpi_id));
CREATE TABLE IF NOT EXISTS kpi_inputs (
  tenant_id TEXT NOT NULL REFERENCES tenants(id), key TEXT NOT NULL, period TEXT NOT NULL, value REAL NOT NULL, entered_by TEXT, updated_at TEXT,
  PRIMARY KEY (tenant_id, key, period));

CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), title TEXT NOT NULL, kpi TEXT, observation TEXT NOT NULL DEFAULT '', cause TEXT NOT NULL DEFAULT '',
  impact TEXT NOT NULL DEFAULT '', recommendation TEXT NOT NULL DEFAULT '', impact_cents INTEGER, impact_basis TEXT, evidence_json TEXT NOT NULL DEFAULT '[]',
  owner TEXT NOT NULL DEFAULT '', priority INTEGER NOT NULL DEFAULT 2, due_date TEXT, status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('suggested','open','in_progress','done','dismissed')),
  client_visible INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'advisor', source_key TEXT, scenario_id TEXT, history_json TEXT NOT NULL DEFAULT '[]',
  created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);

-- Owner / shareholder market-based wage plans (one per client per year). Feeds the owner-pay adjustment.
CREATE TABLE IF NOT EXISTS owner_wage_plans (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), year INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved')),
  input_json TEXT NOT NULL, result_json TEXT NOT NULL, applied_from TEXT, applied_to TEXT, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL, approved_by TEXT, approved_at TEXT, UNIQUE (tenant_id, year));

-- Daily cash report: who paid and the bank balance after the day's deposit; optionally receivables aging and missed owner paychecks.
CREATE TABLE IF NOT EXISTS daily_cash (
  tenant_id TEXT NOT NULL REFERENCES tenants(id), date TEXT NOT NULL, cash_balance_cents INTEGER NOT NULL, deposits_json TEXT NOT NULL DEFAULT '[]',
  ar_aging_json TEXT, missed_owner_pay_cents INTEGER, entered_by TEXT, updated_at TEXT, PRIMARY KEY (tenant_id, date));

-- Client consent for SJATS staff to work with the client's bank information (daily cash now; a live bank feed when one is connected).
-- Only the client owner can grant or withdraw it. Every change is also written to the audit log.
CREATE TABLE IF NOT EXISTS bank_feed_consent (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id), allowed INTEGER NOT NULL DEFAULT 0, decided_by TEXT NOT NULL REFERENCES users(id), decided_at TEXT NOT NULL);

-- Per-client wording of the monthly email the firm sends with the statements packet. Staff only; never exposed to client roles.
CREATE TABLE IF NOT EXISTS comm_templates (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id), subject TEXT NOT NULL, body TEXT NOT NULL, updated_by TEXT REFERENCES users(id), updated_at TEXT NOT NULL);

-- Annual budget per client and fiscal year (fiscal_year is the first month, YYYY-MM). Figures are whole hundreds of dollars.
-- Once finalized a budget is a record of what was planned at the time: the triggers below refuse any later change or deletion.
CREATE TABLE IF NOT EXISTS budgets (
  tenant_id TEXT NOT NULL REFERENCES tenants(id), fiscal_year TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','final')), deadline TEXT NOT NULL,
  data_json TEXT NOT NULL, seeded_from_json TEXT, created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, updated_by TEXT REFERENCES users(id), updated_at TEXT NOT NULL,
  finalized_by TEXT REFERENCES users(id), finalized_at TEXT, PRIMARY KEY (tenant_id, fiscal_year));
CREATE TRIGGER IF NOT EXISTS budgets_final_no_update BEFORE UPDATE ON budgets WHEN OLD.status = 'final' BEGIN SELECT RAISE(ABORT, 'A finalized budget cannot be changed.'); END;
CREATE TRIGGER IF NOT EXISTS budgets_final_no_delete BEFORE DELETE ON budgets WHEN OLD.status = 'final' BEGIN SELECT RAISE(ABORT, 'A finalized budget cannot be deleted.'); END;
-- The running outlook: forecast assumptions the firm adjusts through the year. The budget never changes; this does.
CREATE TABLE IF NOT EXISTS forecast_outlook (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id), levers_json TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', updated_by TEXT REFERENCES users(id), updated_at TEXT NOT NULL);
