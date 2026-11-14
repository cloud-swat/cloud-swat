// Shared by the server (Node) and the dashboard (browser).
// Turns simple crew events into one session state object.
(function (root) {
  const PALETTE = {
    captain:  { kind: 'leader',    role: 'Captain',         color: '#f2c55c' },
    security: { kind: 'security',  role: 'Security Hunter', color: '#ff6b6b' },
    research: { kind: 'detective', role: 'Researcher',      color: '#4fd1c5' },
    coder:    { kind: 'coder',     role: 'Coder',           color: '#5fd39a' },
    reviewer: { kind: 'reviewer',  role: 'Reviewer',        color: '#b597ff' },
    tester:   { kind: 'tester',    role: 'Tester',          color: '#7fb2ff' },
    general:  { kind: 'general',   role: 'Crew Member',     color: '#aab4cc' },
  };
  const KNOWN = {
    captain: ['Captain', 'captain'], 'swat-hawk': ['Hawk', 'security'],
    'swat-sherlock': ['Sherlock', 'research'], 'swat-pixel': ['Pixel', 'coder'],
    'swat-sage': ['Sage', 'reviewer'], 'swat-bolt': ['Bolt', 'tester'],
  };
  const SPARE_NAMES = ['Puff', 'Misty', 'Drizzle', 'Fluff', 'Cirrus', 'Nimbo', 'Breeze', 'Haze'];

  function classify(type) {
    const t = (type || '').toLowerCase();
    if (/secur|vuln|audit|pentest|hunt/.test(t)) return 'security';
    if (/research|explore|search|investig|plan/.test(t)) return 'research';
    if (/review|critic|qa/.test(t)) return 'reviewer';
    if (/test/.test(t)) return 'tester';
    if (/code|dev|build|implement|engineer|fix/.test(t)) return 'coder';
    return 'general';
  }

  function newSession(token) {
    return { token, createdAt: Date.now(), startedAt: null, endedAt: null, mission: '',
      agents: {}, order: [], alias: {}, findings: [], feed: [] };
  }

  function ensureAgent(s, key, type, now) {
    if (s.agents[key]) return s.agents[key];
    const bare = t => String(t || '').split(':').pop(); // plugin agents may be "cloud-swat:swat-hawk"
    const known = KNOWN[bare(type)] || KNOWN[bare(key)];
    const group = known ? known[1] : classify(type || key);
    const used = new Set(s.order.map(k => s.agents[k].name));
    let name = known ? known[0] : SPARE_NAMES.find(n => !used.has(n)) || ('Cloud ' + (s.order.length + 1));
    if (used.has(name)) name += ' ' + (s.order.length + 1);
    const p = PALETTE[group];
    s.agents[key] = { key, name, type: type || key, kind: p.kind, role: p.role, color: p.color,
      status: key === 'captain' ? 'working' : 'working', now: 'Getting ready…', trail: [],
      tokens: 0, findings: 0, tools: 0, startedAt: now, doneAt: null, bound: key === 'captain' };
    s.order.push(key);
    return s.agents[key];
  }

  // Resolve which card a tool call belongs to.
  function resolve(s, key, now) {
    if (!key || key === 'captain') return ensureAgent(s, 'captain', 'captain', now);
    if (s.agents[key]) return s.agents[key];
    if (s.alias[key]) return s.agents[s.alias[key]];
    // Unknown id from a subagent: bind it to the newest working agent not yet bound.
    for (let i = s.order.length - 1; i >= 0; i--) {
      const a = s.agents[s.order[i]];
      if (a.key !== 'captain' && a.status === 'working' && !a.bound) {
        a.bound = true; s.alias[key] = a.key; return a;
      }
    }
    return ensureAgent(s, key, key, now);
  }

  function push(arr, item, max) { arr.unshift(item); if (arr.length > max) arr.length = max; }

  function apply(s, e) {
    const now = e.t || Date.now();
    // "cloud-swat:swat-hawk" and "swat-hawk" are the same crew member
    if (e.agentType) e = { ...e, agentType: String(e.agentType).split(':').pop() };
    if (e.agentKey) e = { ...e, agentKey: String(e.agentKey).split(':').pop() };
    if (!s.startedAt) s.startedAt = now;
    if (e.type === 'spawn' || e.type === 'tool' || e.type === 'mission') {
      if (s.endedAt) { s.endedAt = null; const c = s.agents.captain; if (c) c.status = 'working'; }
    }
    switch (e.type) {
      case 'mission':
        if (!s.mission) s.mission = String(e.text || '').slice(0, 140);
        ensureAgent(s, 'captain', 'captain', now);
        break;
      case 'spawn': {
        const a = ensureAgent(s, e.agentType || 'general', e.agentType, now);
        a.status = 'working'; a.doneAt = null; a.now = e.description || 'Starting task';
        push(a.trail, { t: now, text: 'Assigned: ' + (e.description || 'new task') }, 6);
        push(s.feed, { t: now, key: a.key, text: 'joined the mission' }, 40);
        break;
      }
      case 'tool': {
        const a = resolve(s, e.agentKey, now);
        a.tools++; a.now = e.summary; a.status = 'working';
        push(a.trail, { t: now, text: e.summary }, 6);
        if (e.loud) push(s.feed, { t: now, key: a.key, text: e.summary }, 40);
        break;
      }
      case 'agent_done': {
        let a = (e.agentType && s.agents[e.agentType]) ||
                (e.agentKey && (s.agents[e.agentKey] || s.agents[s.alias[e.agentKey]]));
        if (!a) { if (!e.agentType) break; a = ensureAgent(s, e.agentType, e.agentType, now); }
        if (a.status !== 'done') push(s.feed, { t: now, key: a.key, text: 'finished' }, 40);
        a.status = 'done'; a.doneAt = now; a.now = e.summary || 'Report delivered to Captain';
        if (e.tokens) a.tokens = Math.max(a.tokens, e.tokens);
        (e.findings || []).forEach(f => {
          const dup = s.findings.some(x => x.title === f.title && x.where === f.where);
          if (dup) return;
          a.findings++;
          s.findings.push({ sev: f.sev, title: f.title, where: f.where || '', by: a.name, color: a.color, t: now });
          push(s.feed, { t: now, key: a.key, text: 'reported a ' + f.sev.toUpperCase() + ' finding' }, 40);
        });
        break;
      }
      case 'tokens': {
        const a = resolve(s, e.agentKey, now);
        a.tokens = Math.max(a.tokens, e.tokens || 0);
        break;
      }
      case 'session_end': {
        s.endedAt = now;
        const c = s.agents.captain; if (c) { c.status = 'done'; c.now = 'Mission complete'; }
        break;
      }
    }
    const rank = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
    s.findings.sort((x, y) => (rank[x.sev] ?? 9) - (rank[y.sev] ?? 9));
    return s;
  }

  // Pull "FINDING: [HIGH] title | file:line" lines out of an agent's report.
  function parseFindings(text) {
    const out = [];
    const re = /FINDING:\s*\[(critical|high|medium|low|info)\]\s*([^|\n]+?)\s*(?:\|\s*([^\n]+))?$/gim;
    let m; while ((m = re.exec(String(text || '')))) out.push({ sev: m[1].toLowerCase(), title: m[2].trim(), where: (m[3] || '').trim() });
    return out;
  }

  const api = { newSession, apply, parseFindings, PALETTE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Swat = api;
})(this);
