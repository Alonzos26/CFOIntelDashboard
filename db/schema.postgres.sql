-- PostgreSQL production target for CFO Intelligence.
-- STATUS: reference DDL. The application currently runs on the embedded SQLite schema (db/schema.sqlite.sql) through the
-- Db port in src/server/db.ts; a Postgres adapter for that port is the one piece of production wiring not yet written.
-- The table and column names are identical, so only types and the row-level-security layer differ.
--
-- Tenant isolation is enforced twice: (1) every query in the application filters on tenant_id after server-side
-- authorization, and (2) row-level security below makes the database refuse cross-tenant rows even if a query forgets.
-- The application connects as role cfo_app (no BYPASSRLS) and runs, per request, inside a transaction:
--     SET LOCAL app.tenant_id = '<authorized tenant uuid>';

CREATE ROLE cfo_app LOGIN NOINHERIT;  -- password / IAM auth configured outside this file

CREATE TABLE industries (id uuid PRIMARY KEY, name text NOT NULL UNIQUE, status text NOT NULL DEFAULT 'active');
CREATE TABLE tenants (id uuid PRIMARY KEY, name text NOT NULL, portal_client_id text UNIQUE, industry_id uuid REFERENCES industries(id),
  settings_json jsonb NOT NULL DEFAULT '{}', is_synthetic boolean NOT NULL DEFAULT false, status text NOT NULL DEFAULT 'active', created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE users (id uuid PRIMARY KEY, email citext NOT NULL UNIQUE, name text NOT NULL, password_hash text,
  staff_role text CHECK (staff_role IN ('super_admin','advisor','analyst')), active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE memberships (user_id uuid NOT NULL REFERENCES users(id), tenant_id uuid NOT NULL REFERENCES tenants(id),
  role text NOT NULL CHECK (role IN ('advisor','analyst','client_owner','client_manager','client_viewer')), PRIMARY KEY (user_id, tenant_id));
CREATE TABLE sessions (token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), pinned_tenant_id uuid REFERENCES tenants(id),
  via text NOT NULL, created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, revoked_at timestamptz);
CREATE TABLE launch_tokens_used (jti text PRIMARY KEY, expires_at timestamptz NOT NULL);
CREATE TABLE audit_log (id bigserial PRIMARY KEY, tenant_id uuid, user_id uuid, action text NOT NULL, entity text, entity_id text, detail_json jsonb, at timestamptz NOT NULL DEFAULT now());

CREATE TABLE accounts (id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), statement text NOT NULL CHECK (statement IN ('pnl','bs')),
  name text NOT NULL, line text, sign smallint NOT NULL DEFAULT 1, UNIQUE (tenant_id, statement, name));
CREATE TABLE import_batches (id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), statement text NOT NULL, filename text NOT NULL, sha256 text NOT NULL, sheet text,
  status text NOT NULL CHECK (status IN ('staged','committed','rolled_back')), period_from text, period_to text, row_count int NOT NULL DEFAULT 0,
  parse_issues_json jsonb NOT NULL DEFAULT '[]', created_by uuid NOT NULL, created_at timestamptz NOT NULL, committed_at timestamptz, rolled_back_at timestamptz,
  accounting_basis text NOT NULL DEFAULT 'unknown' CHECK (accounting_basis IN ('accrual','cash','unknown')));
CREATE TABLE facts (id bigserial PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), batch_id uuid NOT NULL REFERENCES import_batches(id), account_id uuid NOT NULL REFERENCES accounts(id),
  period text NOT NULL, amount_cents bigint NOT NULL, active boolean NOT NULL DEFAULT false, superseded_by uuid);
CREATE INDEX facts_tenant ON facts (tenant_id, active, period);
CREATE TABLE period_status (tenant_id uuid NOT NULL REFERENCES tenants(id), period text NOT NULL, status text NOT NULL CHECK (status IN ('preliminary','reconciled','approved')), updated_by uuid, updated_at timestamptz, PRIMARY KEY (tenant_id, period));
CREATE TABLE adjustments (id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), period text NOT NULL, kind text NOT NULL, amount_cents bigint NOT NULL, note text NOT NULL,
  created_by uuid NOT NULL, created_at timestamptz NOT NULL, reversed_by uuid, reversed_at timestamptz);
CREATE TABLE scorecards (id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), period text NOT NULL, status text NOT NULL CHECK (status IN ('draft','published')), snapshot_json jsonb NOT NULL,
  commentary_json jsonb NOT NULL DEFAULT '{}', internal_notes text NOT NULL DEFAULT '', engine_version text NOT NULL, published_by uuid, published_at timestamptz, updated_at timestamptz NOT NULL, UNIQUE (tenant_id, period));
CREATE TABLE weekly_entries (tenant_id uuid NOT NULL REFERENCES tenants(id), week_start date NOT NULL, revenue_cents bigint NOT NULL, cogs_cents bigint NOT NULL, direct_labor_cents bigint NOT NULL, other_labor_cents bigint,
  cash_balance_cents bigint, source text NOT NULL, entered_by uuid, updated_at timestamptz, PRIMARY KEY (tenant_id, week_start));
CREATE TABLE weekly_reports (id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), week_start date NOT NULL, status text NOT NULL CHECK (status IN ('draft','published')), snapshot_json jsonb NOT NULL,
  briefing_json jsonb NOT NULL, next_steps_json jsonb NOT NULL DEFAULT '[]', internal_notes text NOT NULL DEFAULT '', published_by uuid, published_at timestamptz, acknowledged_by uuid, acknowledged_at timestamptz, updated_at timestamptz NOT NULL, UNIQUE (tenant_id, week_start));
CREATE TABLE comments (id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), entity text NOT NULL, entity_id text NOT NULL, user_id uuid NOT NULL, body text NOT NULL,
  visibility text NOT NULL CHECK (visibility IN ('client','internal')), created_at timestamptz NOT NULL);
CREATE TABLE cash_items (id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), name text NOT NULL, direction text NOT NULL CHECK (direction IN ('in','out')), category text NOT NULL,
  amount_cents bigint NOT NULL, cadence text NOT NULL, anchor_date date NOT NULL, end_date date, second_day smallint, active boolean NOT NULL DEFAULT true);
CREATE TABLE scenarios (id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), type text NOT NULL, name text NOT NULL, inputs_json jsonb NOT NULL, result_json jsonb, baseline_period text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','shared','approval_requested','approved','declined')), engine_version text, created_by uuid NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL);
CREATE TABLE kpi_definitions (id uuid PRIMARY KEY, industry_id uuid NOT NULL REFERENCES industries(id), key text NOT NULL, name text NOT NULL, formula text NOT NULL, unit text NOT NULL,
  basis text NOT NULL DEFAULT 'month', frequency text NOT NULL DEFAULT 'monthly', direction text NOT NULL DEFAULT 'higher', default_target double precision, alert_threshold double precision,
  description text NOT NULL DEFAULT '', recommended_action text NOT NULL DEFAULT '', data_source text NOT NULL DEFAULT '', benchmark_source text, client_visible boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'active', updated_by uuid, updated_at timestamptz NOT NULL, UNIQUE (industry_id, key));
CREATE TABLE tenant_kpis (tenant_id uuid NOT NULL REFERENCES tenants(id), kpi_id uuid NOT NULL REFERENCES kpi_definitions(id), target double precision, alert_threshold double precision, client_visible boolean NOT NULL DEFAULT true, PRIMARY KEY (tenant_id, kpi_id));
CREATE TABLE kpi_inputs (tenant_id uuid NOT NULL REFERENCES tenants(id), key text NOT NULL, period text NOT NULL, value double precision NOT NULL, entered_by uuid, updated_at timestamptz, PRIMARY KEY (tenant_id, key, period));
CREATE TABLE actions (id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), title text NOT NULL, kpi text, observation text NOT NULL DEFAULT '', cause text NOT NULL DEFAULT '', impact text NOT NULL DEFAULT '',
  recommendation text NOT NULL DEFAULT '', impact_cents bigint, impact_basis text, evidence_json jsonb NOT NULL DEFAULT '[]', owner text NOT NULL DEFAULT '', priority smallint NOT NULL DEFAULT 2, due_date date,
  status text NOT NULL DEFAULT 'open', client_visible boolean NOT NULL DEFAULT false, source text NOT NULL DEFAULT 'advisor', source_key text, scenario_id uuid, history_json jsonb NOT NULL DEFAULT '[]',
  created_by uuid NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL);

CREATE TABLE owner_wage_plans (id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), year int NOT NULL, status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved')),
  input_json jsonb NOT NULL, result_json jsonb NOT NULL, applied_from text, applied_to text, updated_by uuid NOT NULL, updated_at timestamptz NOT NULL, approved_by uuid, approved_at timestamptz, UNIQUE (tenant_id, year));

CREATE TABLE daily_cash (tenant_id uuid NOT NULL REFERENCES tenants(id), date date NOT NULL, cash_balance_cents bigint NOT NULL, deposits_json jsonb NOT NULL DEFAULT '[]',
  ar_aging_json jsonb, missed_owner_pay_cents bigint, entered_by uuid, updated_at timestamptz, PRIMARY KEY (tenant_id, date));

CREATE TABLE bank_feed_consent (tenant_id uuid PRIMARY KEY REFERENCES tenants(id), allowed boolean NOT NULL DEFAULT false, decided_by uuid NOT NULL REFERENCES users(id), decided_at timestamptz NOT NULL);

CREATE TABLE comm_templates (tenant_id uuid PRIMARY KEY REFERENCES tenants(id), subject text NOT NULL, body text NOT NULL, updated_by uuid REFERENCES users(id), updated_at timestamptz NOT NULL);

-- Row-level security on every tenant-owned table.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['accounts','import_batches','facts','period_status','adjustments','scorecards','weekly_entries','weekly_reports','comments','cash_items','scenarios','tenant_kpis','kpi_inputs','actions','owner_wage_plans','daily_cash','bank_feed_consent','comm_templates']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid)$p$, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO cfo_app', t);
  END LOOP;
END $$;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_tenant ON audit_log USING (tenant_id IS NULL OR tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT ON audit_log TO cfo_app;  -- append-only: no UPDATE or DELETE
GRANT SELECT, INSERT, UPDATE ON tenants, users, memberships, sessions, launch_tokens_used, industries, kpi_definitions TO cfo_app;
