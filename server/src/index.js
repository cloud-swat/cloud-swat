'use strict';
// Cloud SWAT server — zero third-party dependencies.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const cfg = require('./config');
const db = require('./db');
const S = require('./security');
const auth = require('./auth');
const device = require('./device');
const live = require('./live');
const mcp = require('./mcp');
const views = require('./views');

const PUBLIC = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

// Static files: fixed folder, no dotfiles, no path tricks.
function serveStatic(res, rel, { cache = 300 } = {}) {
  if (!/^[\w./-]+$/.test(rel) || rel.split('/').some(p => p.startsWith('.'))) throw new S.HttpError(404, 'not found');
  const full = path.join(PUBLIC, rel);
  if (!full.startsWith(PUBLIC + path.sep)) throw new S.HttpError(404, 'not found');
  let buf;
  try { buf = fs.readFileSync(full); } catch { throw new S.HttpError(404, 'not found'); }
  const type = MIME[path.extname(full)];
  if (!type) throw new S.HttpError(404, 'not found');
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': type.startsWith('text/html') ? 'no-cache' : `public, max-age=${cache}` });
  res.end(buf);
}

function needUserPage(req, res, url) {
  const u = auth.currentUser(req);
  if (!u) { S.redirect(res, '/login?next=' + encodeURIComponent(url.pathname + url.search)); return null; }
  return u;
}

async function route(req, res) {
  const url = new URL(req.url, cfg.ORIGIN);
  const p = url.pathname;
  const m = req.method;

  // ----- public pages -----
  if (m === 'GET' && p === '/') return serveStatic(res, 'index.html');
  if (m === 'GET' && p === '/demo') return serveStatic(res, 'mission.html');
  if (m === 'GET' && p === '/privacy') return S.sendHtml(res, 200, views.privacyPage());
  if (m === 'GET' && p === '/healthz') return S.sendJson(res, 200, { ok: true, version: cfg.VERSION });
  if (m === 'GET' && p === '/favicon.svg') return serveStatic(res, 'favicon.svg', { cache: 86400 });
  if (m === 'GET' && /^\/(css|js)\/[\w.-]+$/.test(p)) return serveStatic(res, p.slice(1));

  // ----- sign in -----
  if (m === 'GET' && p === '/login') {
    if (auth.currentUser(req)) return S.redirect(res, S.safeNext(url.searchParams.get('next')));
    const err = { cancelled: 'Sign-in was cancelled.' }[url.searchParams.get('error')];
    return S.sendHtml(res, 200, views.loginPage(S.safeNext(url.searchParams.get('next')), auth.providers(), err));
  }
  if (m === 'GET' && (p === '/auth/github' || p === '/auth/google')) {
    const prov = p.split('/')[2];
    if (!auth.providers()[prov]) throw new S.HttpError(404, 'not found');
    return auth.startLogin(req, res, prov, url.searchParams.get('next'));
  }
  if (m === 'GET' && (p === '/auth/github/callback' || p === '/auth/google/callback')) {
    const prov = p.split('/')[2];
    if (!auth.providers()[prov]) throw new S.HttpError(404, 'not found');
    return auth.finishLogin(req, res, prov, url.searchParams);
  }
  if (m === 'GET' && p === '/auth/dev') return auth.devLogin(req, res, url.searchParams.get('next'), url.searchParams.get('as'));
  if (m === 'POST' && p === '/logout') return auth.logout(req, res);

  // ----- device linking -----
  if (m === 'POST' && p === '/api/v1/device/start') return device.start(req, res);
  if (m === 'POST' && p === '/api/v1/device/token') return device.token(req, res);
  if (m === 'GET' && p === '/link') return device.page(req, res, url.searchParams);
  if (m === 'POST' && p === '/link') return device.decide(req, res);

  // ----- events from Claude Code (device token) -----
  if (p === '/api/v1/events') {
    if (m !== 'POST') throw new S.HttpError(405, 'method not allowed');
    const d = device.deviceFromRequest(req);
    if (!d) throw new S.HttpError(401, 'device not linked');
    return live.ingest(req, res, d);
  }

  // ----- MCP + OAuth -----
  if (m === 'GET' && (p === '/.well-known/oauth-protected-resource' || p === '/.well-known/oauth-protected-resource/mcp')) return mcp.protectedResource(req, res);
  if (m === 'GET' && p === '/.well-known/oauth-authorization-server') return mcp.authServer(req, res);
  if (m === 'POST' && p === '/oauth/register') return mcp.register(req, res);
  if (m === 'GET' && p === '/oauth/authorize') return mcp.authorizePage(req, res, url.searchParams);
  if (m === 'POST' && p === '/oauth/authorize') return mcp.authorizeDecision(req, res);
  if (m === 'POST' && p === '/oauth/token') return mcp.token(req, res);
  if (m === 'POST' && p === '/oauth/revoke') return mcp.revoke(req, res);
  if (p === '/mcp') return mcp.endpoint(req, res);

  // ----- signed-in pages -----
  if (m === 'GET' && p === '/app') { if (needUserPage(req, res, url)) serveStatic(res, 'app.html'); return; }
  if (m === 'GET' && p === '/app/account') { if (needUserPage(req, res, url)) serveStatic(res, 'account.html'); return; }
  if (m === 'GET' && /^\/app\/m\/[\w-]{10,40}$/.test(p)) { if (needUserPage(req, res, url)) serveStatic(res, 'mission.html'); return; }

  // ----- signed-in API -----
  if (p.startsWith('/api/v1/')) {
    if (m === 'GET' && p === '/api/v1/config') return S.sendJson(res, 200, { providers: auth.providers(), version: cfg.VERSION });
    const user = auth.requireUser(req);
    if (m === 'GET' && p === '/api/v1/me') return S.sendJson(res, 200, { user: { name: user.name, avatar: user.avatar, provider: user.provider }, csrf: auth.csrfFor(user) });
    if (m === 'GET' && p === '/api/v1/missions') return S.sendJson(res, 200, { missions: live.listMissions(user.id, 50) });
    if (m === 'GET' && p === '/api/v1/stats') return S.sendJson(res, 200, live.stats(user.id, Math.min(90, Math.max(1, Number(url.searchParams.get('days')) || 7))));
    if (m === 'GET' && p === '/api/v1/stream') return live.streamUser(req, res, user);
    let mm;
    if ((mm = /^\/api\/v1\/missions\/([\w-]{10,40})(\/stream)?$/.exec(p))) {
      if (m === 'GET' && mm[2]) return live.streamMission(req, res, user, mm[1]);
      if (m === 'GET') return S.sendJson(res, 200, live.publicState(live.ownMission(user, mm[1]).state));
      if (m === 'DELETE') { auth.checkCsrf(req, user); live.deleteMission(user, mm[1]); return S.sendJson(res, 200, { ok: true }); }
    }
    if (m === 'GET' && p === '/api/v1/devices') {
      return S.sendJson(res, 200, { devices: db.all('SELECT id,name,created_at,last_seen FROM devices WHERE user_id=? AND revoked=0 ORDER BY created_at DESC', user.id) });
    }
    if (m === 'POST' && (mm = /^\/api\/v1\/devices\/(\d{1,12})\/revoke$/.exec(p))) {
      auth.checkCsrf(req, user);
      db.run('UPDATE devices SET revoked=1 WHERE id=? AND user_id=?', Number(mm[1]), user.id);
      return S.sendJson(res, 200, { ok: true });
    }
    if (m === 'GET' && p === '/api/v1/connections') return S.sendJson(res, 200, { connections: mcp.connections(user.id) });
    if (m === 'POST' && (mm = /^\/api\/v1\/connections\/(csc_[\w-]{10,40})\/revoke$/.exec(p))) {
      auth.checkCsrf(req, user); mcp.disconnect(user.id, mm[1]); return S.sendJson(res, 200, { ok: true });
    }
    if (m === 'POST' && p === '/api/v1/account/delete') {
      auth.checkCsrf(req, user);
      for (const r of db.all('SELECT id FROM missions WHERE user_id=?', user.id)) live.live.delete(r.id);
      db.run('DELETE FROM users WHERE id=?', user.id);  // cascades to everything
      S.addCookie(res, S.cookie('cs_session', '', { maxAge: 0 }));
      return S.sendJson(res, 200, { ok: true });
    }
  }
  throw new S.HttpError(404, 'not found');
}

const server = http.createServer(async (req, res) => {
  S.securityHeaders(res);
  // Behind Railway's proxy: force HTTPS
  if (cfg.TRUST_PROXY && cfg.isHttps && req.headers['x-forwarded-proto'] === 'http') {
    return S.redirect(res, cfg.PUBLIC_URL + req.url, 301);
  }
  try {
    await route(req, res);
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error('[error]', req.method, req.url.split('?')[0], err.stack || err);
    if (res.headersSent) return res.end();
    const msg = status >= 500 ? 'Something went wrong.' : err.message;
    const wantsHtml = String(req.headers.accept || '').includes('text/html') && !req.url.startsWith('/api/');
    if (wantsHtml) S.sendHtml(res, status, views.messagePage(status === 404 ? 'Not found' : 'Error', msg, 'error'));
    else S.sendJson(res, status, { error: msg });
  }
});
server.requestTimeout = 30e3;
server.headersTimeout = 15e3;
server.keepAliveTimeout = 65e3;
server.maxHeadersCount = 60;

if (require.main === module) {
  server.listen(cfg.PORT, () => console.log(`\n  ☁️  ${cfg.APP_NAME} ${cfg.VERSION} on ${cfg.PUBLIC_URL}\n`));
  const stop = () => { server.close(); try { live.flush(); db.db.close(); } catch {} process.exit(0); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
module.exports = { server };
