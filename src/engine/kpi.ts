// Safe KPI formula engine. Formulas are parsed into an AST and evaluated against named values.
// There is no eval, no property access, no function definitions: only numbers, identifiers, + − * / ( ) and a fixed function list.
import { type BsLines, type PnlResult } from './core.ts';

type Node = { t: 'num'; v: number } | { t: 'var'; name: string } | { t: 'bin'; op: string; l: Node; r: Node } | { t: 'neg'; e: Node } | { t: 'call'; fn: string; args: Node[] };

const FUNCTIONS: Record<string, { arity: [number, number]; fn: (...a: number[]) => number }> = {
  min: { arity: [2, 8], fn: Math.min }, max: { arity: [2, 8], fn: Math.max }, abs: { arity: [1, 1], fn: Math.abs },
  round: { arity: [1, 2], fn: (x, d = 0) => Math.round(x * 10 ** d) / 10 ** d },
};
const MAX_LEN = 500;

export class FormulaError extends Error {}

function tokenize(src: string): string[] {
  if (src.length > MAX_LEN) throw new FormulaError(`Formula is longer than ${MAX_LEN} characters.`);
  const out: string[] = []; const re = /\s*(?:(\d+(?:\.\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|([-+*/(),]))/y;
  let pos = 0;
  while (pos < src.length) {
    if (/^\s*$/.test(src.slice(pos))) break;
    re.lastIndex = pos; const m = re.exec(src);
    if (!m) throw new FormulaError(`Unexpected character "${src.slice(pos).trim()[0]}" at position ${pos + 1}.`);
    out.push(m[1] ?? m[2] ?? m[3]); pos = re.lastIndex;
  }
  if (!out.length) throw new FormulaError('Formula is empty.');
  return out;
}

export function parseFormula(src: string): Node {
  const tk = tokenize(src); let i = 0; let depth = 0;
  const peek = () => tk[i]; const next = () => tk[i++];
  function expr(): Node { let l = term(); while (peek() === '+' || peek() === '-') { const op = next(); l = { t: 'bin', op, l, r: term() }; } return l; }
  function term(): Node { let l = unary(); while (peek() === '*' || peek() === '/') { const op = next(); l = { t: 'bin', op, l, r: unary() }; } return l; }
  function unary(): Node { if (peek() === '-') { next(); return { t: 'neg', e: unary() }; } return atom(); }
  function atom(): Node {
    const t = next();
    if (t === undefined) throw new FormulaError('Formula ends unexpectedly.');
    if (/^\d/.test(t)) return { t: 'num', v: Number(t) };
    if (t === '(') { if (++depth > 30) throw new FormulaError('Formula is nested too deeply.'); const e = expr(); if (next() !== ')') throw new FormulaError('Missing closing parenthesis.'); depth--; return e; }
    if (/^[A-Za-z_]/.test(t)) {
      if (peek() === '(') {
        next(); const f = Object.hasOwn(FUNCTIONS, t.toLowerCase()) ? FUNCTIONS[t.toLowerCase()] : undefined;
        if (!f) throw new FormulaError(`Unknown function "${t}". Allowed: ${Object.keys(FUNCTIONS).join(', ')}.`);
        const args: Node[] = [];
        if (peek() !== ')') { args.push(expr()); while (peek() === ',') { next(); args.push(expr()); } }
        if (next() !== ')') throw new FormulaError('Missing closing parenthesis.');
        if (args.length < f.arity[0] || args.length > f.arity[1]) throw new FormulaError(`${t}() takes ${f.arity[0]}${f.arity[1] > f.arity[0] ? `–${f.arity[1]}` : ''} argument(s).`);
        return { t: 'call', fn: t.toLowerCase(), args };
      }
      return { t: 'var', name: t };
    }
    throw new FormulaError(`Unexpected "${t}".`);
  }
  const e = expr();
  if (i < tk.length) throw new FormulaError(`Unexpected "${tk[i]}".`);
  return e;
}

export function formulaVariables(src: string): string[] {
  const names = new Set<string>();
  const walk = (n: Node) => { if (n.t === 'var') names.add(n.name); else if (n.t === 'bin') { walk(n.l); walk(n.r); } else if (n.t === 'neg') walk(n.e); else if (n.t === 'call') n.args.forEach(walk); };
  walk(parseFormula(src)); return [...names];
}

export interface KpiValue { value: number | null; reason?: string; missing?: string[] }

export function evaluateFormula(src: string, vars: Record<string, number | null | undefined>): KpiValue {
  let ast: Node;
  try { ast = parseFormula(src); } catch (e) { return { value: null, reason: `Formula error: ${(e as Error).message}` }; }
  const missing = formulaVariables(src).filter((n) => !Object.hasOwn(vars, n) || typeof vars[n] !== 'number');
  if (missing.length) return { value: null, reason: missing.every(isFinancialVariable) ? 'Not available: needs a balance sheet for this period.' : `Not available: missing input${missing.length > 1 ? 's' : ''} ${missing.filter((n) => !isFinancialVariable(n)).join(', ')}.`, missing };
  let divZero = false;
  const ev = (n: Node): number => {
    switch (n.t) {
      case 'num': return n.v;
      case 'var': return vars[n.name] as number;
      case 'neg': return -ev(n.e);
      case 'call': return FUNCTIONS[n.fn].fn(...n.args.map(ev));
      case 'bin': { const l = ev(n.l), r = ev(n.r); if (n.op === '+') return l + r; if (n.op === '-') return l - r; if (n.op === '*') return l * r; if (r === 0) { divZero = true; return NaN; } return l / r; }
    }
  };
  const v = ev(ast);
  if (divZero) return { value: null, reason: 'Not available: the formula divides by zero for this period.' };
  if (!Number.isFinite(v)) return { value: null, reason: 'Not available: the result is not a finite number.' };
  return { value: v };
}

/** Financial variables every formula may use (dollars, not cents). Anything else in a formula is an operational input. */
export const FINANCIAL_VARIABLES: Record<string, string> = {
  revenue: 'Revenue', cogs: 'Non-labor cost of goods sold', gross_profit: 'Gross profit', direct_labor: 'Direct labor',
  contribution_margin: 'Contribution margin', mgmt_labor: 'Management & admin labor', total_labor: 'Total labor cost',
  facilities: 'Facilities', marketing: 'Marketing', payroll_taxes_benefits: 'Payroll taxes & benefits', other_opex: 'Other operating expenses',
  operating_expenses: 'Total operating expenses', operating_income: 'Operating income', pretax_profit: 'Pretax profit',
  adjusted_pretax_profit: 'Pretax profit after owner-pay normalization', interest_expense: 'Interest expense', depreciation: 'Depreciation',
  ebitda: 'Earnings before interest, taxes, depreciation and amortization', period_days: 'Days in the measurement period (365 for rolling 12, 365÷12 for a month)',
  // Balance-sheet values at the end of the period. N/A when no balance sheet has been imported.
  cash: 'Cash', accounts_receivable: 'Accounts receivable', accounts_payable: 'Accounts payable', current_assets: 'Current assets', current_liabilities: 'Current liabilities',
  total_assets: 'Total assets', total_liabilities: 'Total liabilities', line_of_credit: 'Line of credit balance', notes_payable: 'Notes payable', equity: 'Equity',
};
/** Own-property check — never `in`, which would accept inherited names such as "constructor". */
export const isFinancialVariable = (name: string) => Object.hasOwn(FINANCIAL_VARIABLES, name);
export function financialVars(p: PnlResult, bs: BsLines | null = null, periodDays = 365 / 12): Record<string, number | null> {
  const d = (c: number) => c / 100; const b = (f: (x: BsLines) => number) => (bs ? d(f(bs)) : null);
  const curA = (x: BsLines) => x.cash + x.accounts_receivable + x.other_current_assets; const curL = (x: BsLines) => x.accounts_payable + x.credit_cards + x.other_current_liabilities + x.line_of_credit;
  return {
    revenue: d(p.lines.revenue), cogs: d(p.lines.cogs), gross_profit: d(p.grossProfit), direct_labor: d(p.lines.direct_labor),
    contribution_margin: d(p.contributionMargin), mgmt_labor: d(p.lines.mgmt_labor), total_labor: d(p.totalLabor),
    facilities: d(p.lines.facilities), marketing: d(p.lines.marketing), payroll_taxes_benefits: d(p.lines.payroll_taxes_benefits), other_opex: d(p.lines.other_opex),
    operating_expenses: d(p.totalOpex), operating_income: d(p.operatingIncome), pretax_profit: d(p.pretax), adjusted_pretax_profit: d(p.adjustedPretax),
    interest_expense: d(p.lines.interest_expense), depreciation: d(p.lines.depreciation), ebitda: d(p.pretax + p.lines.interest_expense + p.lines.depreciation), period_days: periodDays,
    cash: b((x) => x.cash), accounts_receivable: b((x) => x.accounts_receivable), accounts_payable: b((x) => x.accounts_payable), current_assets: b(curA), current_liabilities: b(curL),
    total_assets: b((x) => curA(x) + x.fixed_assets + x.accumulated_depreciation + x.other_assets), total_liabilities: b((x) => curL(x) + x.notes_payable),
    line_of_credit: b((x) => x.line_of_credit), notes_payable: b((x) => x.notes_payable), equity: b((x) => x.equity),
  };
}
export type KpiUnit = 'percent' | 'currency' | 'ratio' | 'number' | 'days';
export function fmtKpi(v: number | null, unit: KpiUnit): string {
  if (v === null) return 'N/A';
  if (unit === 'percent') return `${(v * 100).toFixed(1)}%`;
  if (unit === 'currency') return `${v < 0 ? '(' : ''}$${Math.round(Math.abs(v)).toLocaleString('en-US')}${v < 0 ? ')' : ''}`;
  if (unit === 'ratio') return `${v.toFixed(2)}x`;
  if (unit === 'days') return `${Math.round(v)} days`;
  return v.toLocaleString('en-US', { maximumFractionDigits: 1 });
}
export function kpiStatus(v: number | null, target: number | null, alert: number | null, direction: 'higher' | 'lower'): 'on_target' | 'watch' | 'alert' | 'n/a' {
  if (v === null || target === null) return 'n/a';
  const good = direction === 'higher' ? v >= target : v <= target;
  if (good) return 'on_target';
  if (alert !== null && (direction === 'higher' ? v < alert : v > alert)) return 'alert';
  return 'watch';
}
