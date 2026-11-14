'use strict';
document.querySelectorAll('.logo').forEach(e=>e.innerHTML=creatureSVG('plain'));
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const SEV = { critical:'var(--red)', high:'var(--red)', medium:'var(--yellow)', low:'var(--blue)', info:'var(--muted)' };
const fmtTok = n => n >= 1e6 ? (n/1e6).toFixed(1)+'M' : n >= 1000 ? Math.round(n/1000)+'k' : String(n||0);
const TOOLS = new Set(['Read','Edit','Write','Grep','Glob','WebSearch','WebFetch','Bash','MultiEdit','NotebookEdit']);
let state = null, mode = 'live', timeScale = 1;

function clock(ms){ if(ms<0) ms=0; const s=Math.floor(ms/1000); const h=Math.floor(s/3600), m=Math.floor(s/60)%60, x=s%60;
  return (h? h+':' : '') + String(m).padStart(2,'0')+':'+String(x).padStart(2,'0'); }
const rel = t => state && state.startedAt ? clock(t - state.startedAt) : '';
function action(text){ const m = String(text||'').match(/^(\w+)\s(.*)$/s);
  return m && TOOLS.has(m[1]) ? `<em>${esc(m[1])}</em> ${esc(m[2])}` : esc(text); }

// ---------- smooth helpers ----------
function setText(el, v){ v = String(v); if (el.textContent !== v) el.textContent = v; }
function pop(el){ el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump'); }
// Count numbers up/down instead of jumping
function tween(el, to, fmt = String){
  to = to || 0; const from = el._v ?? 0;
  if (el._v === undefined) { el._v = to; el.textContent = fmt(to); return; }
  if (from === to) return;
  el._v = to; cancelAnimationFrame(el._raf);
  const t0 = performance.now(), d = 700;
  const step = now => { const p = Math.min(1, (now - t0) / d), e = 1 - Math.pow(1 - p, 3);
    el.textContent = fmt(Math.round(from + (to - from) * e)); if (p < 1) el._raf = requestAnimationFrame(step); };
  el._raf = requestAnimationFrame(step);
  if (to > from) pop(el);
}
// Keyed list: keep existing rows, slide in only the new ones, drop the old ones
function syncList(box, items, keyOf, create, update, empty){
  box._nodes = box._nodes || new Map();
  const ph = box.querySelector(':scope > .empty');
  if (!items.length) { if (!ph) { box.innerHTML = `<div class="empty fadein">${empty}</div>`; box._nodes.clear(); } return; }
  if (ph) ph.remove();
  const seen = new Set(); let prev = null;
  for (const it of items) {
    const k = keyOf(it); seen.add(k);
    let n = box._nodes.get(k);
    if (!n) { n = create(it); n._k = k; if (box._ready) n.classList.add('new'); box._nodes.set(k, n); }
    if (update) update(n, it);
    const want = prev ? prev.nextSibling : box.firstChild;
    if (n !== want) box.insertBefore(n, want);
    prev = n;
  }
  for (const [k, n] of box._nodes) if (!seen.has(k)) { n.remove(); box._nodes.delete(k); }
  box._ready = true;
}

function statusLine(a){
  if (a.status === 'done') return ['Done', '#8a91a3'];
  const idle = Date.now() - (a.trail[0]?.t || a.startedAt) > 45000 * timeScale;
  return idle ? ['Thinking…', '#f2c55c'] : ['Working', '#5fd39a'];
}

// ---------- cards (built once, then updated in place) ----------
const cards = new Map();
function makeCard(a){
  const el = document.createElement('div');
  el.className = 'card enter';
  el.innerHTML = `<div class="top"><div class="avatar"></div>
      <div class="who"><h3></h3><div class="role"></div><div class="status"><i></i><span></span></div></div></div>
    <div class="now"></div><div class="trail"></div>
    <div class="foot"><span>Tokens <b class="tk">—</b></span><span class="fs">Findings <b class="fn">0</b></span></div>`;
  const q = s => el.querySelector(s);
  const c = { el, av: q('.avatar'), name: q('h3'), role: q('.role'), dot: q('.status i'), st: q('.status span'),
    now: q('.now'), trail: q('.trail'), tk: q('.tk'), fs: q('.fs'), fn: q('.fn'), sleep: null, nowText: null };
  $('grid').appendChild(el);
  el.addEventListener('animationend', () => el.classList.remove('enter'), { once: true });
  return c;
}
function updateCard(c, a){
  c.el.style.setProperty('--c', a.color);
  c.el.classList.toggle('working', a.status !== 'done');
  c.el.classList.toggle('done', a.status === 'done');
  const sleeping = a.status === 'done' && a.key !== 'captain';
  if (c.sleep !== sleeping) {
    c.av.innerHTML = creatureSVG(a.kind, { sleeping });
    if (c.sleep !== null) c.av.firstChild.classList.add('fadein');
    c.sleep = sleeping;
  }
  setText(c.name, a.name); setText(c.role, a.role);
  const [st, sc] = statusLine(a);
  c.el.style.setProperty('--s', sc);
  setText(c.st, `${st} · ${a.tools} action${a.tools === 1 ? '' : 's'}`);
  if (c.nowText !== a.now) { c.nowText = a.now; c.now.innerHTML = `<span class="swap">${action(a.now)}</span>`; }
  syncList(c.trail, a.trail.slice(0, 3), t => t.t + '|' + t.text,
    t => { const d = document.createElement('div'); d.innerHTML = `<b>${rel(t.t)}</b>${esc(t.text)}`; return d; }, null, '');
  tween(c.tk, a.tokens, n => n ? fmtTok(n) : '—');
  tween(c.fn, a.findings);
  c.fs.classList.toggle('hot', a.findings > 0);
}

let shownId = null, resetting = false, pending = false;
function hardReset(){
  cards.clear();
  for (const id of ['grid', 'findings', 'feed', 'tok']) { const b = $(id); b.innerHTML = ''; b._nodes = null; b._ready = false; }
  for (const id of ['nAgents', 'nFind', 'nTok']) { $(id)._v = undefined; }
  $('mission').textContent = '';
}

function setPill(cls, txt){ const pill = $('pill'); if (pill.className !== 'pill ' + cls) pill.className = 'pill ' + cls; setText(pill.lastChild, txt); }
function render(){
  if (resetting) { pending = true; return; }
  const s = state;
  if (mode === 'demo') setPill('demo', 'DEMO · sample mission');
  else if (!s) setPill('wait', 'Waiting for Claude Code…');
  else if (s.endedAt) setPill('done', 'COMPLETE');
  else setPill('live', 'LIVE');

  // A brand-new session: fade the old one out, then start clean
  const id = s ? s.token + ':' + s.createdAt : null;
  if (shownId !== null && id !== shownId) {
    shownId = id; resetting = true;
    document.querySelector('.main').classList.add('reset');
    setTimeout(() => { hardReset(); resetting = false; document.querySelector('.main').classList.remove('reset'); render(); }, 320);
    return;
  }
  shownId = id;

  const grid = $('grid');
  if (!s || !s.order.length) {
    if (!grid.querySelector('.waiting')) {
      hardReset();
      grid.innerHTML = `<div class="waiting fadein">${creatureSVG('general',{sleeping:true})}
        <h3>Your crew is getting ready</h3><p>Agents appear here the moment they start.</p></div>`;
      ['findings','feed','tok'].forEach(i => $(i).innerHTML = '<div class="empty">Nothing yet.</div>');
    }
    return;
  }
  const w = grid.querySelector('.waiting'); if (w) w.remove();

  const agents = s.order.map(k => s.agents[k]);
  const crew = agents.filter(a => a.key !== 'captain');
  const total = agents.reduce((n, a) => n + (a.tokens || 0), 0);

  const mission = s.mission || 'Untitled mission';
  if ($('mission').textContent !== mission) $('mission').innerHTML = `<span class="swap">${esc(mission)}</span>`;
  tween($('nAgents'), crew.length);
  tween($('nFind'), s.findings.length);
  $('nFind').style.color = s.findings.length ? 'var(--red)' : '';
  tween($('nTok'), total, fmtTok);
  const pct = s.endedAt ? 100 : crew.length ? crew.filter(a => a.status === 'done').length / crew.length * 100 : 5;
  $('bar').style.width = Math.max(pct, 4) + '%';

  for (const a of agents) { let c = cards.get(a.key); if (!c) { c = makeCard(a); cards.set(a.key, c); } updateCard(c, a); }

  tween($('fCount'), s.findings.length);
  syncList($('findings'), s.findings, f => f.sev + '|' + f.title + '|' + f.where, f => {
    const d = document.createElement('div'); d.className = 'finding'; d.style.setProperty('--sev', SEV[f.sev] || 'var(--muted)');
    d.innerHTML = `<div class="sev">${esc(f.sev)}</div><p>${esc(f.title)}</p><span>${f.where ? esc(f.where) + ' · ' : ''}found by ${esc(f.by)}</span>`;
    return d; }, null, 'No findings yet.');

  syncList($('feed'), s.feed.slice(0, 8), f => f.t + '|' + f.key + '|' + f.text, f => {
    const a = s.agents[f.key] || {}; const d = document.createElement('div'); d.style.setProperty('--c', a.color || '#aaa');
    d.innerHTML = `<time>${rel(f.t)}</time><span><b>${esc(a.name || '?')}</b> ${esc(f.text)}</span>`; return d; }, null, 'Nothing yet.');

  const max = Math.max(1, ...agents.map(a => a.tokens || 0));
  syncList($('tok'), agents.filter(a => a.tokens), a => a.key, a => {
    const d = document.createElement('div'); d.style.setProperty('--c', a.color);
    d.innerHTML = `<span>${esc(a.name)}</span><i></i><em></em>`; return d;
  }, (d, a) => {
    const bar = d.querySelector('i'); const pctW = (a.tokens / max * 100) + '%';
    if (!bar.style.width) requestAnimationFrame(() => bar.style.width = pctW); else bar.style.width = pctW;
    tween(d.querySelector('em'), a.tokens, fmtTok);
  }, 'Counted when each agent reports back.');
}

// Clock + "Thinking…" status refresh without touching anything else
setInterval(() => {
  if (state && state.startedAt) {
    // demo event times are already sped up; only the running clock needs scaling
    const ms = state.endedAt ? state.endedAt - state.startedAt : (Date.now() - state.startedAt) * (mode === 'demo' ? timeScale : 1);
    setText($('elapsed'), clock(ms));
  }
  if (state && mode === 'live') render();
}, 1000);

// ---------- live mode ----------
function live(id){
  document.body.classList.add('is-live');
  fetch('/api/v1/missions/' + id, { credentials: 'same-origin' }).then(r => {
    if (r.status === 401) { location.href = '/login?next=' + encodeURIComponent(location.pathname); return null; }
    if (r.status === 404) { document.querySelector('.wrap').classList.add('missing'); setPill('wait', 'Mission not found'); return null; }
    return r.ok ? r.json() : null;
  }).then(s => { if (s && !state) { state = s; render(); } });
  const es = new EventSource('/api/v1/missions/' + id + '/stream');
  es.addEventListener('state', ev => { state = JSON.parse(ev.data); render(); });
  es.onerror = () => setPill('wait', 'Reconnecting…');
  render();
}

// ---------- demo mode: a scripted mission ----------
function demo(){
  mode = 'demo'; timeScale = 14;
  const script = [
    [0,    {type:'mission', text:'Security audit of the login & payments module'}],
    [800,  {type:'tool', agentKey:'captain', summary:'Glob src/**/*.js'}],
    [1600, {type:'spawn', agentType:'swat-hawk', description:'Hunt for vulnerabilities in auth + payments'}],
    [2100, {type:'spawn', agentType:'swat-sherlock', description:'Research best practices for JWT & rate limits'}],
    [2600, {type:'spawn', agentType:'swat-sage', description:'Review routes for missing protections'}],
    [3400, {type:'tool', agentKey:'swat-hawk', summary:'Read src/auth/login.js'}],
    [4100, {type:'tool', agentKey:'swat-sherlock', summary:'WebSearch "JWT secret rotation best practice"'}],
    [4800, {type:'tool', agentKey:'swat-sage', summary:'Glob routes/*.js'}],
    [5600, {type:'tool', agentKey:'swat-hawk', summary:'Grep "query(" in src/auth/**', loud:true}],
    [6400, {type:'tool', agentKey:'swat-sherlock', summary:'WebFetch cheatsheetseries.owasp.org'}],
    [7100, {type:'tool', agentKey:'swat-sage', summary:'Read routes/reset.js'}],
    [7900, {type:'tool', agentKey:'swat-hawk', summary:'Read config/keys.js'}],
    [8800, {type:'agent_done', agentType:'swat-sage', tokens:27400, summary:'Report delivered to Captain',
            findings:[{sev:'low', title:'Missing rate limit on /reset', where:'routes/reset.js'}]}],
    [9700, {type:'tool', agentKey:'swat-sherlock', summary:'WebSearch "express-rate-limit 2026"'}],
    [10600,{type:'agent_done', agentType:'swat-hawk', tokens:52100, summary:'Report delivered to Captain',
            findings:[{sev:'high', title:'SQL injection in login query', where:'src/auth/login.js:42'},
                      {sev:'medium', title:'JWT secret hard-coded', where:'config/keys.js:7'}]}],
    [11600,{type:'spawn', agentType:'swat-pixel', description:'Fix the SQL injection and move the JWT secret to env'}],
    [12500,{type:'tool', agentKey:'swat-pixel', summary:'Read src/db/client.js'}],
    [13400,{type:'agent_done', agentType:'swat-sherlock', tokens:38300, summary:'Report delivered to Captain'}],
    [14300,{type:'tool', agentKey:'swat-pixel', summary:'Edit src/auth/login.js → parameterized query', loud:true}],
    [15300,{type:'tool', agentKey:'swat-pixel', summary:'Edit config/keys.js → process.env.JWT_SECRET'}],
    [16300,{type:'tool', agentKey:'swat-pixel', summary:'Bash npm test'}],
    [17600,{type:'agent_done', agentType:'swat-pixel', tokens:31200, summary:'Fixes applied · tests passing'}],
    [18300,{type:'tokens', agentKey:'captain', tokens:18900}],
    [18800,{type:'session_end'}],
  ];
  function run(){
    const base = Date.now();
    state = Swat.newSession('demo-session-000000');
    state.createdAt = base;
    render();
    script.forEach(([ms, e]) => setTimeout(() => { Swat.apply(state, {...e, t: base + ms * timeScale}); state.startedAt = base; render(); }, ms));
    setTimeout(run, 27000);
  }
  run();
}

const m = location.pathname.match(/^\/app\/m\/([\w-]{10,40})$/);
if (m) live(m[1]); else demo();
