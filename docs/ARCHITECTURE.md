# Architecture

## Shape

```
src/engine/    Pure calculation engine. No I/O. Same code runs on the server and in the browser.
  core.ts        management P&L, LERs, salary cap, rolling windows, DSO, core capital, cash-flow reconciliation
  scorecard.ts   seven-measure scorecard and grading
  forecast.ts    driver-based monthly forecast
  hiring.ts      cost of hire, break-even, ramp, cash and guardrail
  cash.ts        cash rhythms and the 13-week forecast
  weekly.ts      weekly GM / LER tracking and briefing draft
  kpi.ts         safe KPI formula parser and evaluator
  insights.ts    Observation → Cause → Impact → Action rules
  profitplan.ts  profit needs and gap analysis
src/server/    HTTP API (Node built-ins only)
  app.ts         routing, sessions, server-side tenant authorization, CSRF, CSP
  auth.ts        password hashing, sessions, portal token exchange, role permissions
  routes.ts      endpoints, input validation, audit logging
  services.ts    read models (dashboard, financials, scorecard, cash, weekly, KPIs, portfolio)
  importer.ts    preview → stage → map → validate → commit → rollback
  xlsx.ts        dependency-free .xlsx / .csv readers
  db.ts          data-access port (SQLite today; see below)
  seed.ts, synthetic.ts   KPI library and synthetic demo clients
src/client/    React single-page app; charts are hand-written SVG
db/            schema.sqlite.sql (in use) and schema.postgres.sql (production target with row-level security)
examples/      portal-host (embedding example), imports (synthetic statements, good and flawed)
tests/         engine tests against workbook values; end-to-end API tests of the six acceptance workflows
```

The ten separations asked for map to: UI (`src/client`), calculations (`src/engine`), actuals (`facts`, `accounts`, `import_batches`), forecast assumptions (`forecast.ts` drivers, tenant settings), scenario data (`scenarios`), KPI definitions (`kpi_definitions`), industry configuration (`industries`, `tenant_kpis`), permissions (`auth.ts`), integration adapters (`importer.ts` readers), reporting (`weekly_reports`, `scorecards` snapshots). No financial formula lives in a React component; components call the engine.

## Decisions and why

**Stack.** The brief suggested Next.js, Tailwind, Recharts and PostgreSQL where nothing else constrains. The build environment had no package-registry access, so Phase 1 uses what needs no installation: TypeScript run directly by Node 22, `node:http`, `node:sqlite`, React, esbuild, hand-written CSS and SVG charts. Runtime dependencies are React and React-DOM only. Moving to Next.js later is a UI-shell change; the engine and API are unaffected.

**Database.** SQLite through a five-method `Db` class. `db/schema.postgres.sql` is the production schema with the same tables plus row-level security. **A PostgreSQL implementation of `Db` is not written yet** — that is the main item between this build and a production deployment with multiple application servers. SQLite in WAL mode is adequate for a single-instance pilot.

**Money.** Integer cents everywhere (database, engine, API). Ratios are floats, computed from cent totals and rounded only for display. Grading uses a 1e-9 tolerance so on-threshold results are not lost to floating point.

**Tenant isolation, in layers.**
1. Tenant routes are `/api/t/:tid/...`. Before any handler runs, `Auth.access` checks the session's user against `memberships` (or super-admin) — never a client-supplied claim. No access and no such tenant both return 404.
2. Every SQL statement filters on `tenant_id`, including lookups by object id, so an id from another tenant is not found.
3. Portal-launched sessions are pinned to one tenant, even for staff.
4. Production adds PostgreSQL row-level security (`SET LOCAL app.tenant_id`).
5. Tests request every route of another tenant, cross-tenant object ids, exports and writes.

**What clients can see.** Only advisor-approved periods (the unbroken approved run), only published scorecards and weekly reports (frozen JSON snapshots), only client-visible comments and actions. Internal notes are omitted server-side. Insights are drafted from approved periods only.

**Data integrity.** Facts are never edited: a new import supersedes rows, a rollback restores them. Changing a mapping or re-importing returns affected periods to "preliminary". Owner-pay adjustments are separate rows with a required note and a reversal marker. Every write goes to `audit_log`. Stored scenario results carry the engine version. Data is labelled imported / operational estimate / calculated / forecast and is never called live.

**Scenarios.** The browser previews with the engine for instant feedback; on save the server recomputes from the stored inputs and stores that result. Scenarios read the forecast baseline and cannot write to `facts` (tested).

**KPI formulas.** Parsed to an AST; only numbers, identifiers, `+ − * /`, parentheses and `min/max/abs/round`. Unknown identifiers become per-period operational inputs. No `eval`. A test feeds it code-injection strings; that test found and fixed an inherited-property lookup (`constructor`) during development.

## Security controls

| Control | Implementation |
|---|---|
| Passwords | scrypt with per-user salt; 5 failures → 15-minute lockout |
| Sessions | 256-bit random tokens, stored as SHA-256; expiry; revocation on logout and when access is removed |
| Cookies | `HttpOnly`, `SameSite=Lax`, `Secure` in production |
| CSRF | State-changing cookie requests need `X-Requested-With: cfo` and a same-origin `Origin` |
| Embedding | `Content-Security-Policy: frame-ancestors 'self' <EMBED_ALLOWED_ORIGINS>`; scripts `'self'` only |
| Portal sign-on | HS256 launch token: issuer, audience, ≤120 s lifetime, single use (`jti`), user and client verified against our own records |
| Uploads | Size cap, zip-bomb guard, formulas never executed, only cached values read |
| Secrets | Environment only; `.env` and workbooks are git-ignored |
| Encryption | In transit: terminate TLS at the load balancer (HSTS sent in production). At rest: use encrypted volumes / managed-database encryption — not handled in application code. |

Known gaps before production: PostgreSQL adapter; asymmetric (JWKS) launch tokens instead of a shared secret; rate limiting at the edge; background jobs (imports run in-request); email notifications; server-side PDF rendering (reports print to PDF from the browser today).

## Embedding in the SJATS Client Portal

Route: `Client Portal → Advisory → CFO Dashboard`. See `examples/portal-host/server.ts` for a runnable example.

1. Serve this app same-site with the portal (for example `cfo.sjats.com` beside `portal.sjats.com`) and list the portal origin in `EMBED_ALLOWED_ORIGINS`.
2. When a signed-in portal user opens the page, the **portal backend** signs a launch token: `{ iss: PORTAL_ISSUER, aud: "sjats-cfo", sub: <user email>, client: <portal client id>, iat, exp: iat+60, jti: <uuid> }`, HS256 with `PORTAL_SSO_SECRET`.
3. The portal renders `<iframe src="https://cfo.sjats.com/embed#token=...">`. The token is in the URL fragment, so it is not sent to servers, proxies or logs.
4. The app posts the token to `/api/auth/exchange`, receives a session pinned to that client, and removes the fragment. The session token is held in memory and sent as a bearer header, so nothing depends on third-party cookies.
5. The user must already exist here with access to that client (Client Settings → People with access); the token proves identity, our records decide authorization.

The same build runs standalone at its own URL with the sign-in page.

## Integrations

`importer.readSheets` is the adapter seam: anything that can produce "accounts × months" rows feeds the same stage → map → validate → commit pipeline. Implemented: Excel and CSV. Not implemented (need credentials and development): QuickBooks Online, Kick, ADP, Stripe, POS, bank feeds. QuickBooks Desktop works through its Excel/CSV exports.

## Bank information and client consent

Daily cash is the client's own bank information, so the default is that the client enters it (`daily_cash` permission: client owner and client manager). SJATS staff can read it, because the cash forecast depends on it, but `PUT /api/t/:tid/daily-cash` refuses staff unless the client owner has allowed access (`bank_feed_consent` table). Only a user whose role on that tenant is `client_owner` can call `PUT /api/t/:tid/bank-feed-consent`; staff, including super admins, cannot grant it to themselves. Each grant and withdrawal is written to the audit log, and consent is per tenant.

A live bank feed is not implemented. When one is added, the sync job must check `bank_feed_consent.allowed` for the tenant before every run and stop when it is withdrawn; provider tokens belong in the secret store, never in this database or the repository.

## Client communications (firm staff only)

`/api/t/:tid/comms*` requires the `view_internal` permission, which no client role has, and the page is not in the client navigation. Everything is built by `src/server/comms.ts` from **approved months only**, so a packet can never carry figures a reviewer has not signed off.

- **Email template:** one per client (`comm_templates`), falling back to the firm default in `src/engine/comms.ts`. Merge fields are validated on save; an unknown field is refused.
- **Statements packet:** `packetPdf` writes the PDF with the small built-in writer in `src/server/pdf.ts` (US Letter, Helvetica, no dependencies). Every page is marked unaudited, and synthetic clients are marked as demo data.
- **Draft email:** `POST /comms/email.eml` returns an unsent RFC 822 message (`X-Unsent: 1`) with the packet attached. The application has no mail server and sends nothing; the advisor opens the draft, checks it and sends it from their own mailbox. Recipient addresses are validated and cannot carry extra headers.
- **Meeting script:** `meetingScript` turns the same scorecard, insights, cash position and open actions into talking points with questions and private notes. A dollar impact is spoken only where an insight carries a calculated one.
- Generating a packet or a draft is written to the audit log. To send automatically later, add a mail provider behind the same data and keep the approval gate.
