# ☁️ Cloud SWAT

**Watch your Claude Code crew work, live.** Cloud SWAT turns subagents into a visible team. Each agent gets a name, a role and a card showing what it searches, reads, fixes and finds, as it happens.

| | |
|---|---|
| **Captain** leads | **Hawk** hunts vulnerabilities |
| **Sherlock** researches | **Pixel** writes the fixes |
| **Sage** reviews | **Bolt** runs the tests |

## Install (Claude Code)

```
/plugin marketplace add Saud770077/cloud-swat
/plugin install cloud-swat@cloud-swat
```

Restart Claude Code. Your browser opens once to link this computer (sign in with GitHub or Google and approve; no keys to copy). Then ask:

```
use the crew to audit this repo for security issues
```

The live view opens by itself.

## Why it's cheap on tokens

- Live tracking runs in **hooks outside the model**, so it costs **zero tokens**.
- No context is injected into your sessions; links appear as terminal messages only.
- Agent descriptions are one line each. Agents report findings as one-line `FINDING:` entries.
- The optional MCP server has **4 small tools** that return one-line answers.

## Optional: MCP inside Claude

Ask Claude "how many tokens did my crew use this week?", or save missions from regular Claude chats.

```
claude mcp add --transport http cloud-swat https://YOUR-SITE/mcp
```
Or in the Claude app: Settings → Connectors → Add custom connector → `https://YOUR-SITE/mcp`.

## Security

- No third-party dependencies (Node 22 built-ins only, including SQLite).
- Sign-in with GitHub/Google (OAuth with state + PKCE); sessions are HttpOnly, SameSite cookies, and tokens are stored only as hashes.
- Device linking uses a short-lived, single-use code you confirm in the browser. Device tokens can only *send* activity; they can't read anything.
- MCP uses OAuth 2.1 with PKCE (S256), single-use codes, rotating refresh tokens, exact redirect matching, and a consent page that warns about non-Claude apps.
- Strict CSP (no inline scripts or styles), HSTS, clickjacking and MIME-sniffing protection, CSRF tokens plus origin checks, rate limits and body-size limits.
- Secrets that look like keys or passwords are removed **on your computer** before anything is sent, and again on the server.
- Missions auto-delete after 30 days, and users can delete everything from their account page.

Run the security tests: `cd server && npm test`

## Self-host

See **[DEPLOY.md](DEPLOY.md)** (Railway, step by step).

## Privacy

Stored: your name/avatar, linked devices, mission titles, agent names, short action summaries, token counts and findings. Not stored: file contents, full commands, prompts or model replies.

---
Cloud SWAT is an independent community project and is not affiliated with Anthropic. MIT licensed.
