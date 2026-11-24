// Writes the synthetic example import files used in the onboarding walkthrough and tests.
import { mkdirSync, writeFileSync } from 'node:fs';
import { PROFILES, generate, withErrors } from '../src/server/synthetic.ts';
const g = generate(PROFILES.lakeside('2026-10'));
mkdirSync('examples/imports', { recursive: true });
writeFileSync('examples/imports/lakeside-pnl-2025-2026.csv', g.pnlCsv);
writeFileSync('examples/imports/lakeside-balance-sheet-2025-2026.csv', g.bsCsv);
writeFileSync('examples/imports/lakeside-pnl-WITH-ERRORS.csv', withErrors(g.pnlCsv));
writeFileSync('examples/imports/lakeside-balance-sheet-OUT-OF-BALANCE.csv', g.bsCsv.replace(/^(1200 Accounts Receivable,[^,]+,[^,]+,)([^,]+)/m, (_, a) => `${a}999999.00`));
console.log('wrote examples/imports');
