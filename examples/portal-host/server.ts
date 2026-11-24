// EXAMPLE ONLY — a stand-in for the SJATS Client Portal showing how to embed the CFO dashboard.
// The real portal does the same three things:
//   1. Its BACKEND (never the browser) signs a launch token for the already signed-in user and the client they are viewing.
//   2. It renders an iframe pointing at  <CFO_URL>/embed#token=<launch token>   (fragment: never sent to servers or logged).
//   3. The CFO app exchanges the token for its own short-lived session. No second login, no client IDs in query strings.
import { createServer } from 'node:http';
import { mintLaunchToken } from '../../src/server/auth.ts';

const CFO_URL = process.env.CFO_URL ?? 'http://localhost:4300';
const SECRET = process.env.PORTAL_SSO_SECRET ?? '';
const PORT = Number(process.env.PORTAL_PORT ?? 4400);
if (!SECRET) { console.error('Set PORTAL_SSO_SECRET to the same value the CFO app uses.'); process.exit(1); }

// In the real portal these come from the user's authenticated portal session.
const portalUser = { email: process.env.PORTAL_USER ?? 'owner@cedarridge.demo', name: 'Casey Owner', clientId: process.env.PORTAL_CLIENT ?? 'portal-client-1001', clientName: 'Cedar Ridge Builders' };

createServer((req, res) => {
  if (req.url !== '/' && req.url !== '/advisory/cfo-dashboard') { res.writeHead(404); return res.end(); }
  const onDashboard = req.url === '/advisory/cfo-dashboard';
  const token = onDashboard ? mintLaunchToken(SECRET, { sub: portalUser.email, client: portalUser.clientId, ttlSeconds: 60 }) : '';
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': `default-src 'self'; style-src 'unsafe-inline'; frame-src ${CFO_URL}` });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>SJATS Client Portal (example)</title>
<style>body{margin:0;font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#15161a;background:#f5f5f3}header{background:#fff;border-bottom:1px solid #e2e1dc;padding:12px 20px;display:flex;gap:24px;align-items:center}
header b{letter-spacing:.04em}nav a{margin-right:16px;color:#3f4046;text-decoration:none}nav a.on{font-weight:650;color:#15161a;border-bottom:2px solid #15161a;padding-bottom:13px}
.crumb{padding:10px 20px;color:#6a6b70}main{padding:0 20px 20px}iframe{width:100%;height:calc(100vh - 110px);border:1px solid #e2e1dc;border-radius:6px;background:#fff}.card{background:#fff;border:1px solid #e2e1dc;border-radius:6px;padding:20px;max-width:560px}</style></head><body>
<header><b>SJATS</b> Client Portal <span style="color:#b3261e;font-size:12px">EXAMPLE HOST</span><nav style="margin-left:24px"><a href="/" class="${onDashboard ? '' : 'on'}">Home</a><a href="/advisory/cfo-dashboard" class="${onDashboard ? 'on' : ''}">Advisory</a></nav><span style="margin-left:auto;color:#6a6b70">${portalUser.name} · ${portalUser.clientName}</span></header>
${onDashboard ? `<div class="crumb">Client Portal → Advisory → CFO Dashboard</div><main><iframe title="CFO Dashboard" src="${CFO_URL}/embed#token=${token}" referrerpolicy="no-referrer"></iframe></main>`
    : `<div class="crumb">Client Portal → Home</div><main><div class="card"><h2>Welcome back, ${portalUser.name}</h2><p>You are signed in to the portal. Open <a href="/advisory/cfo-dashboard">Advisory → CFO Dashboard</a> — you will not be asked to sign in again.</p></div></main>`}
</body></html>`);
}).listen(PORT, () => console.log(`Example portal host on http://localhost:${PORT} embedding ${CFO_URL}`));
