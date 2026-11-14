'use strict';
// MCP v1 (Streamable HTTP, JSON responses) + the OAuth 2.1 endpoints Claude uses to connect.
// Small on purpose: 4 tools with short descriptions and compact text results, to keep token use low.
const crypto = require('node:crypto');
const cfg = require('./config');
const db = require('./db');
const S = require('./security');
const auth = require('./auth');
const views = require('./views');
const live = require('./live');

const ACCESS_TTL = 3600e3, REFRESH_TTL = 30 * 86400e3, CODE_TTL = 60e3;
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const RESOURCE_META = `${cfg.PUBLIC_URL}/.well-known/oauth-protected-resource`;

// ---------- discovery ----------
function protectedResource(req, res) {
  S.sendJson(res, 200, { resource: `${cfg.PUBLIC_URL}/mcp`, authorization_servers: [cfg.PUBLIC_URL],
    scopes_supported: ['missions'], bearer_methods_supported: ['header'] }, { 'Access-Control-Allow-Origin': '*' });
}
function authServer(req, res) {
  S.sendJson(res, 200, {
    issuer: cfg.PUBLIC_URL,
    authorization_endpoint: `${cfg.PUBLIC_URL}/oauth/authorize`,
    token_endpoint: `${cfg.PUBLIC_URL}/oauth/token`,
    registration_endpoint: `${cfg.PUBLIC_URL}/oauth/register`,
    revocation_endpoint: `${cfg.PUBLIC_URL}/oauth/revoke`,
    response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], scopes_supported: ['missions'],
  }, { 'Access-Control-Allow-Origin': '*' });
}

// ---------- dynamic client registration ----------
function validRedirect(u) {
  try {
    const x = new URL(u);
    if (x.hash || u.length > 300) return false;
    if (x.protocol === 'https:') return true;
    return x.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(x.hostname);
  } catch { return false; }
}
async function register(req, res) {
  if (!S.rateLimit('reg:' + S.clientIp(req), 0.05, 10)) throw new S.HttpError(429, 'too many registrations');
  const b = await S.readJson(req, 8192);
  const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.slice(0, 5).map(String) : [];
  if (!uris.length || !uris.every(validRedirect)) return S.sendJson(res, 400, { error: 'invalid_redirect_uri' });
  const name = String(b.client_name || 'MCP client').replace(/[^\w .()-]/g, '').slice(0, 60) || 'MCP client';
  const client_id = S.randomToken('csc_', 18);
  db.run('INSERT INTO oauth_clients(client_id,name,redirect_uris,created_at) VALUES(?,?,?,?)', client_id, name, JSON.stringify(uris), Date.now());
  S.sendJson(res, 201, { client_id, client_name: name, redirect_uris: uris, token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
}

// ---------- authorization (consent page) ----------
function readAuthParams(src) {
  const get = k => (src instanceof URLSearchParams ? src.get(k) : src[k]) || '';
  const p = { response_type: get('response_type'), client_id: get('client_id'), redirect_uri: get('redirect_uri'),
    state: get('state'), code_challenge: get('code_challenge'), code_challenge_method: get('code_challenge_method'),
    scope: get('scope'), resource: get('resource') };
  const client = /^csc_[\w-]{10,40}$/.test(p.client_id) && db.get('SELECT * FROM oauth_clients WHERE client_id=?', p.client_id);
  // Never redirect anywhere until client and redirect_uri are confirmed.
  if (!client) throw new S.HttpError(400, 'unknown client');
  if (!JSON.parse(client.redirect_uris).includes(p.redirect_uri)) throw new S.HttpError(400, 'redirect_uri not registered');
  return { p, client };
}
function errorRedirect(res, p, error) {
  const u = new URL(p.redirect_uri); u.searchParams.set('error', error); if (p.state) u.searchParams.set('state', p.state);
  S.redirect(res, u.toString(), 303);
}
function authorizePage(req, res, query) {
  const { p, client } = readAuthParams(query);
  const user = auth.currentUser(req);
  if (!user) return S.redirect(res, '/login?next=' + encodeURIComponent('/oauth/authorize?' + query.toString()));
  if (p.response_type !== 'code') return errorRedirect(res, p, 'unsupported_response_type');
  if (p.code_challenge_method !== 'S256' || !/^[\w-]{43,128}$/.test(p.code_challenge)) return errorRedirect(res, p, 'invalid_request');
  S.allowFormTarget(res, new URL(p.redirect_uri).origin);
  S.sendHtml(res, 200, views.consentPage({ client: client.name, redirectHost: new URL(p.redirect_uri).host, params: p, csrf: auth.csrfFor(user) }));
}
async function authorizeDecision(req, res) {
  const user = auth.requireUser(req);
  const form = await S.readForm(req);
  auth.checkCsrf(req, user, form.csrf);
  const { p } = readAuthParams(form);
  if (form.decision !== 'approve') return errorRedirect(res, p, 'access_denied');
  if (p.code_challenge_method !== 'S256' || !/^[\w-]{43,128}$/.test(p.code_challenge)) return errorRedirect(res, p, 'invalid_request');
  const code = S.randomToken('', 32);
  db.run('INSERT INTO oauth_codes(code_hash,client_id,user_id,redirect_uri,code_challenge,expires_at) VALUES(?,?,?,?,?,?)',
    S.sha256(code), p.client_id, user.id, p.redirect_uri, p.code_challenge, Date.now() + CODE_TTL);
  const u = new URL(p.redirect_uri); u.searchParams.set('code', code); if (p.state) u.searchParams.set('state', p.state);
  S.redirect(res, u.toString(), 303);
}

// ---------- token endpoint ----------
function issueTokens(clientId, userId) {
  const access = S.randomToken('csa_', 32), refresh = S.randomToken('csr_', 32), now = Date.now();
  db.run('INSERT INTO oauth_tokens(token_hash,kind,client_id,user_id,expires_at) VALUES(?,?,?,?,?)', S.sha256(access), 'access', clientId, userId, now + ACCESS_TTL);
  db.run('INSERT INTO oauth_tokens(token_hash,kind,client_id,user_id,expires_at) VALUES(?,?,?,?,?)', S.sha256(refresh), 'refresh', clientId, userId, now + REFRESH_TTL);
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL / 1000, refresh_token: refresh, scope: 'missions' };
}
const tokenError = (res, error, status = 400) => S.sendJson(res, status, { error }, { Pragma: 'no-cache' });
async function token(req, res) {
  if (!S.rateLimit('tok:' + S.clientIp(req), 1, 20)) return tokenError(res, 'slow_down', 429);
  const f = await S.readForm(req, 8192);
  const now = Date.now();
  if (f.grant_type === 'authorization_code') {
    const row = db.get('SELECT * FROM oauth_codes WHERE code_hash=?', S.sha256(String(f.code || '')));
    if (!row || row.used || row.expires_at < now) return tokenError(res, 'invalid_grant');
    // single use, even if the rest fails
    db.run('UPDATE oauth_codes SET used=1 WHERE code_hash=?', row.code_hash);
    if (row.client_id !== f.client_id || row.redirect_uri !== f.redirect_uri) return tokenError(res, 'invalid_grant');
    const verifier = String(f.code_verifier || '');
    if (!/^[\w.~-]{43,128}$/.test(verifier)) return tokenError(res, 'invalid_grant');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    if (!S.safeEqual(challenge, row.code_challenge)) return tokenError(res, 'invalid_grant');
    return S.sendJson(res, 200, issueTokens(row.client_id, row.user_id), { Pragma: 'no-cache' });
  }
  if (f.grant_type === 'refresh_token') {
    const h = S.sha256(String(f.refresh_token || ''));
    const row = db.get("SELECT * FROM oauth_tokens WHERE token_hash=? AND kind='refresh'", h);
    if (!row || row.revoked || row.expires_at < now || row.client_id !== f.client_id) return tokenError(res, 'invalid_grant');
    db.run('UPDATE oauth_tokens SET revoked=1 WHERE token_hash=?', h);   // rotate
    return S.sendJson(res, 200, issueTokens(row.client_id, row.user_id), { Pragma: 'no-cache' });
  }
  tokenError(res, 'unsupported_grant_type');
}
async function revoke(req, res) {
  const f = await S.readForm(req, 4096);
  db.run('UPDATE oauth_tokens SET revoked=1 WHERE token_hash=?', S.sha256(String(f.token || '')));
  res.writeHead(200); res.end();
}

function userFromBearer(req) {
  const m = /^Bearer (csa_[\w-]{20,80})$/.exec(String(req.headers.authorization || ''));
  if (!m) return null;
  const row = db.get("SELECT user_id,client_id FROM oauth_tokens WHERE token_hash=? AND kind='access' AND revoked=0 AND expires_at>?", S.sha256(m[1]), Date.now());
  return row ? { id: row.user_id, clientId: row.client_id } : null;
}

// ---------- tools ----------
const ago = t => { const m = Math.round((Date.now() - t) / 60e3); return m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`; };
const k = n => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n));
const SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

const TOOLS = [
  { name: 'swat_stats', description: 'Crew usage totals: missions, tokens, findings.',
    inputSchema: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 90, default: 7 } } },
    annotations: { readOnlyHint: true } },
  { name: 'swat_missions', description: 'Recent missions (id, title, tokens, findings).',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 10, default: 5 } } },
    annotations: { readOnlyHint: true } },
  { name: 'swat_findings', description: 'Findings from one mission, or the latest ones.',
    inputSchema: { type: 'object', properties: { mission: { type: 'string' },
      min: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] } } },
    annotations: { readOnlyHint: true } },
  { name: 'swat_report', description: 'Save a finished mission summary to the dashboard. Call once at the end, not per step.',
    inputSchema: { type: 'object', required: ['title'], properties: {
      title: { type: 'string', maxLength: 140 }, summary: { type: 'string', maxLength: 300 },
      agents: { type: 'array', maxItems: 12, items: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, role: { type: 'string' }, tokens: { type: 'integer' } } } },
      findings: { type: 'array', maxItems: 20, items: { type: 'object', required: ['sev', 'title'], properties: {
        sev: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] }, title: { type: 'string' }, where: { type: 'string' } } } } } } },
];

function callTool(userId, name, a = {}) {
  if (name === 'swat_stats') {
    const st = live.stats(userId, Math.min(90, Math.max(1, Number(a.days) || 7)));
    const sev = Object.entries(st.severity).sort((x, y) => SEV_RANK[x[0]] - SEV_RANK[y[0]]).map(([s, n]) => `${n} ${s}`).join(', ');
    return `${st.days}d: ${st.missions} missions · ${k(st.tokens)} tokens${st.cost != null ? ` · ~$${st.cost}` : ''} · ${st.findings} findings${sev ? ` (${sev})` : ''}` +
      (st.top.length ? `\ntop: ${st.top.map(([n, t]) => `${n} ${k(t)}`).join(', ')}` : '');
  }
  if (name === 'swat_missions') {
    const rows = live.listMissions(userId, Math.min(10, Math.max(1, Number(a.limit) || 5)));
    return rows.length ? rows.map(r => `${r.id} · ${r.title.slice(0, 60)} · ${k(r.tokens)} tok · ${r.findings} findings · ${r.live ? 'LIVE' : ago(r.updated_at) + ' ago'}`).join('\n') : 'No missions yet.';
  }
  if (name === 'swat_findings') {
    const min = SEV_RANK[a.min] ?? 4;
    let list = [];
    if (a.mission) {
      const e = live.ownMission({ id: userId }, String(a.mission));
      list = e.state.findings;
    } else {
      for (const r of live.listMissions(userId, 5)) list.push(...live.ownMission({ id: userId }, r.id).state.findings);
    }
    list = list.filter(f => (SEV_RANK[f.sev] ?? 9) <= min).slice(0, 25);
    return list.length ? list.map(f => `[${f.sev}] ${f.title}${f.where ? ' | ' + f.where : ''}`).join('\n') : 'No findings.';
  }
  if (name === 'swat_report') {
    if (!a.title || typeof a.title !== 'string') throw rpcError(-32602, 'title is required');
    if (!S.rateLimit('report:' + userId, 0.1, 10)) throw rpcError(-32000, 'too many reports, try later');
    const id = live.saveReport(userId, a);
    return `saved: ${cfg.PUBLIC_URL}/app/m/${id}`;
  }
  throw rpcError(-32602, 'unknown tool');
}

function rpcError(code, message) { const e = new Error(message); e.rpc = code; return e; }

function handleRpc(user, msg) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return { jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32600, message: 'invalid request' } };
  const isNotification = msg.id === undefined;
  try {
    let result;
    switch (msg.method) {
      case 'initialize': {
        const want = msg.params?.protocolVersion;
        result = { protocolVersion: PROTOCOLS.includes(want) ? want : PROTOCOLS[0], capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'cloud-swat', version: cfg.VERSION },
          instructions: 'Read crew stats/findings. To save a chat mission, call swat_report once at the end.' };
        break;
      }
      case 'ping': result = {}; break;
      case 'tools/list': result = { tools: TOOLS }; break;
      case 'tools/call': {
        const text = callTool(user.id, msg.params?.name, msg.params?.arguments || {});
        result = { content: [{ type: 'text', text }] };
        break;
      }
      default:
        if (msg.method.startsWith('notifications/')) return null;
        throw rpcError(-32601, 'method not found');
    }
    return isNotification ? null : { jsonrpc: '2.0', id: msg.id, result };
  } catch (err) {
    if (isNotification) return null;
    if (msg.method === 'tools/call' && !err.rpc) {
      // Tool errors go back as a tool result so the model can read them
      return { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'Error: ' + (err.status === 404 ? 'mission not found' : 'failed') }], isError: true } };
    }
    return { jsonrpc: '2.0', id: msg.id, error: { code: err.rpc || -32603, message: err.rpc ? err.message : 'internal error' } };
  }
}

async function endpoint(req, res) {
  // DNS-rebinding guard: browsers send Origin; only our own origin may call from a page.
  if (req.headers.origin && req.headers.origin !== cfg.ORIGIN) return S.sendJson(res, 403, { error: 'origin not allowed' });
  if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }); return res.end(); }
  const user = userFromBearer(req);
  if (!user) {
    res.writeHead(401, { 'WWW-Authenticate': `Bearer resource_metadata="${RESOURCE_META}"`, 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'unauthorized' }));
  }
  if (!S.rateLimit('mcp:' + user.id, 5, 30)) return S.sendJson(res, 429, { error: 'slow down' });
  const body = await S.readJson(req, 32 * 1024);
  const out = Array.isArray(body) ? body.slice(0, 20).map(m => handleRpc(user, m)).filter(Boolean) : handleRpc(user, body);
  if (!out || (Array.isArray(out) && !out.length)) { res.writeHead(202); return res.end(); }
  S.sendJson(res, 200, out);
}

// Account page: list / disconnect connected apps
function connections(userId) {
  return db.all(`SELECT c.client_id, c.name, MAX(t.expires_at) AS until FROM oauth_tokens t JOIN oauth_clients c ON c.client_id=t.client_id
                 WHERE t.user_id=? AND t.revoked=0 AND t.expires_at>? GROUP BY c.client_id`, userId, Date.now());
}
function disconnect(userId, clientId) { db.run('UPDATE oauth_tokens SET revoked=1 WHERE user_id=? AND client_id=?', userId, String(clientId)); }

module.exports = { protectedResource, authServer, register, authorizePage, authorizeDecision, token, revoke, endpoint, connections, disconnect };
