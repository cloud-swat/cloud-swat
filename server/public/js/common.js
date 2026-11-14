'use strict';
// Shared helpers for the signed-in pages.
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTok = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1000 ? Math.round(n / 1000) + 'k' : String(n || 0);
function ago(t) {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
}
let ME = null;
async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.method && opts.method !== 'GET' && ME) headers['X-CSRF-Token'] = ME.csrf;
  const r = await fetch(path, { credentials: 'same-origin', ...opts, headers });
  if (r.status === 401) { location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search); throw new Error('signed out'); }
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'request failed');
  return r.json();
}
async function loadMe() {
  ME = await api('/api/v1/me');
  const av = $('me-avatar');
  if (av) { if (ME.user.avatar) { av.src = ME.user.avatar; av.alt = ME.user.name; } else av.remove(); }
  const n = $('me-name'); if (n) n.textContent = ME.user.name;
  document.querySelectorAll('input[name=csrf]').forEach(i => i.value = ME.csrf);
  return ME;
}
document.querySelectorAll('.logo').forEach(e => e.innerHTML = creatureSVG('plain'));
