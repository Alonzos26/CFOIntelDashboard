# CFO Intelligence

A multi-tenant Fractional CFO dashboard and decision platform for SJ Advisory & Tax. Advisors import a client's statements, map them once to a standard management P&L, approve the periods, and publish; clients open one screen and see where they stand, what changed, and what to do next.

This repository is the **Phase 1 MVP**. Read `docs/SOURCE_MAPPING.md` (what came from the workbooks, conflicts, corrections) and `docs/ARCHITECTURE.md` (structure, security, embedding).

## Run it

Requires Node.js 22.18 or newer. No database server needed for local use.

```bash
npm install            # react, react-dom, esbuild, typescript and type packages
npm run demo           # builds the client, seeds synthetic demo data, serves http://localhost:4300
npm test               # 46 tests: engine vs. workbook values, and the six acceptance workflows over HTTP
```

Demo accounts (password for all: `demo-CFO-2026!`, override with `SEED_PASSWORD`). All demo data is synthetic and labelled as such on every screen.

| Sign in as | Role | Sees |
|---|---|---|
| `advisor@sjats.demo` | SJATS CFO advisor | Cedar Ridge Builders, Lakeside Auto Repair |
| `analyst@sjats.demo` | SJATS analyst (cannot approve or publish) | same |
| `advisor2@sjats.demo` | SJATS CFO advisor | Harbor Family Dental only |
| `admin@sjats.demo` | Super admin | all clients |
| `owner@cedarridge.demo` / `manager@…` / `viewer@…` | Client owner / manager / read-only | Cedar Ridge only |
| `owner@harbordental.demo`, `owner@lakesideauto.demo` | Client owner | their own client only |

Embedded-portal example (second terminal):

```bash
PORTAL_SSO_SECRET=dev-only-secret-dev-only-secret-0001 EMBED_ALLOWED_ORIGINS=http://localhost:4400 SEED_DEMO=1 npm start
PORTAL_SSO_SECRET=dev-only-secret-dev-only-secret-0001 npm run portal-example    # http://localhost:4400 → Advisory
```

## The six acceptance workflows

Each is automated in `tests/server.test.ts` and can be walked by hand:

1. **Import → map → approve → publish.** As the advisor, open *Lakeside Auto Repair → Data Sources & Mappings*, upload `examples/imports/lakeside-pnl-2025-2026.csv` (then the balance sheet), fill and save mappings, commit; approve the periods in *Review & Approval*; publish in *Scorecard*.
2. **Client sees only their own approved information.** Sign in as `owner@cedarridge.demo`, or use the portal example. The latest month is deliberately left unapproved, so the client sees the prior month while the advisor sees both.
3. **Hiring scenario.** *Decision Lab → New hiring scenario*; change salary and expected revenue and watch profit, cash and labor efficiency move; save, duplicate, compare, request approval.
4. **Weekly report.** As the advisor: *Weekly Pulse → Draft report* for the latest week, edit, add next steps, publish. The client can then read, comment and acknowledge.
5. **New industry KPI without code.** *KPI Library → New KPI*, enter a formula such as `warranty_cost / revenue`, assign it on the client's *Industry KPIs* page, enter the input.
6. **Flawed import is stopped.** Upload `examples/imports/lakeside-pnl-WITH-ERRORS.csv`: a `#REF!` cell, a skipped month and a net-income line that no longer reconciles are each reported, and commit is blocked.

## What is built, and what is not

| Area | Phase 1 status |
|---|---|
| Authentication, sessions, six roles, tenant isolation, audit log | Built and tested |
| Portal single sign-on and embedding | Built and tested; shared-secret tokens (move to JWKS for production) |
| Excel/CSV import, mapping, validation, history, rollback | Built and tested (monthly P&L and balance sheet in "accounts × months" layout) |
| Management P&L, LERs, salary cap, owner-pay normalization, rolling 12, comparisons | Built and tested against workbook values |
| Sweat equity ledger (owner underpay less shareholder distributions) and monthly / YTD / rolling-12 salary cap tracking | Built and tested |
| Owner market-based wage plan (roles × hours × market wage, or comparable position), approval, and one-step apply to the owner-pay adjustment | Built and tested; no wage data is bundled |
| Four forces of cash flow (taxes → debt → core capital → distributions), "where did the cash go", tax set-aside tracking | Built and tested |
| Capital and return on investment (equity, debt shown beside capital, sweat equity), sweat-equity difference between owners, ownership buy-in illustration | Built and tested |
| Daily cash report (who paid, bank balance, receivables aging, missed owner pay) and two-week cash flow forecast report with line-of-credit availability | Built and tested; figures are hand-entered until an accounting integration exists |
| Client consent for SJATS access to bank information: the client enters daily cash; staff may enter it only while the client owner allows access; only the client owner can grant or withdraw | Built and tested. The live bank feed itself is not built |
| Rolling-twelve P&L (pretax target, above/below, salary cap, labor efficiency now and needed, stretch target), salary cap chart, operating-expense category checks | Built and tested |
| Weekly sales and productivity report (all-labor efficiency by week, month to date, year to date; payroll the week's gross profit supports) | Built and tested; needs office and management payroll entered weekly |
| Monthly reports due-by day (default the 5th) with late/overdue notice; bill-pay day for the cash forecast | Built and tested |
| Client Communications (firm staff only): per-client email template with merge fields, monthly email draft, statements packet as a PDF, draft email file with the PDF attached, meeting script | Built and tested. The app does not send email; staff send the draft from their own mail program |
| Rolling three beside the rolling twelve: direction per measure with a same-months-last-year check for seasonality; shown on the Rolling 12 & 3 tab, as a marker on the scorecard, and in the email highlights and meeting script when direction changes | Built and tested. Grades and targets stay on twelve months |
| What-if forecast: eight plain-language levers, a thin P&L, the road from profit to cash, fiscal-year landing, comparison with changing nothing; clients run and save their own | Built and tested against the book's Exhibit 10.1 |
| Tax implications line on the scorecard (advisor grade and comment) | Built and tested |
| Economic value: three years of true pretax profit plus equity, fundability of a partial or full purchase, rule-of-thumb comparisons, five elements of value | Built and tested; a management estimate, not an appraisal |
| Valuation detail: marketability and control discounts, five-year buyout note test (±10%), years to repay a whole purchase, minority-owner values, implied multiples | Built and tested against the book's exhibits |
| Value and distributions at different pretax profit levels over five years | Built and tested against the book's exhibits; an illustration, not a forecast |
| Drill-down from a rolling-twelve P&L line to the imported accounts behind it | Built and tested (accounts tie to the line) |
| Cash-basis / accrual-basis flag on each import, with a notice on Profit & Performance | Built and tested |
| Scorecard with configurable targets, grades, advisor commentary, publish | Built |
| Executive overview with 8 KPI cards, drill-downs, top-3 priorities | Built (Budget / Forecast selector options are placeholders) |
| Balance sheet, indirect cash flow with reconciliation difference, DSO, core capital | Built |
| Weekly Pulse and weekly briefing workflow | Built (weekly figures are entered by hand) |
| 13-week cash forecast, cash rhythms, what-ifs | Built |
| Decision Lab: hiring scenarios, contractor vs employee, comparison | Built |
| Profit Planner | Profit-needs calculator and gap analysis built; guided wizard, Min/Target/Stretch, seasonality are Phase 2 |
| Industry KPI library with formula engine | Built (13 industry packs, 105 KPIs in `db/kpi-library.json`, synced at startup; see `docs/KPI_LIBRARY.md`; no benchmark defaults) |
| Insight drafting with advisor review; action register | Built (rule-based; no language model) |
| Pricing, growth, financing and new-location scenarios; three-statement **forecast** | Phase 2 — not built |
| "Ask Your CFO Data" assistant | Phase 3 — not built |
| Accounting / payroll / bank integrations, email delivery, server-side PDF | Not built; PDF is via the browser's print dialog |
| PostgreSQL adapter | Schema written (`db/schema.postgres.sql`); adapter not written — runs on SQLite |

Not verified in this build: `npm run typecheck` (the type packages could not be installed where this was built; the code runs under Node's type stripping and is bundled by esbuild, neither of which type-checks), and behaviour under concurrent load.

## Deployment

1. Set the variables in `.env.example` through your host's secret manager. `NODE_ENV=production` disables demo seeding and requires secure cookies.
2. `npm ci && npm run build && npm start` behind a TLS-terminating proxy. Persist `DB_PATH` on an encrypted volume and back it up.
3. For the portal, follow *Embedding* in `docs/ARCHITECTURE.md`.
4. Before onboarding real clients: write the PostgreSQL adapter (or accept single-instance SQLite for a pilot), switch launch tokens to asymmetric keys, add edge rate limiting, and have the payroll-tax defaults in `src/engine/hiring.ts` reviewed.

Never commit client workbooks, exports, tokens or `.env` — `.gitignore` excludes them.
