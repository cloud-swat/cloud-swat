'use strict';
// Device linking, like "gh auth login": Claude Code asks for a code, you approve it in the browser,
// and the device receives its own token. No keys to copy.
const crypto = require('node:crypto');
const cfg = require('./config');
const db = require('./db');
const S = require('./security');
const auth = require('./auth');
const views = require('./views');

const CODE_TTL = 10 * 60e3;
const POLL_INTERVAL = 2;           // seconds
const ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ23456789'; // no vowels (no accidental words), no 0/O/1/I

function userCode() {
  const b = crypto.randomBytes(8); let s = '';
  for (let i = 0; i < 8; i++) s += ALPHABET[b[i] % ALPHABET.length];
  return s.slice(0, 4) + '-' + s.slice(4);
}
const normCode = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^(.{4})(.{4})$/, '$1-$2');

// POST /api/v1/device/start  { name }
async function start(req, res) {
  if (!S.rateLimit('dstart:' + S.clientIp(req), 0.2, 5)) throw new S.HttpError(429, 'too many requests');
  const body = await S.readJson(req, 2048);
  const name = String(body.name || 'My computer').replace(/[^\w .()'-]/g, '').slice(0, 40) || 'My computer';
  const deviceCode = S.randomToken('csd_', 32);
  let code;
  for (let i = 0; i < 5; i++) { code = userCode(); if (!db.get('SELECT 1 FROM device_codes WHERE user_code=?', code)) break; }
  const now = Date.now();
  db.run('INSERT INTO device_codes(device_code_hash,user_code,device_name,created_at,expires_at) VALUES(?,?,?,?,?)',
    S.sha256(deviceCode), code, name, now, now + CODE_TTL);
  S.sendJson(res, 200, {
    device_code: deviceCode, user_code: code, interval: POLL_INTERVAL, expires_in: CODE_TTL / 1000,
    verification_uri: `${cfg.PUBLIC_URL}/link`,
    verification_uri_complete: `${cfg.PUBLIC_URL}/link?code=${encodeURIComponent(code)}`,
  });
}

// POST /api/v1/device/token  { device_code }
async function token(req, res) {
  if (!S.rateLimit('dtoken:' + S.clientIp(req), 2, 20)) throw new S.HttpError(429, 'too many requests');
  const body = await S.readJson(req, 2048);
  const dc = String(body.device_code || '');
  if (!dc.startsWith('csd_') || dc.length > 80) return S.sendJson(res, 400, { error: 'invalid_grant' });
  const h = S.sha256(dc);
  const row = db.get('SELECT * FROM device_codes WHERE device_code_hash=?', h);
  const now = Date.now();
  if (!row || row.status === 'consumed') return S.sendJson(res, 400, { error: 'invalid_grant' });
  if (row.expires_at < now) return S.sendJson(res, 400, { error: 'expired_token' });
  if (row.status === 'denied') return S.sendJson(res, 400, { error: 'access_denied' });
  if (now - row.last_poll < (POLL_INTERVAL * 1000) - 300) {
    db.run('UPDATE device_codes SET last_poll=? WHERE device_code_hash=?', now, h);
    return S.sendJson(res, 400, { error: 'slow_down' });
  }
  db.run('UPDATE device_codes SET last_poll=? WHERE device_code_hash=?', now, h);
  if (row.status !== 'approved') return S.sendJson(res, 400, { error: 'authorization_pending' });

  // Approved: hand out the device token exactly once.
  const deviceToken = S.randomToken('cst_', 32);
  const deviceId = db.tx(() => {
    const ok = db.run("UPDATE device_codes SET status='consumed' WHERE device_code_hash=? AND status='approved'", h);
    if (!ok.changes) throw new S.HttpError(400, 'invalid_grant');
    return db.run('INSERT INTO devices(user_id,name,token_hash,created_at,last_seen) VALUES(?,?,?,?,?)',
      row.user_id, row.device_name, S.sha256(deviceToken), now, now).lastInsertRowid;
  });
  const user = db.get('SELECT name FROM users WHERE id=?', row.user_id);
  S.sendJson(res, 200, { device_token: deviceToken, device_id: Number(deviceId), user: { name: user.name }, live_url: `${cfg.PUBLIC_URL}/app?follow=1` });
}

// GET /link?code=XXXX-XXXX
function page(req, res, query) {
  if (!S.rateLimit('linkpage:' + S.clientIp(req), 1, 20)) throw new S.HttpError(429, 'too many requests');
  const user = auth.currentUser(req);
  const code = normCode(query.get('code'));
  if (!user) return S.redirect(res, '/login?next=' + encodeURIComponent('/link' + (code ? '?code=' + code : '')));
  const row = code && db.get('SELECT * FROM device_codes WHERE user_code=?', code);
  if (!row || row.expires_at < Date.now() || row.status !== 'pending') {
    return S.sendHtml(res, 400, views.linkPage({ error: 'This link has expired or was already used.' }));
  }
  // Bind the approval form to this exact code
  const state = S.hmac('link:' + code + ':' + user.sessionHash);
  S.sendHtml(res, 200, views.linkPage({ code, deviceName: row.device_name, csrf: auth.csrfFor(user), state }));
}

// POST /link  (form)
async function decide(req, res) {
  const user = auth.requireUser(req);
  const form = await S.readForm(req);
  auth.checkCsrf(req, user, form.csrf);
  if (!S.rateLimit('link:' + user.id, 0.5, 10)) throw new S.HttpError(429, 'too many attempts');
  const code = normCode(form.code);
  if (!S.safeEqual(String(form.state || ''), S.hmac('link:' + code + ':' + user.sessionHash))) throw new S.HttpError(403, 'invalid request');
  const row = db.get("SELECT * FROM device_codes WHERE user_code=? AND status='pending' AND expires_at>?", code, Date.now());
  if (!row) return S.sendHtml(res, 400, views.linkPage({ error: 'This link has expired or was already used.' }));
  if (form.decision === 'approve') {
    db.run("UPDATE device_codes SET status='approved', user_id=? WHERE user_code=? AND status='pending'", user.id, code);
    return S.redirect(res, '/app?follow=1&linked=1', 303);   // opens straight into the live view
  }
  db.run("UPDATE device_codes SET status='denied' WHERE user_code=? AND status='pending'", code);
  S.sendHtml(res, 200, views.messagePage('Device not linked', 'Nothing was shared. You can close this tab.'));
}

// Authenticate a device by its bearer token (used by the hooks and by MCP).
function deviceFromRequest(req) {
  const m = /^Bearer (cst_[A-Za-z0-9_-]{20,80})$/.exec(String(req.headers.authorization || ''));
  if (!m) return null;
  const d = db.get('SELECT id,user_id,name FROM devices WHERE token_hash=? AND revoked=0', S.sha256(m[1]));
  if (d) {
    const now = Date.now();
    if (!d._seen) db.run('UPDATE devices SET last_seen=? WHERE id=? AND (last_seen IS NULL OR last_seen<?)', now, d.id, now - 60e3);
  }
  return d || null;
}

module.exports = { start, token, page, decide, deviceFromRequest };
