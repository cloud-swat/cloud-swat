'use strict';
// Missions: receive crew events, keep live state in memory, stream it, and persist it.
const cfg = require('./config');
const db = require('./db');
const S = require('./security');
const auth = require('./auth');
const { newSession, apply } = require('../public/js/reducer.js');

const MAX_FINDINGS = 200, MAX_AGENTS = 30, MAX_EVENTS = 50, MAX_MISSIONS_PER_DAY = 300;
const SEVS = new Set(['critical', 'high', 'medium', 'low', 'info']);
const TYPES = new Set(['mission', 'spawn', 'tool', 'agent_done', 'tokens', 'session_end']);

const live = new Map();        // missionId -> { state, userId, dirty, clients:Set }
const userClients = new Map(); // userId -> Set<res>

// ---------- validation ----------
const str = (v, n) => S.redact(String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ')).slice(0, n);
const key = v => (typeof v === 'string' && /^[\w:.-]{1,64}$/.test(v) ? v : undefined);
const int = (v, max = 1e10) => (Number.isFinite(+v) && +v >= 0 ? Math.min(Math.floor(+v), max) : 0);

function cleanEvent(e, now) {
  if (!e || typeof e !== 'object' || !TYPES.has(e.type)) return null;
  const out = { type: e.type, t: now };
  if (e.text !== undefined) out.text = str(e.text, 160);
  if (e.summary !== undefined) out.summary = str(e.summary, 160);
  if (e.description !== undefined) out.description = str(e.description, 120);
  if (key(e.agentType)) out.agentType = key(e.agentType);
  if (key(e.agentKey)) out.agentKey = key(e.agentKey);
  if (e.tokens !== undefined) out.tokens = int(e.tokens);
  if (e.loud) out.loud = true;
  if (Array.isArray(e.findings)) {
    out.findings = e.findings.slice(0, 20).filter(f => f && SEVS.has(f.sev))
      .map(f => ({ sev: f.sev, title: str(f.title, 140) || 'Untitled finding', where: str(f.where, 140) }));
  }
  return out;
}

// ---------- state ----------
function summary(id, entry) {
  const s = entry.state;
  const agents = s.order.map(k => s.agents[k]);
  return { id, title: s.mission || 'Untitled mission', source: entry.source || 'code',
    created_at: s.createdAt, updated_at: entry.updatedAt || s.createdAt, ended_at: s.endedAt || null,
    live: !s.endedAt && Date.now() - (entry.updatedAt || 0) < 5 * 60e3,
    tokens: agents.reduce((n, a) => n + (a.tokens || 0), 0),
    findings: s.findings.length, agents: agents.filter(a => a.key !== 'captain').length };
}
function publicState(s) { const { alias, ...rest } = s; return rest; }

function load(id) {
  let e = live.get(id);
  if (e) return e;
  const row = db.get('SELECT id,user_id,state_json,updated_at,source FROM missions WHERE id=?', id);
  if (!row) return null;
  e = { state: JSON.parse(row.state_json), userId: row.user_id, dirty: false, clients: new Set(), updatedAt: row.updated_at, source: row.source };
  live.set(id, e);
  return e;
}

function persist(id, e) {
  const sm = summary(id, e);
  db.run(`UPDATE missions SET title=?, updated_at=?, ended_at=?, tokens=?, findings=?, agents=?, state_json=? WHERE id=?`,
    sm.title, sm.updated_at, sm.ended_at, sm.tokens, sm.findings, sm.agents, JSON.stringify(e.state), id);
  e.dirty = false;
}
setInterval(() => {
  for (const [id, e] of live) {
    if (e.dirty) persist(id, e);
    if (!e.clients.size && Date.now() - (e.updatedAt || 0) > 10 * 60e3) live.delete(id); // unload idle missions
  }
}, 2000).unref();

const pendingBroadcast = new Set();
function broadcast(id, e) {
  if (pendingBroadcast.has(id)) return;
  pendingBroadcast.add(id);
  setTimeout(() => {
    pendingBroadcast.delete(id);
    const msg = `event: state\ndata: ${JSON.stringify(publicState(e.state))}\n\n`;
    for (const res of e.clients) res.write(msg);
    const uc = userClients.get(e.userId);
    if (uc) { const m = `event: mission\ndata: ${JSON.stringify(summary(id, e))}\n\n`; for (const res of uc) res.write(m); }
  }, 120);
}

function createMission(userId, deviceId, sourceHash, source) {
  const id = S.randomToken('', 12);
  const now = Date.now();
  const st = newSession(id); st.createdAt = now;
  db.run(`INSERT INTO missions(id,user_id,device_id,source_hash,source,created_at,updated_at,state_json) VALUES(?,?,?,?,?,?,?,?)`,
    id, userId, deviceId, sourceHash, source, now, now, JSON.stringify(st));
  return id;
}

function applyEvents(id, e, events) {
  const s = e.state;
  for (const ev of events) {
    if (ev.type === 'spawn' && s.order.length >= MAX_AGENTS && !s.agents[String(ev.agentType || '').split(':').pop()]) continue;
    apply(s, ev);
  }
  if (s.findings.length > MAX_FINDINGS) s.findings.length = MAX_FINDINGS;
  if (s.order.length > MAX_AGENTS) { for (const k of s.order.slice(MAX_AGENTS)) delete s.agents[k]; s.order.length = MAX_AGENTS; }
  e.updatedAt = Date.now(); e.dirty = true;
  if (s.endedAt) persist(id, e);
  broadcast(id, e);
}

// ---------- device ingest: POST /api/v1/events ----------
async function ingest(req, res, device) {
  if (!S.rateLimit('ingest:' + device.id, 20, 80)) throw new S.HttpError(429, 'slow down');
  const body = await S.readJson(req, 64 * 1024);
  const session = String(body.session || '');
  if (!/^[\w-]{1,100}$/.test(session)) throw new S.HttpError(400, 'invalid session');
  const now = Date.now();
  const events = (Array.isArray(body.events) ? body.events : []).slice(0, MAX_EVENTS).map(e => cleanEvent(e, now)).filter(Boolean);
  if (!events.length) return S.sendJson(res, 200, { ok: true });

  const sourceHash = S.hmac(`device:${device.id}:${session}`);
  let row = db.get('SELECT id FROM missions WHERE device_id=? AND source_hash=?', device.id, sourceHash);
  if (!row) {
    const today = db.get('SELECT COUNT(*) AS n FROM missions WHERE user_id=? AND created_at>?', device.user_id, now - 86400e3).n;
    if (today >= MAX_MISSIONS_PER_DAY) throw new S.HttpError(429, 'daily mission limit reached');
  }
  const id = row ? row.id : createMission(device.user_id, device.id, sourceHash, 'code');
  const e = load(id);
  if (!e || e.userId !== device.user_id) throw new S.HttpError(403, 'forbidden');
  applyEvents(id, e, events);
  S.sendJson(res, 200, { ok: true, mission: id, url: `${cfg.PUBLIC_URL}/app/m/${id}` });
}

// A finished report sent from a Claude chat through MCP (one call, not a stream).
function saveReport(userId, report) {
  const today = db.get('SELECT COUNT(*) AS n FROM missions WHERE user_id=? AND created_at>?', userId, Date.now() - 86400e3).n;
  if (today >= MAX_MISSIONS_PER_DAY) throw new S.HttpError(429, 'daily mission limit reached');
  const id = createMission(userId, null, null, 'mcp');
  const e = load(id);
  const now = Date.now();
  const evs = [{ type: 'mission', text: report.title }];
  for (const a of (report.agents || []).slice(0, 12)) {
    const k = key(String(a.name || '').toLowerCase().replace(/[^\w-]/g, '-').slice(0, 40)) || 'agent';
    evs.push({ type: 'spawn', agentType: k, description: a.role });
    evs.push({ type: 'agent_done', agentType: k, tokens: a.tokens, summary: a.summary || 'Report delivered to Captain', findings: [] });
  }
  if (report.findings?.length) evs.push({ type: 'agent_done', agentType: 'captain', findings: report.findings });
  if (report.summary) evs.push({ type: 'tool', agentKey: 'captain', summary: report.summary });
  evs.push({ type: 'session_end' });
  applyEvents(id, e, evs.map(x => cleanEvent(x, now)).filter(Boolean));
  persist(id, e);
  return id;
}

// ---------- browser API ----------
function listMissions(userId, limit = 50) {
  return db.all('SELECT id,title,source,created_at,updated_at,ended_at,tokens,findings,agents FROM missions WHERE user_id=? ORDER BY updated_at DESC LIMIT ?', userId, limit)
    .map(r => { const e = live.get(r.id); return e ? summary(r.id, e) : { ...r, live: !r.ended_at && Date.now() - r.updated_at < 5 * 60e3 }; });
}
function ownMission(user, id) {
  if (!/^[\w-]{10,40}$/.test(id)) throw new S.HttpError(404, 'not found');
  const e = load(id);
  if (!e || e.userId !== user.id) throw new S.HttpError(404, 'not found'); // 404, not 403: don't reveal it exists
  return e;
}

const MAX_STREAMS_PER_USER = 20;
function countStreams(userId) { let n = userClients.get(userId)?.size || 0; for (const e of live.values()) if (e.userId === userId) n += e.clients.size; return n; }
function openStream(req, res, set) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 3000\n\n');
  set.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ping); set.delete(res); });
}
function streamMission(req, res, user, id) {
  const e = ownMission(user, id);
  if (countStreams(user.id) >= MAX_STREAMS_PER_USER) throw new S.HttpError(429, 'too many open views');
  openStream(req, res, e.clients);
  res.write(`event: state\ndata: ${JSON.stringify(publicState(e.state))}\n\n`);
}
function streamUser(req, res, user) {
  if (countStreams(user.id) >= MAX_STREAMS_PER_USER) throw new S.HttpError(429, 'too many open views');
  if (!userClients.has(user.id)) userClients.set(user.id, new Set());
  openStream(req, res, userClients.get(user.id));
}

function deleteMission(user, id) {
  ownMission(user, id);
  const e = live.get(id);
  if (e) { for (const r of e.clients) r.end(); live.delete(id); }
  db.run('DELETE FROM missions WHERE id=? AND user_id=?', id, user.id);
}

function stats(userId, days) {
  const since = Date.now() - days * 86400e3;
  const rows = db.all('SELECT tokens,findings,agents,state_json FROM missions WHERE user_id=? AND updated_at>=?', userId, since);
  const sev = {}; const byAgent = {};
  for (const r of rows) {
    const s = JSON.parse(r.state_json);
    for (const f of s.findings) sev[f.sev] = (sev[f.sev] || 0) + 1;
    for (const k of s.order) { const a = s.agents[k]; byAgent[a.name] = (byAgent[a.name] || 0) + (a.tokens || 0); }
  }
  const tokens = rows.reduce((n, r) => n + r.tokens, 0);
  return { days, missions: rows.length, tokens, findings: rows.reduce((n, r) => n + r.findings, 0), severity: sev,
    cost: cfg.PRICE_PER_MTOK ? +(tokens / 1e6 * cfg.PRICE_PER_MTOK).toFixed(2) : null,
    top: Object.entries(byAgent).sort((a, b) => b[1] - a[1]).slice(0, 3) };
}

// Housekeeping: retention + expired credentials
function cleanup() {
  const now = Date.now();
  db.run('DELETE FROM missions WHERE updated_at<?', now - cfg.RETENTION_DAYS * 86400e3);
  db.run('DELETE FROM web_sessions WHERE expires_at<?', now);
  db.run("DELETE FROM device_codes WHERE expires_at<?", now - 3600e3);
  db.run('DELETE FROM oauth_codes WHERE expires_at<?', now);
  db.run('DELETE FROM oauth_tokens WHERE expires_at<? OR revoked=1', now);
  db.run('DELETE FROM oauth_clients WHERE created_at<? AND client_id NOT IN (SELECT DISTINCT client_id FROM oauth_tokens)', now - 7 * 86400e3);
}
setInterval(cleanup, 3600e3).unref();
cleanup();

function flush() { for (const [id, e] of live) if (e.dirty) persist(id, e); }

module.exports = { flush, ingest, saveReport, listMissions, ownMission, publicState, streamMission, streamUser, deleteMission, stats, live };
