'use strict';
// End-to-end security tests. Starts a real server on a random port with a temp database.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const PORT = 47000 + Math.floor(Math.random() * 1000);
const BASE = `http://localhost:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-test-'));
let proc;

before(async () => {
  proc = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'src', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: path.join(TMP, 'db.sqlite'), DEV_LOGIN: '1', PUBLIC_URL: BASE, NODE_ENV: 'test',
      SESSION_SECRET: crypto.randomBytes(32).toString('hex') }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/healthz')).ok) return; } catch {} await new Promise(r => setTimeout(r, 100)); }
  throw new Error('server did not start');
});
after(() => { proc.kill(); fs.rmSync(TMP, { recursive: true, force: true }); });

// --- tiny browser: keeps cookies, does not follow redirects ---
function browser() {
  const jar = new Map();
  async function req(p, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const r = await fetch(BASE + p, { redirect: 'manual', ...opts, headers });
    for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); const k = kv.slice(0, i), v = kv.slice(i + 1); if (v) jar.set(k, v); else jar.delete(k); }
    return r;
  }
  return { req, jar,
    async login(as = '1') { const r = await req(`/auth/dev?as=${as}&next=/app`); assert.equal(r.status, 302); this.me = await (await req('/api/v1/me')).json(); return this; },
    post(p, body, extra = {}) {
      return req(p, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE, 'X-CSRF-Token': this.me?.csrf || '', ...extra }, body: JSON.stringify(body) });
    },
    form(p, obj, extra = {}) {
      return req(p, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: BASE, ...extra }, body: new URLSearchParams(obj).toString() });
    },
  };
}
const json = (p, body, headers = {}) => fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

// Links a device for a signed-in browser and returns its token
async function linkDevice(b) {
  const s = await (await json('/api/v1/device/start', { name: 'test-pc' })).json();
  const page = await (await b.req('/link?code=' + s.user_code)).text();
  const state = /name="state" value="([^"]+)"/.exec(page)[1];
  const r = await b.form('/link', { code: s.user_code, csrf: b.me.csrf, state, decision: 'approve' });
  assert.equal(r.status, 303);
  await new Promise(r => setTimeout(r, 2100));
  const t = await (await json('/api/v1/device/token', { device_code: s.device_code })).json();
  assert.ok(t.device_token?.startsWith('cst_'));
  return t.device_token;
}

// ---------------- headers & basics ----------------
test('security headers on every response', async () => {
  for (const p of ['/', '/login', '/api/v1/config', '/nope']) {
    const r = await fetch(BASE + p);
    assert.match(r.headers.get('content-security-policy'), /script-src 'self'; style-src 'self'/);
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  }
});

test('no inline scripts or inline styles in pages (CSP stays strict)', async () => {
  for (const f of ['index.html', 'mission.html', 'app.html', 'account.html']) {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
    assert.doesNotMatch(html, /<script>(?!<\/script>)|<script(?![^>]*\bsrc=)[^>]*>/, f + ' has inline script');
    assert.doesNotMatch(html, /\sstyle=/, f + ' has inline style');
    assert.doesNotMatch(html, /\son\w+=/, f + ' has inline handler');
  }
});

test('signed-in pages and APIs require login', async () => {
  assert.equal((await fetch(BASE + '/api/v1/me')).status, 401);
  assert.equal((await fetch(BASE + '/api/v1/missions')).status, 401);
  const r = await fetch(BASE + '/app', { redirect: 'manual' });
  assert.equal(r.status, 302);
  assert.match(r.headers.get('location'), /^\/login\?next=/);
});

test('session cookie is HttpOnly and SameSite', async () => {
  const r = await fetch(BASE + '/auth/dev?next=/app', { redirect: 'manual' });
  const c = r.headers.getSetCookie().find(x => x.startsWith('cs_session='));
  assert.match(c, /HttpOnly/); assert.match(c, /SameSite=Lax/);
});

test('open redirects are blocked', async () => {
  for (const next of ['//evil.com', 'https://evil.com', '/\\evil.com', '/%0d%0aSet-Cookie:x=1', 'javascript:alert(1)']) {
    const r = await fetch(BASE + '/auth/dev?next=' + encodeURIComponent(next), { redirect: 'manual' });
    const loc = r.headers.get('location');
    assert.ok(loc.startsWith('/') && !loc.startsWith('//') && !loc.includes('evil') && !/[\r\n]/.test(loc), `next=${next} -> ${loc}`);
  }
});

test('static files cannot escape the public folder', async () => {
  for (const p of ['/js/../src/config.js', '/js/..%2fsrc%2fconfig.js', '/css/%2e%2e/%2e%2e/package.json', '/js/.env']) {
    const r = await fetch(BASE + p);
    assert.equal(r.status, 404, p);
  }
});

// ---------------- device linking ----------------
test('device link: CSRF, cross-site and single-use protections', async () => {
  const b = await browser().login();
  const s = await (await json('/api/v1/device/start', { name: '<script>x</script>' })).json();
  assert.match(s.user_code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  const pending = await (await json('/api/v1/device/token', { device_code: s.device_code })).json();
  assert.equal(pending.error, 'authorization_pending');

  const page = await (await b.req('/link?code=' + s.user_code)).text();
  assert.ok(!page.includes('<script>x'), 'device name must be escaped/cleaned');
  const state = /name="state" value="([^"]+)"/.exec(page)[1];
  // missing CSRF
  assert.equal((await b.form('/link', { code: s.user_code, state, decision: 'approve' })).status, 403);
  // cross-site origin
  assert.equal((await b.form('/link', { code: s.user_code, csrf: b.me.csrf, state, decision: 'approve' }, { Origin: 'https://evil.com' })).status, 403);
  // wrong state (form for another code)
  assert.equal((await b.form('/link', { code: s.user_code, csrf: b.me.csrf, state: 'x', decision: 'approve' })).status, 403);
  // valid
  const ok = await b.form('/link', { code: s.user_code, csrf: b.me.csrf, state, decision: 'approve' });
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.get('location'), '/app?follow=1&linked=1');
  await new Promise(r => setTimeout(r, 2100));
  const t = await (await json('/api/v1/device/token', { device_code: s.device_code })).json();
  assert.ok(t.device_token);
  await new Promise(r => setTimeout(r, 2100));
  const again = await (await json('/api/v1/device/token', { device_code: s.device_code })).json();
  assert.equal(again.error, 'invalid_grant', 'device token must be issued only once');
});

// ---------------- events & isolation ----------------
test('events: auth, validation, secret redaction, limits', async () => {
  const b = await browser().login('1');
  const token = await linkDevice(b);
  assert.equal((await json('/api/v1/events', { session: 's1', events: [{ type: 'mission', text: 'x' }] })).status, 401);
  assert.equal((await json('/api/v1/events', { session: 's1', events: [] }, { Authorization: 'Bearer cst_fake_token_value_123456789' })).status, 401);

  const evil = [
    { type: 'mission', text: 'Audit <img src=x onerror=alert(1)>' },
    { type: 'spawn', agentType: 'swat-hawk', description: 'hunt' },
    { type: 'tool', agentKey: 'swat-hawk', summary: 'Bash curl -H "Authorization: token=ghp_abcdefghijklmnopqrstuvwxyz0123456789" api' },
    { type: 'tool', agentKey: 'swat-hawk', summary: 'Bash export ANTHROPIC_API_KEY=sk-ant-api03-SECRETSECRETSECRET' },
    { type: 'tool', agentKey: 'swat-hawk', summary: 'Bash mysql --password=hunter2 db' },
    { type: 'evil_type', text: 'ignored' },
    { type: 'agent_done', agentType: '../../etc', findings: [{ sev: 'nuclear', title: 'bad' }, { sev: 'high', title: 'SQLi', where: 'a.js:1' }] },
  ];
  const r = await json('/api/v1/events', { session: 's1', events: evil }, { Authorization: 'Bearer ' + token });
  assert.equal(r.status, 200);
  const { mission } = await r.json();
  const st = await (await b.req('/api/v1/missions/' + mission)).json();
  const blob = JSON.stringify(st);
  assert.ok(!blob.includes('ghp_abcdefghij'), 'GitHub token leaked');
  assert.ok(!blob.includes('sk-ant-api03'), 'API key leaked');
  assert.ok(!blob.includes('hunter2'), 'password leaked');
  assert.ok(!blob.includes('evil_type') && !blob.includes('nuclear'));
  assert.ok(!st.order.includes('../../etc'), 'bad agent key accepted');

  // too big / wrong type / bad json
  assert.equal((await json('/api/v1/events', { session: 's1', events: [{ type: 'tool', summary: 'x'.repeat(70000) }] }, { Authorization: 'Bearer ' + token })).status, 413);
  assert.equal((await fetch(BASE + '/api/v1/events', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await fetch(BASE + '/api/v1/events', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: '{bad' })).status, 400);
  assert.equal((await json('/api/v1/events', { session: '../../x', events: [{ type: 'mission' }] }, { Authorization: 'Bearer ' + token })).status, 400);

  // another user can't see, stream or delete it
  const other = await browser().login('2');
  assert.equal((await other.req('/api/v1/missions/' + mission)).status, 404);
  assert.equal((await other.req('/api/v1/missions/' + mission + '/stream')).status, 404);
  assert.equal((await other.req('/api/v1/missions/' + mission, { method: 'DELETE', headers: { Origin: BASE, 'X-CSRF-Token': other.me.csrf } })).status, 404);
  assert.ok(!(await (await other.req('/api/v1/missions')).text()).includes(mission));

  // owner: delete needs CSRF + same origin
  assert.equal((await b.req('/api/v1/missions/' + mission, { method: 'DELETE', headers: { Origin: BASE } })).status, 403);
  assert.equal((await b.req('/api/v1/missions/' + mission, { method: 'DELETE', headers: { Origin: 'https://evil.com', 'X-CSRF-Token': b.me.csrf } })).status, 403);
  assert.equal((await b.req('/api/v1/missions/' + mission, { method: 'DELETE', headers: { Origin: BASE, 'X-CSRF-Token': b.me.csrf } })).status, 200);
});

test('revoked device is rejected', async () => {
  const b = await browser().login('1');
  const token = await linkDevice(b);
  const { devices } = await (await b.req('/api/v1/devices')).json();
  const id = devices[0].id;
  assert.equal((await b.post(`/api/v1/devices/${id}/revoke`, {})).status, 200);
  assert.equal((await json('/api/v1/events', { session: 's2', events: [{ type: 'mission', text: 'x' }] }, { Authorization: 'Bearer ' + token })).status, 401);
});

// ---------------- MCP + OAuth ----------------
test('MCP: OAuth flow, PKCE, isolation and tools', async () => {
  const unauth = await json('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal(unauth.status, 401);
  assert.match(unauth.headers.get('www-authenticate'), /resource_metadata=/);
  assert.equal((await (await fetch(BASE + '/.well-known/oauth-authorization-server')).json()).code_challenge_methods_supported[0], 'S256');

  for (const bad of ['javascript:alert(1)', 'http://evil.com/cb', 'ftp://x/y', 'https://ok.com/cb#frag']) {
    assert.equal((await json('/oauth/register', { client_name: 'x', redirect_uris: [bad] })).status, 400, bad);
  }
  const reg = await (await json('/oauth/register', { client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] })).json();
  const verifier = crypto.randomBytes(40).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const params = { response_type: 'code', client_id: reg.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', state: 'st8',
    code_challenge: challenge, code_challenge_method: 'S256', scope: 'missions' };

  const b = await browser().login('1');
  // unregistered redirect: error page, never a redirect to the attacker
  const evil = await b.req('/oauth/authorize?' + new URLSearchParams({ ...params, redirect_uri: 'https://evil.com/cb' }));
  assert.equal(evil.status, 400);
  assert.equal(evil.headers.get('location'), null);

  const consent = await b.req('/oauth/authorize?' + new URLSearchParams(params));
  assert.equal(consent.status, 200);
  assert.match(consent.headers.get('content-security-policy'), /form-action 'self' https:\/\/claude\.ai/);
  // consent without CSRF
  assert.equal((await b.form('/oauth/authorize', { ...params, decision: 'approve' })).status, 403);
  const ok = await b.form('/oauth/authorize', { ...params, decision: 'approve', csrf: b.me.csrf });
  assert.equal(ok.status, 303);
  const back = new URL(ok.headers.get('location'));
  assert.equal(back.origin, 'https://claude.ai'); assert.equal(back.searchParams.get('state'), 'st8');
  const code = back.searchParams.get('code');

  const form = o => fetch(BASE + '/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o) });
  const wrong = await form({ grant_type: 'authorization_code', code, redirect_uri: params.redirect_uri, client_id: reg.client_id, code_verifier: crypto.randomBytes(40).toString('base64url') });
  assert.equal((await wrong.json()).error, 'invalid_grant', 'wrong PKCE verifier must fail');
  const reuse = await form({ grant_type: 'authorization_code', code, redirect_uri: params.redirect_uri, client_id: reg.client_id, code_verifier: verifier });
  assert.equal((await reuse.json()).error, 'invalid_grant', 'a code is single-use, even after a failed attempt');

  // fresh code, correct exchange
  const ok2 = await b.form('/oauth/authorize', { ...params, decision: 'approve', csrf: b.me.csrf });
  const code2 = new URL(ok2.headers.get('location')).searchParams.get('code');
  const tok = await (await form({ grant_type: 'authorization_code', code: code2, redirect_uri: params.redirect_uri, client_id: reg.client_id, code_verifier: verifier })).json();
  assert.ok(tok.access_token?.startsWith('csa_') && tok.refresh_token);

  const rpc = (body, t = tok.access_token, h = {}) => json('/mcp', body, { Authorization: 'Bearer ' + t, ...h });
  const init = await (await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })).json();
  assert.equal(init.result.serverInfo.name, 'cloud-swat');
  const tools = await (await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json();
  assert.equal(tools.result.tools.length, 4);
  const notif = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(notif.status, 202);
  const stats = await (await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'swat_stats', arguments: { days: 7 } } })).json();
  assert.match(stats.result.content[0].text, /missions/);
  const saved = await (await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'swat_report', arguments: { title: 'Chat audit', findings: [{ sev: 'high', title: 'XSS', where: 'a.js' }] } } })).json();
  assert.match(saved.result.content[0].text, /saved: /);

  // user 2's mission is invisible to user 1's MCP token
  const b2 = await browser().login('2');
  const t2 = await linkDevice(b2);
  const m2 = (await (await json('/api/v1/events', { session: 'x', events: [{ type: 'mission', text: 'secret mission' }] }, { Authorization: 'Bearer ' + t2 })).json()).mission;
  const leak = await (await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'swat_findings', arguments: { mission: m2 } } })).json();
  assert.equal(leak.result.isError, true);

  // device tokens can't use MCP; foreign Origin blocked
  assert.equal((await rpc({ jsonrpc: '2.0', id: 6, method: 'tools/list' }, t2)).status, 401);
  assert.equal((await rpc({ jsonrpc: '2.0', id: 7, method: 'tools/list' }, tok.access_token, { Origin: 'https://evil.com' })).status, 403);

  // refresh rotation
  const r1 = await (await form({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: reg.client_id })).json();
  assert.ok(r1.access_token);
  const r2 = await (await form({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: reg.client_id })).json();
  assert.equal(r2.error, 'invalid_grant', 'old refresh token must stop working');

  // disconnect from account page revokes access
  const { connections } = await (await b.req('/api/v1/connections')).json();
  assert.equal((await b.post(`/api/v1/connections/${connections[0].client_id}/revoke`, {})).status, 200);
  assert.equal((await rpc({ jsonrpc: '2.0', id: 8, method: 'tools/list' }, r1.access_token)).status, 401);
});

test('account deletion removes everything', async () => {
  const b = await browser().login('2');
  assert.equal((await b.post('/api/v1/account/delete', {})).status, 200);
  assert.equal((await b.req('/api/v1/me')).status, 401);
});

// runs last: it exhausts the device-start limit for this IP
test('rate limit on device start', async () => {
  let limited = false;
  for (let i = 0; i < 12; i++) if ((await json('/api/v1/device/start', { name: 'spam' })).status === 429) limited = true;
  assert.ok(limited);
});
