# KPI library

Industry KPI packs shipped with the app (`db/kpi-library.json`). Each KPI is a formula over the client's management P&L and balance sheet plus, where needed, operational inputs entered per period (job counts, hours, leads, units). Formulas are parsed and validated — never executed as code.

## Adding an industry or KPI later

Two ways, neither needs a code change:

1. **In the app:** KPI Library → add an industry → New KPI. Type a formula; the app shows which values come from the financials and which become inputs.
2. **In the data file:** add a block to `db/kpi-library.json`. On the next start the app adds the new industry and KPIs. It never overwrites or deletes a definition that already exists, so edits made in the app are safe. An invalid formula stops startup with a message naming the pack.

Then, on a client's Industry KPIs page, use **Apply an industry KPI pack**. A client can carry several packs.

## Targets and benchmarks

No KPI ships with a default target. Where a source guide quotes a range, it is stored as a reference note shown to advisors only, labelled as a vendor guide, undated and not independently verified. Set each client's targets yourself; if you adopt an industry benchmark, record its source and date in the KPI's benchmark field.

## Values available in formulas

P&L: `revenue`, `cogs`, `gross_profit`, `direct_labor`, `contribution_margin`, `mgmt_labor`, `total_labor`, `facilities`, `marketing`, `payroll_taxes_benefits`, `other_opex`, `operating_expenses`, `operating_income`, `pretax_profit`, `adjusted_pretax_profit`, `interest_expense`, `depreciation`, `ebitda`. Balance sheet (period end; N/A without an imported balance sheet): `cash`, `accounts_receivable`, `accounts_payable`, `current_assets`, `current_liabilities`, `total_assets`, `total_liabilities`, `line_of_credit`, `notes_payable`, `equity`. Also `period_days`. Any other name is an operational input.

Operational inputs are summed across a rolling-12 window, so point-in-time inputs (inventory value, memberships, units managed) are used in monthly KPIs.

## Packs

### Construction

Sources: Guide: Contractor Budget (Contractor Quick Tools); Brief (starter KPIs).

| KPI | Formula | Better when | Basis |
|---|---|---|---|
| Gross profit per job | `gross_profit / jobs_completed` | higher | month |
| Revenue per field labor hour | `revenue / field_hours` | higher | month |
| Change orders as % of revenue | `change_order_revenue / revenue` | higher | month |
| Backlog (months of revenue) | `backlog / revenue` | higher | month |
| Actual vs estimated job cost | `actual_job_cost / estimated_job_cost` | lower | month |
| Variable (job) expenses as % of revenue | `(cogs + direct_labor) / revenue` | lower | month |
| Fixed (overhead) expenses as % of revenue | `operating_expenses / revenue` | lower | month |
| Net profit margin | `pretax_profit / revenue` | higher | month |
| Retainage as % of receivables | `retainage_receivable / accounts_receivable` | lower | month |

### Home Services — HVAC, Plumbing & Electrical

Sources: Sera: 4 Metrics That Matter Most to Your HVAC Business; 7 Financial Strategies for Plumbing Companies; 7 Financial Strategies for Electrical Contractors; Systems Blueprint by Profitable Tradie.

| KPI | Formula | Better when | Basis |
|---|---|---|---|
| Memberships vs target | `active_memberships / target_memberships` | higher | month |
| Memberships per $1M of annual revenue | `active_memberships / (revenue * 12 / 1000000)` | higher | month |
| Technician efficiency (labor utilization) | `billed_hours / paid_tech_hours` | higher | month |
| Average ticket | `revenue / jobs_completed` | higher | month |
| Revenue per technician | `revenue / technicians` | higher | month |
| Callback rate | `callbacks / jobs_completed` | lower | month |
| Lead-to-booked-job conversion | `jobs_booked / leads` | higher | month |
| Gross margin on jobs | `contribution_margin / revenue` | higher | month |
| Materials as % of revenue | `cogs / revenue` | lower | month |
| EBITDA margin | `ebitda / revenue` | higher | month |
| Net profit margin | `pretax_profit / revenue` | higher | month |
| Accounts receivable days | `accounts_receivable / revenue * period_days` | lower | rolling 12 |

### Roofing & Exteriors

Sources: Master Roofing Owners Guide.

| KPI | Formula | Better when | Basis |
|---|---|---|---|
| Close rate | `jobs_sold / estimates_given` | higher | month |
| Average ticket | `revenue / jobs_completed` | higher | month |
| Average job margin | `gross_profit / revenue` | higher | month |
| Lead-to-estimate rate | `estimates_given / leads` | higher | month |
| Cost per lead | `marketing / leads` | lower | month |
| Marketing as % of revenue | `marketing / revenue` | lower | month |
| Revenue per crew | `revenue / crews` | higher | month |
| Sales goal attainment | `revenue / monthly_revenue_goal` | higher | month |

### Legal

Sources: Law Firm Profit Leaks; Building Your All-Star Team: A Hiring Pipeline Blueprint for Law Firms (Crisp); Brief (starter KPIs).

| KPI | Formula | Better when | Basis |
|---|---|---|---|
| Billable utilization | `billable_hours / available_hours` | higher | month |
| Billed hours vs target | `billable_hours / billable_hour_target` | higher | month |
| Realization rate | `billed_amount / standard_value` | higher | month |
| Collection rate | `collected_amount / billed_amount` | higher | month |
| Accounts receivable days | `accounts_receivable / revenue * period_days` | lower | rolling 12 |
| Revenue per professional | `revenue / professionals` | higher | month |
| Cost per lead | `marketing / leads` | lower | month |
| Cost to acquire a client | `marketing / new_clients` | lower | month |
| Payroll as % of revenue | `(total_labor + payroll_taxes_benefits) / revenue` | lower | month |
| Marketing as % of revenue | `marketing / revenue` | lower | month |
| Overhead as % of revenue | `(facilities + other_opex) / revenue` | lower | month |
| Net profit margin | `pretax_profit / revenue` | higher | month |
| Team turnover | `departures / average_headcount` | lower | rolling 12 |
| Average days to fill a role | `total_days_open / hires` | lower | rolling 12 |

### Manufacturing

Sources: Brief (starter KPIs).

| KPI | Formula | Better when | Basis |
|---|---|---|---|
| Scrap and rework rate | `scrap_cost / cogs` | lower | month |
| Capacity utilization | `machine_hours_used / machine_hours_available` | higher | month |
| Throughput per machine hour | `units_produced / machine_hours_used` | higher | month |
| Days in inventory | `inventory / cogs * period_days` | lower | month |

### Medical & Med Spas

Sources: Med Spas Operations Profitability Playbook; Brief (starter KPIs).

| KPI | Formula | Better when | Basis |
|---|---|---|---|
| Revenue per available provider hour (RevPAH) | `revenue / available_hours` | higher | month |
| Client lifetime value | `cohort_revenue / cohort_clients` | higher | month |
| Treatment plan completion rate | `completed_plans / recommended_plans` | higher | month |
| Cost per new client | `marketing / new_clients` | lower | month |
| Consultation-to-treatment conversion | `treatments_booked / consultations` | higher | month |
| Membership revenue share | `membership_revenue / revenue` | higher | month |
| Revenue per provider | `revenue / providers` | higher | month |
| Provider utilization | `booked_hours / available_hours` | higher | month |
| Average transaction value | `revenue / visits` | higher | month |
| Rebooking rate | `rebooked_visits / visits` | higher | month |
| Staffing as % of revenue | `(total_labor + payroll_taxes_benefits) / revenue` | lower | month |

### Optometry & Eye Care

Sources: Mining for Hidden Cash: The Hidden Cash Map for Independent Optometrists (Prowise).

| KPI | Formula | Better when | Basis |
|---|---|---|---|
| Sales to assets | `revenue / total_assets` | higher | rolling 12 |
| Gross profit margin | `gross_profit / revenue` | higher | month |
| Net profit margin | `pretax_profit / revenue` | higher | month |
| Days in inventory | `inventory / cogs * period_days` | lower | month |
| Accounts receivable days | `accounts_receivable / revenue * period_days` | lower | rolling 12 |
| Accounts payable days | `accounts_payable / cogs * period_days` | higher | rolling 12 |
| Cash gap (days) | `inventory / cogs * period_days + accounts_receivable / revenue * period_days - accounts_payable / cogs * period_days` | lower | month |
| Revenue per exam | `revenue / exams` | higher | month |

### Property Management

Sources: 7 Portfolio Multipliers for Property Management (image-only PDF, read by OCR).

| KPI | Formula | Better when | Basis |
|---|---|---|---|
| Revenue per unit managed | `revenue / units_managed` | higher | month |
| Management contract retention | `(owners_at_start - owners_lost) / owners_at_start` | higher | rolling 12 |
| Owner lead conversion | `new_contracts / owner_leads` | higher | month |
| Ancillary revenue share | `ancillary_revenue / revenue` | higher | month |
| Units per employee | `units_managed / employees` | higher | month |
| Net profit margin | `pretax_profit / revenue` | higher | month |
| Reinvestment rate | `reinvestment_spend / pretax_profit` | higher | rolling 12 |
| Portfolio occupancy | `occupied_units / units_managed` | higher | month |
| Rent delinquency | `delinquent_rent / rent_billed` | lower | month |

### Real Estate

Sources: Brief (starter KPIs).

| KPI | Formula | Better when | Basis |
|---|---|---|---|
| Occupancy | `occupied_units / total_units` | higher | month |
| Rent collection rate | `rent_collected / rent_billed` | higher | month |
| Net operating income margin | `operating_income / revenue` | higher | month |
| Debt service coverage ratio | `(operating_income + depreciation) / debt_service` | higher | month |
| Capital reserve funding | `capital_reserve_contribution / revenue` | higher | month |

### Restaurant & Food

Sources: Mastering Restaurant Accounting; The Build Your Restaurant Launch Field Guide; Brief (starter KPIs).

| KPI | Formula | Better when | Basis |
|---|---|---|---|
| Food cost % | `cogs / revenue` | lower | month |
| Labor cost % | `total_labor / revenue` | lower | month |
| Prime cost % | `(cogs + total_labor) / revenue` | lower | month |
| Gross profit after prime cost | `(gross_profit - total_labor) / revenue` | higher | month |
| Average check | `revenue / covers` | higher | month |
| Table turnover (turns per seat per day) | `covers / (seats * service_days)` | higher | month |
| Sales per labor hour | `revenue / labor_hours` | higher | month |
| Operating expense ratio | `operating_expenses / revenue` | lower | month |
| Contribution margin ratio | `contribution_margin / revenue` | higher | month |
| Break-even revenue | `operating_expenses / (contribution_margin / revenue)` | lower | month |
| Inventory turnover | `cogs / average_inventory` | higher | month |
| Waste as % of food cost | `waste_cost / cogs` | lower | month |
| Current ratio | `current_assets / current_liabilities` | higher | month |
| Debt service coverage ratio | `(operating_income + depreciation) / debt_service` | higher | month |

### Professional Services

Sources: Brief.

| KPI | Formula | Better when | Basis |
|---|---|---|---|
| Revenue per employee | `revenue / employees` | higher | month |
| Billable utilization | `billable_hours / available_hours` | higher | month |
| Accounts receivable days | `accounts_receivable / revenue * period_days` | lower | rolling 12 |

### Automotive Services

Sources: Brief.

| KPI | Formula | Better when | Basis |
|---|---|---|---|
| Average repair order | `revenue / repair_orders` | higher | month |
| Effective labor rate | `labor_sales / billed_hours` | higher | month |
| Technician efficiency | `billed_hours / clocked_hours` | higher | month |
| Parts gross margin | `(parts_sales - parts_cost) / parts_sales` | higher | month |

### Nonprofit Organizations

Sources: Brief.

| KPI | Formula | Better when | Basis |
|---|---|---|---|
| Program expense ratio | `program_expenses / total_expenses` | higher | month |
| Cost to raise a dollar | `fundraising_cost / contributions` | lower | month |
| Operating runway (months) | `unrestricted_cash / (total_expenses / 12)` | higher | rolling 12 |
| Largest funder share | `largest_funder_amount / contributions` | lower | rolling 12 |

## Guides that did not yield KPIs

*7 Legal Tax Loopholes for HVAC Business Owners* and *5 Tax Strategies for Real Estate Investors* describe tax strategies, not performance measures, so nothing from them is in the library. The Crisp law-firm hiring guide is about recruiting process; two people measures (team turnover, days to fill a role) were derived from its themes rather than quoted from it.
