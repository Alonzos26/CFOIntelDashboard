// KPI library loader. Industry packs live in db/kpi-library.json and are synced at every startup:
// new industries and new KPI keys are added; anything already in the database (including advisor edits) is left untouched.
// So a future industry is added either in the app (KPI Library) or by adding a block to the JSON file — no code change.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { formulaVariables } from '../engine/kpi.ts';
import { type Db, now, uid } from './db.ts';

export interface PackKpi { key: string; name: string; formula: string; unit: string; direction: string; basis: string; description: string; recommendedAction: string; dataSource: string; benchmarkNote: string | null }
export interface Pack { industry: string; sources: string[]; kpis: PackKpi[] }
export const loadPacks = (file = join(import.meta.dirname, '../../db/kpi-library.json')): Pack[] => JSON.parse(readFileSync(file, 'utf8')).packs;

export function syncKpiLibrary(db: Db, packs: Pack[] = loadPacks()): { industries: number; kpis: number } {
  let industries = 0, kpis = 0;
  db.tx(() => {
    for (const p of packs) {
      let ind = db.get('SELECT id FROM industries WHERE name = ?', p.industry);
      if (!ind) { ind = { id: uid() }; db.run('INSERT INTO industries (id, name) VALUES (?,?)', ind.id, p.industry); industries++; }
      for (const k of p.kpis) {
        if (db.get('SELECT id FROM kpi_definitions WHERE industry_id = ? AND key = ?', ind.id, k.key)) continue;
        formulaVariables(k.formula); // throws on an invalid formula, so a bad pack fails loudly at startup
        if (!['percent', 'currency', 'ratio', 'number', 'days'].includes(k.unit) || !['higher', 'lower'].includes(k.direction) || !['month', 'r12'].includes(k.basis)) throw new Error(`KPI pack "${p.industry}" / ${k.key}: invalid unit, direction or basis.`);
        db.run('INSERT INTO kpi_definitions (id, industry_id, key, name, formula, unit, basis, direction, description, recommended_action, data_source, benchmark_source, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
          uid(), ind.id, k.key, k.name, k.formula, k.unit, k.basis, k.direction, k.description, k.recommendedAction, k.dataSource, k.benchmarkNote, now()); kpis++;
      }
    }
    if (industries || kpis) db.audit(null, null, 'kpi.library_synced', undefined, undefined, { industries, kpis });
  });
  return { industries, kpis };
}
