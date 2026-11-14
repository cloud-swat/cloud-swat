// Original Cloud SWAT clouds: one simple shape, one warm orange for the whole crew,
// with each role's outfit in its own natural colors.
(function (root) {
  const ORANGE = '#ee8a55';
  const COLORS = { leader: ORANGE, security: ORANGE, detective: ORANGE, coder: ORANGE,
    reviewer: ORANGE, tester: ORANGE, general: ORANGE, plain: ORANGE };
  const INK = '#1b1f2a';

  function shade(hex, k) { // k < 1 darkens
    const n = parseInt(hex.slice(1), 16);
    const f = v => Math.round(v * k).toString(16).padStart(2, '0');
    return '#' + f(n >> 16) + f((n >> 8) & 255) + f(n & 255);
  }

  const cloud = c => `<g fill="${c}"><circle cx="33" cy="50" r="17"/><circle cx="54" cy="38" r="22"/><circle cx="74" cy="51" r="15"/>
    <rect x="16" y="50" width="74" height="20" rx="10"/></g>`;

  function face(sleeping) {
    const eyes = sleeping
      ? `<path d="M40 55 q4 3 8 0 M60 55 q4 3 8 0" stroke="${INK}" stroke-width="2.6" fill="none" stroke-linecap="round"/>`
      : `<ellipse cx="44" cy="54" rx="3.4" ry="4.4" fill="${INK}"/><ellipse cx="64" cy="54" rx="3.4" ry="4.4" fill="${INK}"/>
         <circle cx="45.2" cy="52.4" r="1.2" fill="#fff"/><circle cx="65.2" cy="52.4" r="1.2" fill="#fff"/>`;
    return eyes + `<path d="M50 61 q4 4 8 0" stroke="${INK}" stroke-width="2.4" fill="none" stroke-linecap="round"/>`;
  }

  const outfit = {
    leader: () => `<path d="M43 7 l5 7 l6 -10 l6 10 l5 -7 l-2 12 h-18z" fill="#f5c542" stroke="#d49a1c" stroke-width="1.5" stroke-linejoin="round"/>
      <circle cx="54" cy="14" r="2" fill="#e5484d"/>`,
    detective: () => `
      <path d="M30 24 h48 q-2 4 -6 4 h-36 q-4 0 -6 -4z" fill="#6b4630"/><rect x="40" y="9" width="28" height="17" rx="5" fill="#8a5a3b"/>
      <rect x="40" y="20" width="28" height="4" fill="#3d2618"/>
      <circle cx="93" cy="60" r="8" fill="#cfe8ff" fill-opacity=".35" stroke="#c9a24a" stroke-width="4"/>
      <path d="M98 66 l6 8" stroke="#5b3a26" stroke-width="5" stroke-linecap="round"/>`,
    coder: () => `
      <path d="M30 42 Q54 6 78 42" stroke="#2b3142" stroke-width="5" fill="none" stroke-linecap="round"/>
      <rect x="23" y="38" width="10" height="16" rx="5" fill="#3a4157"/><rect x="75" y="38" width="10" height="16" rx="5" fill="#3a4157"/>
      <rect x="34" y="66" width="40" height="22" rx="4" fill="#2b3142"/><rect x="37" y="69" width="34" height="16" rx="2" fill="#0e1a12"/>
      <path d="M41 74h10M41 79h16M54 74h6" stroke="#5fd39a" stroke-width="2.4" stroke-linecap="round"/>`,
    security: () => `
      <path d="M22 41 Q54 26 86 41 L86 47 Q54 33 22 47Z" fill="#d93f3f"/><path d="M86 42 l8 -3 l-2 8z" fill="#d93f3f"/>
      <path d="M86 56 L99 61 L99 72 Q99 82 86 87 Q73 82 73 72 L73 61Z" fill="#3b82f6" stroke="#bfdbfe" stroke-width="1.5"/>
      <path d="M80 71 l4.5 4.5 l8 -9" stroke="#ffffff" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`,
    reviewer: () => `
      <g fill="#ffffff" fill-opacity=".25" stroke="#2b3142" stroke-width="3"><rect x="36" y="47" width="16" height="13" rx="5"/><rect x="56" y="47" width="16" height="13" rx="5"/></g>
      <path d="M52 53h4" stroke="#2b3142" stroke-width="3"/>
      <rect x="3" y="56" width="20" height="26" rx="3" fill="#a4815a"/><rect x="6" y="60" width="14" height="19" rx="1.5" fill="#f5efe2"/>
      <rect x="9" y="53" width="8" height="5" rx="1.5" fill="#6b5a45"/>
      <path d="M9 65h8M9 70h8" stroke="#a4815a" stroke-width="2" stroke-linecap="round"/><path d="M9 75 l2 2 l4 -4" stroke="#22a06b" stroke-width="2" fill="none" stroke-linecap="round"/>`,
    tester: () => `
      <path d="M22 52h14M72 52h14" stroke="#3a4157" stroke-width="3.4"/>
      <rect x="36" y="46" width="36" height="15" rx="7.5" fill="#7fd3ff" fill-opacity=".35" stroke="#3a4157" stroke-width="3.4"/>
      <path d="M91 54 v9 l-7 13 q-2 5 4 5 h12 q6 0 4 -5 l-7 -13 v-9z" fill="#e9f2ff" fill-opacity=".85" stroke="#9fb6d9" stroke-width="2" stroke-linejoin="round"/>
      <path d="M86 72 h16 l2.5 5 q1 3 -3 3 h-15 q-4 0 -3 -3z" fill="#4ade80"/><rect x="88.5" y="51" width="11" height="4" rx="1.5" fill="#9fb6d9"/>`,
    general: () => `<path d="M54 16 v-9" stroke="#3a4157" stroke-width="3.4" stroke-linecap="round"/><circle cx="54" cy="6" r="4.2" fill="#e5484d"/>`,
    plain: () => '',
  };

  root.creatureSVG = function (kind, opts = {}) {
    const k = outfit[kind] ? kind : 'general';
    const c = COLORS[k];
        return `<svg viewBox="-2 -4 110 96" aria-hidden="true">${cloud(c)}${face(opts.sleeping)}${outfit[k]()}</svg>`;
  };
  root.CREATURE_COLORS = COLORS;
})(this);
