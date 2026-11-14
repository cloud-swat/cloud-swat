'use strict';
document.querySelectorAll('.logo').forEach(e => e.innerHTML = creatureSVG('plain'));
const crew = [['Captain', 'leader', '#f2c55c', 'Leads'], ['Hawk', 'security', '#ff6b6b', 'Security'], ['Sherlock', 'detective', '#4fd1c5', 'Research'],
  ['Pixel', 'coder', '#5fd39a', 'Coder'], ['Sage', 'reviewer', '#b597ff', 'Review'], ['Bolt', 'tester', '#7fb2ff', 'Tests']];
const box = document.getElementById('lineup');
crew.forEach(([name, kind, color, role], i) => {
  const d = document.createElement('div');
  d.className = 'member';
  d.style.setProperty('--c', color); d.style.setProperty('--d', (i * 0.25) + 's');
  d.innerHTML = `<div class="av">${creatureSVG(kind)}</div><b>${name}</b><span>${role}</span>`;
  box.append(d);
});
