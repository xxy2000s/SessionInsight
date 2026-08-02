# SessionInsight

SessionInsight is a web UI for inspecting local coding-agent session history by project.

It currently supports:

- Claude sessions from `~/.claude/projects`
- Codex sessions from `~/.codex/sessions`
- Doujie-linked Codex sessions from `~/.doujie/sessions/links`
- Project grouping, session search, subagent relationships, timeline rendering, Markdown output, and folded tool/system events
- File-change based live refresh through local filesystem watchers and SSE

## Modes

SessionInsight exposes two intended modes.

### Local Mode

Use this on your laptop or development machine.

```bash
npm install
npm run dev
```

Open:

```text
http://localhost:5173
```

Local mode scans session files owned by the user running the process and writes a local sharded index/cache under `./data`.

### Remote Mode

Use this on a server that itself runs the coding agents and has its own session files.

Remote mode does not require a Mac-to-server pusher. It scans the server's local session directories directly. In production, `SESSION_ACCESS_TOKEN` is required.

```bash
npm ci
npm run build

NODE_ENV=production \
APP_MODE=remote \
SESSION_ACCESS_TOKEN="<long-random-browser-token>" \
SESSION_DATA_DIR=/var/lib/session-insight \
HOST=127.0.0.1 \
PORT=5173 \
npm start
```

Put the Node service behind your HTTPS reverse proxy. Open the site once with:

```text
https://your-domain.example/?token=<long-random-browser-token>
```

The server sets an HttpOnly cookie and redirects to `/`.

## Session Paths

Default paths:

```text
~/.claude/projects
~/.codex/sessions
~/.doujie/sessions/links
```

Override them when the service user differs from the agent user:

```bash
CLAUDE_HOME=/home/agent/.claude
CODEX_HOME=/home/agent/.codex
DOUJIE_HOME=/home/agent/.doujie
```

Override the sharded index/cache directory:

```bash
SESSION_DATA_DIR=/var/lib/session-insight
```

## Useful Commands

```bash
npm run lint
npm test
npm run build
```

Legacy parser-debug direct scan:

```bash
npm run dev:scan
```

## Security Notes

- Do not expose the service without `SESSION_ACCESS_TOKEN` in production.
- Prefer `HOST=127.0.0.1` behind HTTPS reverse proxy.
- Do not commit `.env*`, `data/`, `dist/`, `node_modules/`, or real session files.
- Session histories may contain secrets, commands, file paths, source snippets, API output, and private reasoning/tool data.
- Tool/system events are folded or hidden by default in the UI, but authenticated users can still view full details.

## Open Source Hygiene

This repository should not include:

- Real tokens, cookies, SSH aliases, domains, or IP addresses
- Personal absolute paths
- Runtime session data
- Build artifacts
- Existing private Git history from another project

See [docs/open-source-release.md](docs/open-source-release.md) for a release checklist.

