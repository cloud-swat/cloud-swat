'use strict';
// Server-rendered pages (no inline scripts or styles, so the strict CSP holds).
const { esc } = require('./security');
const cfg = require('./config');

const LOGO = `<svg viewBox="-2 -4 110 96" aria-hidden="true"><g fill="#ee8a55"><circle cx="33" cy="50" r="17"/><circle cx="54" cy="38" r="22"/><circle cx="74" cy="51" r="15"/><rect x="16" y="50" width="74" height="20" rx="10"/></g><ellipse cx="44" cy="54" rx="3.4" ry="4.4" fill="#1b1f2a"/><ellipse cx="64" cy="54" rx="3.4" ry="4.4" fill="#1b1f2a"/><path d="M50 61 q4 4 8 0" stroke="#1b1f2a" stroke-width="2.4" fill="none" stroke-linecap="round"/></svg>`;

function page(title, body, { scripts = [] } = {}) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ${cfg.APP_NAME}</title><link rel="icon" href="/favicon.svg"><link rel="stylesheet" href="/css/app.css">
</head><body><div class="shell">
<header class="top"><a class="brand" href="/">${LOGO}<b>${cfg.APP_NAME}</b></a></header>
<main class="center">${body}</main></div>
${scripts.map(s => `<script src="${esc(s)}"></script>`).join('')}
</body></html>`;
}

function loginPage(next, providers, error) {
  const q = encodeURIComponent(next);
  const btn = (p, label) => `<a class="btn provider ${p}" href="/auth/${p}?next=${q}">${label}</a>`;
  const buttons = [
    providers.github && btn('github', 'Continue with GitHub'),
    providers.google && btn('google', 'Continue with Google'),
    providers.dev && btn('dev', 'Dev login (localhost only)'),
  ].filter(Boolean).join('');
  return page('Sign in', `<section class="panel narrow">
    <div class="mascot">${LOGO}</div>
    <h1>Sign in to ${cfg.APP_NAME}</h1>
    <p class="muted">Watch your AI team work, live.</p>
    ${error ? `<p class="alert">${esc(error)}</p>` : ''}
    <div class="stack">${buttons || '<p class="alert">No sign-in method is configured yet.</p>'}</div>
    <p class="fine">By signing in you agree to the <a href="/privacy">privacy notice</a>.</p>
  </section>`);
}

function linkPage({ code, deviceName, csrf, state, error }) {
  if (error) return page('Link device', `<section class="panel narrow"><h1>Link a device</h1><p class="alert">${esc(error)}</p>
    <p class="muted">Start Claude Code again to get a fresh link.</p></section>`);
  return page('Link device', `<section class="panel narrow">
    <div class="mascot">${LOGO}</div>
    <h1>Link this device?</h1>
    <p class="muted">Claude Code on <b>${esc(deviceName)}</b> wants to send live crew activity to your account.</p>
    <p class="code">${esc(code)}</p>
    <p class="fine">Only approve if this code matches the one shown in your terminal.</p>
    <form method="post" action="/link" class="row">
      <input type="hidden" name="code" value="${esc(code)}"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="state" value="${esc(state)}">
      <button class="btn ghost" name="decision" value="deny">Deny</button>
      <button class="btn primary" name="decision" value="approve">Approve</button>
    </form></section>`);
}

const TRUSTED_HOSTS = /^(claude\.ai|claude\.com|[\w-]+\.claude\.ai|[\w-]+\.claude\.com|localhost(:\d+)?|127\.0\.0\.1(:\d+)?)$/;
function consentPage({ client, redirectHost, params, csrf }) {
  const warn = TRUSTED_HOSTS.test(redirectHost) ? '' :
    `<p class="alert">This app is not Claude. Only connect it if you set it up yourself and trust ${esc(redirectHost)}.</p>`;
  const hidden = Object.entries(params).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
  return page('Connect', `<section class="panel narrow">
    <div class="mascot">${LOGO}</div>
    <h1>Connect ${esc(client)}?</h1>
    <p class="muted">It will be able to read your mission stats and findings, and save mission reports to your account.</p>
    ${warn}
    <p class="fine">You'll be sent back to <b>${esc(redirectHost)}</b>. You can disconnect it any time from your account page.</p>
    <form method="post" action="/oauth/authorize" class="row">${hidden}<input type="hidden" name="csrf" value="${esc(csrf)}">
      <button class="btn ghost" name="decision" value="deny">Cancel</button>
      <button class="btn primary" name="decision" value="approve">Connect</button>
    </form></section>`);
}

function messagePage(title, text, status = 'info') {
  return page(title, `<section class="panel narrow"><div class="mascot">${LOGO}</div><h1>${esc(title)}</h1>
    <p class="${status === 'error' ? 'alert' : 'muted'}">${esc(text)}</p><p><a class="btn ghost" href="/app">Go to my missions</a></p></section>`);
}

function privacyPage() {
  return page('Privacy', `<section class="panel prose">
    <h1>Privacy notice</h1>
    <p>${cfg.APP_NAME} shows what your Claude Code agents are doing while they work.</p>
    <h3>What is stored</h3>
    <p>Your name and avatar from GitHub or Google; the devices you link; and for each mission: its title (your prompt, shortened), agent names, short action summaries (like "Read src/app.js"), token counts and reported findings.</p>
    <h3>What is not stored</h3>
    <p>File contents, full commands, full prompts or model responses. Secrets that look like keys or passwords are removed from summaries before they leave your computer, and again on the server.</p>
    <h3>Retention and deletion</h3>
    <p>Missions are deleted automatically after ${cfg.RETENTION_DAYS} days. You can delete a mission, unlink a device, disconnect an app, or delete your whole account from the account page at any time.</p>
    <p class="fine">${cfg.APP_NAME} is an independent community project and is not affiliated with Anthropic.</p>
  </section>`);
}

module.exports = { page, loginPage, linkPage, consentPage, messagePage, privacyPage, LOGO };
