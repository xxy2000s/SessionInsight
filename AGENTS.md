# Agent Handoff Guide

This file is the entry point for agents working on SessionInsight.

## Project Goal

Build and maintain an open-source session browser for Claude, Codex, and Doujie coding-agent conversations. The main supported behavior is local parsing on the machine running the service, with separate local and remote deployment modes.

## First Facts To Check

```bash
git status --short
curl -s http://localhost:5173/api/health 2>/dev/null || true
```

Read these before changing runtime behavior or deployment docs:

- `README.md`
- `docs/modes.md`
- `docs/deployment.md`
- `docs/security.md`
- `docs/open-source-release.md`

## Key Files

- `server/index.mjs`: HTTP server, API routes, auth, SSE, static serving.
- `server/claudeSessions.mjs`: Claude local scanner/parser.
- `server/codexSessions.mjs`: Codex and Doujie local scanner/parser.
- `server/localIndex.mjs`: local filesystem ingestion into sharded index/cache.
- `server/sessionStore.mjs`: shared sharded store implementation used by the local index/cache.
- `src/main.jsx`: React app state and timeline rendering.
- `src/styles.css`: desktop/mobile layout and event card styling.
- `tests/*.test.mjs`: parser and store tests.

## Runtime Contracts

- Official modes are `APP_MODE=local` and `APP_MODE=remote`.
- Both official modes scan the machine running the service.
- `SESSION_SOURCE=local-index` is the default read path.
- `SESSION_SOURCE=local-scan` is only for parser debugging.
- Production requires `SESSION_ACCESS_TOKEN`.
- Default host is `127.0.0.1`; use a reverse proxy for public HTTPS.
- Provider order is Codex, Claude, Doujie.
- Default provider is Codex.
- Tool and system events are hidden by default.
- Markdown rendering is on by default.
- `Previous` and `Next` navigate valid user input messages only.
- Subagents should appear under their parent session when parent resolution is possible.
- Info and Subagents popovers should close on Escape and outside click.
- Mobile should use a workspace drawer, not stacked workspace/session views.

## Required Checks

Before reporting code changes as done:

```bash
npm run lint
npm test
npm run build
```

For UI changes, verify with a real browser at desktop and mobile widths.

## Privacy Rules

Never commit:

- `.env*`
- `data/`
- `dist/`
- `node_modules/`
- real session history
- real domains, IP addresses, tokens, cookies, SSH aliases, or personal paths

If documentation needs examples, use placeholders such as `your-domain.example`, `/home/agent`, or `/var/lib/session-insight`.
