#!/usr/bin/env node
// Cloud SWAT hook. Runs outside the model (zero tokens) on Claude Code hook events:
//  1. links this computer to your account once (browser opens, you approve), then
//  2. streams crew activity to your live dashboard.
// It never blocks Claude: every failure is silent and it always exits 0.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const DIR = path.join(os.homedir(), '.cloud-swat');
const SPAWN_TOOLS = new Set(['Task', 'Agent']);
const TRIGGER = /\b(crew|swat)\b|فريق|التيم|تيم/i;
const ALWAYS = process.env.CLOUD_SWAT_ALWAYS === '1';

function baseUrl() {
  let url = process.env.CLOUD_SWAT_URL;
  if (!url) { try { url = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8')).url; } catch {} }
  url = String(url || '').replace(/\/+$/, '');
  return /^https:\/\/[\w.-]+(:\d+)?$/.test(url) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(url) ? url : null;
}
const BASE = baseUrl();

// ---------- small file store (only readable by you) ----------
function ensureDir() { try { fs.mkdirSync(DIR, { recursive: true, mode: 0o700 }); } catch {} }
function readJson(name) { try { return JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8')); } catch { return null; } }
function writeJson(name, obj) { ensureDir(); try { fs.writeFileSync(path.join(DIR, name), JSON.stringify(obj), { mode: 0o600 }); } catch {} }
function remove(name) { try { fs.unlinkSync(path.join(DIR, name)); } catch {} }
const sessionFile = id => `session-${String(id || 'default').replace(/[^\w-]/g, '').slice(0, 80)}.json`;

// ---------- network ----------
function serverLooksDown() { try { return Date.now() - fs.statSync(path.join(DIR, 'down')).mtimeMs < 30000; } catch { return false; } }
async function call(pathname, body, { token, timeout = 1500 } = {}) {
  if (!BASE || serverLooksDown()) return null;
  try {
    const r = await fetch(BASE + pathname, {
      method: 'POST', signal: AbortSignal.timeout(timeout),
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  } catch {
    ensureDir(); try { fs.writeFileSync(path.join(DIR, 'down'), ''); } catch {}
    return null;
  }
}

function openBrowser(url) {
  if (!url.startsWith(BASE + '/')) return;
  try {
    const p = process.platform;
    const [cmd, args] = p === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : p === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});   // no browser opener available: the link is still printed
    child.unref();
  } catch {}
}

// ---------- device linking ----------
function linkedDevice() {
  const d = readJson('device.json');
  return d && d.url === BASE && typeof d.token === 'string' && d.token.startsWith('cst_') ? d : null;
}
async function pollLink(messages) {
  const p = readJson('pending.json');
  if (!p || p.url !== BASE) return null;
  if (Date.now() > p.expires) { remove('pending.json'); return null; }
  if (Date.now() - (p.lastPoll || 0) < 2500) return null;
  p.lastPoll = Date.now(); writeJson('pending.json', p);
  const r = await call('/api/v1/device/token', { device_code: p.device_code }, { timeout: 2500 });
  if (!r) return null;
  if (r.status === 200 && r.body.device_token) {
    const d = { url: BASE, token: r.body.device_token, user: r.body.user?.name || '' };
    writeJson('device.json', d); remove('pending.json');
    messages.push(`☁️ Cloud SWAT linked${d.user ? ' to ' + d.user : ''}. Your live view: ${BASE}/app?follow=1`);
    return d;
  }
  if (['access_denied', 'expired_token', 'invalid_grant'].includes(r.body.error)) remove('pending.json');
  return null;
}
async function startLink(messages, { auto }) {
  const pending = readJson('pending.json');
  if (pending && pending.url === BASE && Date.now() < pending.expires) {
    messages.push(`☁️ Link Cloud SWAT: ${pending.uri}  (code ${pending.user_code})`);
    return;
  }
  const name = os.hostname().replace(/[^\w .-]/g, '').slice(0, 40) || 'My computer';
  const r = await call('/api/v1/device/start', { name }, { timeout: 2500 });
  if (!r || r.status !== 200 || !r.body.device_code) return;
  const b = r.body;
  const lastOpen = readJson('opened.json')?.t || 0;
  writeJson('pending.json', { url: BASE, device_code: b.device_code, user_code: b.user_code, uri: b.verification_uri_complete,
    expires: Date.now() + (b.expires_in || 600) * 1000, lastPoll: Date.now() });
  // Open the browser automatically at most once a day; otherwise just show the link.
  if (auto && Date.now() - lastOpen > 24 * 3600e3) { writeJson('opened.json', { t: Date.now() }); openBrowser(b.verification_uri_complete); }
  messages.push(`☁️ Link Cloud SWAT to watch your crew live: ${b.verification_uri_complete}  (code ${b.user_code})`);
}

// ---------- summaries (secrets removed before anything leaves your computer) ----------
const SECRET_PATTERNS = [
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, /\bsk-ant-[A-Za-z0-9_-]{10,}/g, /\bgh[pousr]_[A-Za-z0-9]{20,}/g, /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g, /\bxox[abpr]-[A-Za-z0-9-]{10,}/g, /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /((?:password|passwd|pwd|secret|token|api[_-]?key|auth)\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi,
  /\b[A-Fa-f0-9]{40,}\b/g, /\b[A-Za-z0-9+/_-]{48,}={0,2}/g,
];
function redact(s) {
  let out = String(s ?? '');
  for (const re of SECRET_PATTERNS) out = out.replace(re, (m, p1) => (typeof p1 === 'string' && /[=:]\s*$/.test(p1) ? p1 + '[redacted]' : '[redacted]'));
  return out;
}
const short = (s, n = 70) => { s = redact(s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
function rel(p, cwd) { if (!p) return ''; try { const r = path.relative(cwd || process.cwd(), p); return r && !r.startsWith('..') ? r : path.basename(p); } catch { return ''; } }
function summarize(name, i = {}, cwd) {
  switch (name) {
    case 'Read': return `Read ${rel(i.file_path, cwd)}`;
    case 'Edit': case 'MultiEdit': return `Edit ${rel(i.file_path, cwd)}`;
    case 'Write': return `Write ${rel(i.file_path, cwd)}`;
    case 'Grep': return `Grep "${short(i.pattern, 40)}"${i.path ? ' in ' + rel(i.path, cwd) : ''}`;
    case 'Glob': return `Glob ${short(i.pattern, 50)}`;
    case 'WebSearch': return `WebSearch "${short(i.query, 55)}"`;
    case 'WebFetch': { try { return `WebFetch ${new URL(i.url).host}`; } catch { return 'WebFetch'; } }
    case 'Bash': return `Bash ${short(i.command, 60)}`;
    case 'TodoWrite': return 'Updated the plan';
    default: return short(String(name).replace(/^mcp__/, ''), 40);
  }
}
function agentKeyOf(input) {
  if (input.agent_type) return input.agent_type;
  if (input.agent_id) return input.agent_id;
  const tp = String(input.transcript_path || ''), base = path.basename(tp, '.jsonl');
  if (/[\\/]subagents[\\/]/.test(tp) || /^agent-/.test(base)) return base;
  return 'captain';
}
function textOf(r) {
  if (!r) return '';
  if (typeof r === 'string') return r;
  if (Array.isArray(r)) return r.map(textOf).join('\n');
  if (Array.isArray(r.content)) return r.content.map(c => c.text || '').join('\n');
  return r.result || r.text || r.output || '';
}
function tokensFromTranscript(file, skipSidechain) {
  try {
    let total = 0;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line) continue;
      const j = JSON.parse(line);
      if (skipSidechain && j.isSidechain) continue;
      const u = j.message && j.message.usage;
      if (u) total += (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0);
    }
    return total;
  } catch { return 0; }
}
function parseFindings(text) {
  const out = [], re = /FINDING:\s*\[(critical|high|medium|low|info)\]\s*([^|\n]+?)\s*(?:\|\s*([^\n]+))?$/gim;
  let m; while ((m = re.exec(String(text || ''))) && out.length < 20) out.push({ sev: m[1].toLowerCase(), title: short(m[2], 140), where: short(m[3] || '', 140) });
  return out;
}

function cleanOldSessions() {
  try {
    const cut = Date.now() - 7 * 86400e3;
    for (const f of fs.readdirSync(DIR)) if (f.startsWith('session-') && fs.statSync(path.join(DIR, f)).mtimeMs < cut) fs.unlinkSync(path.join(DIR, f));
  } catch {}
}

// ---------- main ----------
(async () => {
  if (!BASE || process.env.CLOUD_SWAT_DISABLE === '1') return;
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch {}
  const ev = input.hook_event_name;
  const messages = [];

  let device = linkedDevice();
  if (!device) device = await pollLink(messages);
  if (!device) {
    if (ev === 'SessionStart') await startLink(messages, { auto: true });
    if (messages.length) process.stdout.write(JSON.stringify({ systemMessage: messages.join('\n') }));
    return;
  }

  const sf = sessionFile(input.session_id);
  const st = readJson(sf) || {};
  const events = [];
  const activate = () => { if (!st.active) { st.active = true; events.push({ type: 'mission', text: st.lastPrompt || 'Crew mission' }); } };

  if (ev === 'UserPromptSubmit') {
    st.lastPrompt = short(input.prompt, 140);
    if (TRIGGER.test(input.prompt || '') || ALWAYS) activate();
    else if (st.active) events.push({ type: 'mission', text: st.lastPrompt });
  }
  if (ev === 'PreToolUse') {
    const ti = input.tool_input || {};
    if (SPAWN_TOOLS.has(input.tool_name)) {
      activate();
      events.push({ type: 'spawn', agentType: ti.subagent_type || 'general-purpose', description: short(ti.description || ti.prompt, 80) });
    } else if (st.active || ALWAYS) {
      events.push({ type: 'tool', agentKey: agentKeyOf(input), summary: summarize(input.tool_name, ti, input.cwd), loud: /^(Edit|MultiEdit|Write)$/.test(input.tool_name) });
    }
  }
  if (ev === 'PostToolUse' && SPAWN_TOOLS.has(input.tool_name) && (st.active || ALWAYS)) {
    const ti = input.tool_input || {}, resp = input.tool_response || {}, u = resp.usage || {};
    const tokens = resp.totalTokens || ((u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0));
    events.push({ type: 'agent_done', agentType: ti.subagent_type || 'general-purpose', tokens, findings: parseFindings(textOf(resp)), summary: 'Report delivered to Captain' });
  }
  if (ev === 'SubagentStop' && (st.active || ALWAYS) && (input.agent_type || input.agent_id)) {
    const tokens = input.agent_transcript_path ? tokensFromTranscript(input.agent_transcript_path) : 0;
    events.push({ type: 'agent_done', agentType: input.agent_type, agentKey: input.agent_id, tokens });
  }
  if (ev === 'Stop' && (st.active || ALWAYS)) {
    const tokens = tokensFromTranscript(input.transcript_path, true);
    if (tokens) events.push({ type: 'tokens', agentKey: 'captain', tokens });
    events.push({ type: 'session_end' });
  }

  if (events.length) {
    const r = await call('/api/v1/events', { session: String(input.session_id || 'default').slice(0, 100), events }, { token: device.token, timeout: 1200 });
    if (r && r.status === 401) { remove('device.json'); messages.push('☁️ Cloud SWAT: this device was unlinked. Start a new session to link it again.'); }
    if (r && r.status === 200 && r.body.url && !st.announced) { st.announced = true; messages.push(`☁️ Cloud SWAT live → ${r.body.url}`); }
  }
  writeJson(sf, st);
  if (ev === 'SessionStart') cleanOldSessions();
  if (messages.length) process.stdout.write(JSON.stringify({ systemMessage: messages.join('\n') }));
})().catch(() => {}).finally(() => { process.exitCode = 0; });
