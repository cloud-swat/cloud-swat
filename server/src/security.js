'use strict';
const crypto = require('node:crypto');
const cfg = require('./config');

// ---------- tokens & hashing ----------
const randomToken = (prefix = '', bytes = 32) => prefix + crypto.randomBytes(bytes).toString('base64url');
const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('base64url');
const hmac = s => crypto.createHmac('sha256', cfg.SECRET).update(String(s)).digest('base64url');
function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Signed, short-lived values (used for the OAuth login state cookie)
function sign(obj, ttlMs) {
  const body = Buffer.from(JSON.stringify({ ...obj, exp: Date.now() + ttlMs })).toString('base64url');
  return body + '.' + hmac(body);
}
function unsign(value) {
  if (typeof value !== 'string') return null;
  const i = value.lastIndexOf('.');
  if (i < 1) return null;
  const body = value.slice(0, i), mac = value.slice(i + 1);
  if (!safeEqual(mac, hmac(body))) return null;
  try { const o = JSON.parse(Buffer.from(body, 'base64url').toString()); return o.exp > Date.now() ? o : null; } catch { return null; }
}

// ---------- cookies ----------
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('='); if (i < 0) continue;
    const k = part.slice(0, i).trim(); if (!k || k in out) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch {}
  }
  return out;
}
const COOKIE_PREFIX = cfg.isHttps ? '__Host-' : '';  // __Host- = Secure, path=/, no Domain
function cookie(name, value, { maxAge, sameSite = 'Lax' } = {}) {
  let c = `${COOKIE_PREFIX}${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=${sameSite}`;
  if (cfg.isHttps) c += '; Secure';
  if (maxAge !== undefined) c += `; Max-Age=${Math.floor(maxAge / 1000)}`;
  return c;
}
const readCookie = (req, name) => parseCookies(req)[COOKIE_PREFIX + name];
function addCookie(res, c) {
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', prev ? [].concat(prev, c) : [c]);
}

// ---------- security headers ----------
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: https://avatars.githubusercontent.com https://lh3.googleusercontent.com",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');
function securityHeaders(res) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (cfg.isHttps) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

// ---------- client IP & rate limiting ----------
function clientIp(req) {
  if (cfg.TRUST_PROXY) {
    // The proxy appends the real client IP last; earlier entries can be forged by the client.
    const parts = String(req.headers['x-forwarded-for'] || '').split(',').map(x => x.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return req.socket.remoteAddress || 'unknown';
}
const buckets = new Map();
// Token bucket: `rate` requests refilled per second, up to `burst`.
function rateLimit(key, rate, burst) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b) { b = { t: burst, ts: now }; buckets.set(key, b); }
  b.t = Math.min(burst, b.t + (now - b.ts) / 1000 * rate); b.ts = now;
  if (b.t < 1) return false;
  b.t -= 1; return true;
}
setInterval(() => { const cut = Date.now() - 10 * 60e3; for (const [k, b] of buckets) if (b.ts < cut) buckets.delete(k); }, 60e3).unref();

// ---------- request / response helpers ----------
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const len = Number(req.headers['content-length'] || 0);
    if (len > limit) return reject(new HttpError(413, 'payload too large'));
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new HttpError(413, 'payload too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
async function readJson(req, limit) {
  const ct = String(req.headers['content-type'] || '');
  if (!ct.includes('application/json')) throw new HttpError(415, 'expected application/json');
  const raw = await readBody(req, limit);
  try { const v = JSON.parse(raw || 'null'); if (v === null || typeof v !== 'object') throw 0; return v; }
  catch { throw new HttpError(400, 'invalid JSON'); }
}
async function readForm(req, limit = 16 * 1024) {
  const ct = String(req.headers['content-type'] || '');
  const raw = await readBody(req, limit);
  if (ct.includes('application/json')) { try { return JSON.parse(raw || '{}'); } catch { throw new HttpError(400, 'invalid JSON'); } }
  return Object.fromEntries(new URLSearchParams(raw));
}

function sendJson(res, status, obj, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
  res.end(JSON.stringify(obj));
}
function sendHtml(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}
function redirect(res, location, status = 302) { res.writeHead(status, { Location: location, 'Cache-Control': 'no-store' }); res.end(); }

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Only allow same-site relative paths after login (blocks open redirects like //evil.com or /\evil.com)
function safeNext(next, fallback = '/app') {
  if (typeof next !== 'string' || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return fallback;
  if (/[\r\n\t]/.test(next) || next.length > 512) return fallback;
  try { const u = new URL(next, cfg.ORIGIN); return u.origin === cfg.ORIGIN ? u.pathname + u.search : fallback; } catch { return fallback; }
}

// Browser requests that change something must come from our own pages.
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (origin) return origin === cfg.ORIGIN;
  const ref = req.headers.referer;
  if (ref) { try { return new URL(ref).origin === cfg.ORIGIN; } catch { return false; } }
  return false;
}

// Remove secrets that may appear in commands or search text before anything is sent or stored.
const SECRET_PATTERNS = [
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, /\bsk-ant-[A-Za-z0-9_-]{10,}/g, /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g, /\bAKIA[0-9A-Z]{16}\b/g, /\bxox[abpr]-[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /((?:password|passwd|pwd|secret|token|api[_-]?key|auth)\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi,
  /\b[A-Fa-f0-9]{40,}\b/g, /\b[A-Za-z0-9+/_-]{48,}={0,2}/g,
];
function redact(s) {
  let out = String(s ?? '');
  for (const re of SECRET_PATTERNS) out = out.replace(re, (m, p1) => (typeof p1 === 'string' && /[=:]\s*$/.test(p1) ? p1 + '[redacted]' : '[redacted]'));
  return out;
}

// Consent page only: let the approval form redirect back to the registered app.
function allowFormTarget(res, origin) {
  res.setHeader('Content-Security-Policy', CSP.replace("form-action 'self'", `form-action 'self' ${origin}`));
}

module.exports = {
  allowFormTarget, randomToken, sha256, hmac, safeEqual, sign, unsign,
  parseCookies, cookie, readCookie, addCookie, COOKIE_PREFIX,
  securityHeaders, clientIp, rateLimit,
  HttpError, readBody, readJson, readForm, sendJson, sendHtml, redirect, esc, safeNext, sameOrigin, redact,
};
