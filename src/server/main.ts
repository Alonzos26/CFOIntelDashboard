import { loadConfig } from './config.ts';
import { Db } from './db.ts';
import { App } from './app.ts';
import { DEMO_PASSWORD, seed } from './seed.ts';
import { syncKpiLibrary } from './library.ts';

const cfg = loadConfig(); const db = new Db(cfg.dbPath);
if (process.env.SEED_DEMO === '1' && seed(db)) console.log(`Seeded SYNTHETIC demo data. Demo sign-in password for every demo account: ${DEMO_PASSWORD}`);
const lib = syncKpiLibrary(db); if (lib.industries || lib.kpis) console.log(`KPI library: added ${lib.industries} industr${lib.industries === 1 ? 'y' : 'ies'} and ${lib.kpis} KPI definition(s) from db/kpi-library.json`);
const app = new App(db, cfg);
await app.listen();
console.log(`CFO Intelligence listening on http://localhost:${cfg.port}${cfg.portalSsoSecret ? ' (portal sign-on enabled)' : ''}`);
