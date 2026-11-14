'use strict';
const mcpUrl = location.origin + '/mcp';
$('mcp-cmd').textContent = `claude mcp add --transport http cloud-swat ${mcpUrl}`;
$('mcp-url').textContent = mcpUrl;

function list(box, items, render, emptyText) {
  box.innerHTML = items.length ? '' : `<p class="fine">${esc(emptyText)}</p>`;
  for (const it of items) {
    const row = document.createElement('div'); row.className = 'item';
    const [label, sub, action] = render(it);
    row.innerHTML = `<div>${esc(label)}<small>${esc(sub)}</small></div>`;
    const b = document.createElement('button'); b.className = 'btn small'; b.textContent = action.text;
    b.addEventListener('click', async () => { b.disabled = true; try { await action.run(); row.remove(); } catch { b.disabled = false; } });
    row.append(b); box.append(row);
  }
}

async function load() {
  const [{ devices }, { connections }] = await Promise.all([api('/api/v1/devices'), api('/api/v1/connections')]);
  list($('devices'), devices, d => [d.name, 'linked ' + ago(d.created_at) + (d.last_seen ? ' · active ' + ago(d.last_seen) : ''),
    { text: 'Unlink', run: () => api(`/api/v1/devices/${d.id}/revoke`, { method: 'POST' }) }], 'No devices linked yet.');
  list($('connections'), connections, c => [c.name, 'connected', { text: 'Disconnect', run: () => api(`/api/v1/connections/${encodeURIComponent(c.client_id)}/revoke`, { method: 'POST' }) }],
    'No apps connected.');
}

// Two-step confirm, built into the page (browser dialogs are not used)
$('delete').addEventListener('click', async e => {
  const b = e.currentTarget;
  if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = 'Click again to delete everything'; setTimeout(() => { b.dataset.armed = ''; b.textContent = 'Delete my account'; }, 5000); return; }
  b.disabled = true;
  await api('/api/v1/account/delete', { method: 'POST' });
  location.href = '/';
});

loadMe().then(load);
