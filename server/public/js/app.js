'use strict';
// Missions list: updates live, and with ?follow=1 jumps into the first live mission.
const params = new URLSearchParams(location.search);
const follow = params.get('follow') === '1';
if (params.get('linked') === '1') $('linked').hidden = false;

const rows = new Map();
let ready = false;

function rowHtml(m) {
  return `<span class="ic">${creatureSVG(m.live ? 'leader' : 'plain', { sleeping: !m.live })}</span>
    <div><h3>${esc(m.title)}${m.live ? '<span class="badge live"><i></i>LIVE</span>' : ''}${m.source === 'mcp' ? '<span class="badge chat">chat</span>' : ''}</h3>
    <p>${m.agents} agent${m.agents === 1 ? '' : 's'} · ${m.findings} finding${m.findings === 1 ? '' : 's'}</p></div>
    <div class="meta">${fmtTok(m.tokens)} tokens<br>${m.live ? 'working now' : ago(m.updated_at)}</div>`;
}

function upsert(m, top) {
  let el = rows.get(m.id);
  const box = $('missions');
  box.querySelector('.empty-state')?.remove();
  if (!el) {
    el = document.createElement('a');
    el.href = '/app/m/' + encodeURIComponent(m.id);
    if (ready) el.classList.add('new');
    rows.set(m.id, el);
    top ? box.prepend(el) : box.append(el);
  } else if (top && box.firstChild !== el) box.prepend(el);
  el.className = 'mrow' + (m.live ? ' live' : '') + (el.classList.contains('new') ? ' new' : '');
  const html = rowHtml(m);
  if (el._html !== html) { el.innerHTML = html; el._html = html; }
  if (follow && m.live) location.href = el.href;   // device just linked: open the live mission
}

function empty() {
  $('missions').innerHTML = `<div class="empty-state">${creatureSVG('general', { sleeping: true })}
    <h3>No missions yet</h3><p>Open Claude Code and say “use the crew to …”.<br>The mission shows up here the moment it starts.</p></div>`;
}

async function loadStats() {
  const s = await api('/api/v1/stats?days=7');
  $('s-missions').textContent = s.missions;
  $('s-tokens').textContent = fmtTok(s.tokens);
  $('s-findings').textContent = s.findings;
  if (s.cost != null) { $('s-cost').textContent = '~$' + s.cost; $('s-cost-label').textContent = 'Est. cost · 7d'; }
  else $('s-cost').textContent = s.top[0] ? s.top[0][0] : '–';
}

(async () => {
  await loadMe();
  const { missions } = await api('/api/v1/missions');
  if (!missions.length) empty();
  missions.forEach(m => upsert(m, false));
  ready = true;
  loadStats().catch(() => {});
  const es = new EventSource('/api/v1/stream');
  let statsTimer;
  es.addEventListener('mission', ev => {
    upsert(JSON.parse(ev.data), true);
    clearTimeout(statsTimer); statsTimer = setTimeout(() => loadStats().catch(() => {}), 1500);
  });
  // keep "x min ago" fresh
  setInterval(async () => { const r = await api('/api/v1/missions').catch(() => null); r?.missions.forEach(m => upsert(m, false)); }, 60000);
})();
