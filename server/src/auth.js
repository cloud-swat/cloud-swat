'use strict';
// Sign-in with GitHub or Google, web sessions and CSRF protection.
const crypto = require('node:crypto');
const cfg = require('./config');
const db = require('./db');
const S = require('./security');
const views = require('./views');

const SESSION_TTL = 30 * 24 * 3600e3;

function providers() { return { github: !!cfg.GITHUB, google: !!cfg.GOOGLE, dev: cfg.DEV_LOGIN }; }

// ---------- sessions ----------
function createSession(res, userId) {
  const token = S.randomToken('', 32);
  const now = Date.now();
  db.run('INSERT INTO web_sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)', S.sha256(token), userId, now, now + SESSION_TTL);
  S.addCookie(res, S.cookie('cs_session', token, { maxAge: SESSION_TTL }));
}
function currentUser(req) {
  if (req._user !== undefined) return req._user;
  const token = S.readCookie(req, 'cs_session');
  let user = null;
  if (token && token.length < 100) {
    const h = S.sha256(token);
    const row = db.get(`SELECT u.id,u.name,u.avatar,u.provider,s.token_hash FROM web_sessions s JOIN users u ON u.id=s.user_id
                        WHERE s.token_hash=? AND s.expires_at>?`, h, Date.now());
    if (row) user = { id: row.id, name: row.name, avatar: row.avatar, provider: row.provider, sessionHash: row.token_hash };
  }
  req._user = user;
  return user;
}
const csrfFor = user => S.hmac('csrf:' + user.sessionHash);
// For browser POSTs: correct origin AND a CSRF token tied to the session.
function checkCsrf(req, user, token) {
  if (!S.sameOrigin(req)) throw new S.HttpError(403, 'cross-site request blocked');
  const t = token || req.headers['x-csrf-token'];
  if (!t || !S.safeEqual(t, csrfFor(user))) throw new S.HttpError(403, 'invalid CSRF token');
}
function requireUser(req) {
  const u = currentUser(req);
  if (!u) throw new S.HttpError(401, 'sign in required');
  return u;
}

function upsertUser(provider, providerId, name, avatar, email) {
  const now = Date.now();
  const clean = s => (s == null ? null : String(s).slice(0, 200));
  db.run(`INSERT INTO users(provider,provider_id,name,avatar,email,created_at) VALUES(?,?,?,?,?,?)
          ON CONFLICT(provider,provider_id) DO UPDATE SET name=excluded.name, avatar=excluded.avatar, email=excluded.email`,
    provider, String(providerId), clean(name) || 'Agent', clean(avatar), clean(email), now);
  return db.get('SELECT id FROM users WHERE provider=? AND provider_id=?', provider, String(providerId)).id;
}

// ---------- OAuth login flows ----------
const AVATAR_OK = /^https:\/\/(avatars\.githubusercontent\.com|lh3\.googleusercontent\.com)\//;

function startLogin(req, res, provider, next) {
  if (!S.rateLimit('login:' + S.clientIp(req), 1, 10)) throw new S.HttpError(429, 'too many attempts');
  const state = S.randomToken('', 24);
  const verifier = S.randomToken('', 48);
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  S.addCookie(res, S.cookie('cs_oauth', S.sign({ state, verifier, next: S.safeNext(next), provider }, 10 * 60e3), { maxAge: 10 * 60e3 }));
  const redirect_uri = `${cfg.PUBLIC_URL}/auth/${provider}/callback`;
  let url;
  if (provider === 'github') {
    url = 'https://github.com/login/oauth/authorize?' + new URLSearchParams({
      client_id: cfg.GITHUB.id, redirect_uri, scope: 'read:user', state, allow_signup: 'true',
      code_challenge: challenge, code_challenge_method: 'S256' });
  } else {
    url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
      client_id: cfg.GOOGLE.id, redirect_uri, response_type: 'code', scope: 'openid profile email', state,
      code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account' });
  }
  S.redirect(res, url);
}

async function fetchJson(url, opts) {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new S.HttpError(502, 'sign-in provider error');
  return r.json();
}

async function finishLogin(req, res, provider, query) {
  const saved = S.unsign(S.readCookie(req, 'cs_oauth'));
  S.addCookie(res, S.cookie('cs_oauth', '', { maxAge: 0 }));
  if (query.get('error')) return S.redirect(res, '/login?error=cancelled');
  const code = query.get('code'), state = query.get('state');
  if (!saved || saved.provider !== provider || !code || !state || !S.safeEqual(state, saved.state)) {
    return S.sendHtml(res, 400, views.messagePage('Sign-in expired', 'Please try signing in again.', 'error'));
  }
  const redirect_uri = `${cfg.PUBLIC_URL}/auth/${provider}/callback`;
  let userId;
  if (provider === 'github') {
    const tok = await fetchJson('https://github.com/login/oauth/access_token', {
      method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: cfg.GITHUB.id, client_secret: cfg.GITHUB.secret, code, redirect_uri, code_verifier: saved.verifier }) });
    if (!tok.access_token) throw new S.HttpError(401, 'GitHub sign-in failed');
    const u = await fetchJson('https://api.github.com/user', { headers: { Authorization: `Bearer ${tok.access_token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'cloud-swat' } });
    if (!u.id) throw new S.HttpError(401, 'GitHub sign-in failed');
    userId = upsertUser('github', u.id, u.name || u.login, AVATAR_OK.test(u.avatar_url || '') ? u.avatar_url : null, null);
  } else {
    const tok = await fetchJson('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: cfg.GOOGLE.id, client_secret: cfg.GOOGLE.secret, code, redirect_uri, grant_type: 'authorization_code', code_verifier: saved.verifier }) });
    if (!tok.access_token) throw new S.HttpError(401, 'Google sign-in failed');
    const u = await fetchJson('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${tok.access_token}` } });
    if (!u.sub) throw new S.HttpError(401, 'Google sign-in failed');
    userId = upsertUser('google', u.sub, u.name || (u.email || '').split('@')[0], AVATAR_OK.test(u.picture || '') ? u.picture : null, u.email);
  }
  createSession(res, userId);
  S.redirect(res, S.safeNext(saved.next));
}

// Local testing only (see config.DEV_LOGIN).
function devLogin(req, res, next, as) {
  if (!cfg.DEV_LOGIN) throw new S.HttpError(404, 'not found');
  const n = ['1', '2'].includes(as) ? as : '1';
  const userId = upsertUser('dev', 'dev-' + n, 'Dev User ' + n, null, null);
  createSession(res, userId);
  S.redirect(res, S.safeNext(next));
}

async function logout(req, res) {
  const user = requireUser(req);
  const form = await S.readForm(req);
  checkCsrf(req, user, form.csrf);
  db.run('DELETE FROM web_sessions WHERE token_hash=?', user.sessionHash);
  S.addCookie(res, S.cookie('cs_session', '', { maxAge: 0 }));
  S.redirect(res, '/', 303);
}

module.exports = { providers, currentUser, requireUser, csrfFor, checkCsrf, startLogin, finishLogin, devLogin, logout };
