# SessionInsight

SessionInsight is a web UI for inspecting local coding-agent session history by project.

It currently supports:

- Claude sessions from `~/.claude/projects`
- Codex sessions from `~/.codex/sessions`
- Doujie-linked Codex sessions from `~/.doujie/sessions/links`
- Machine tabs for isolating server-local sessions from pushed laptop sessions
- Project grouping, session search, subagent relationships, timeline rendering, Markdown output, and folded tool/system events
- File-change based live refresh through local filesystem watchers and SSE
- Optional outbound session push from another machine without exposing that machine to inbound traffic

## Modes

SessionInsight separates runtime mode from data source mode.

Runtime mode:

- `APP_MODE=dev`: local development.
- `APP_MODE=production`: deployed service with production auth requirements.

Data source mode:

- `SESSION_SOURCE=local-index`: default; scan session files on the machine running the Node process and store them in the local sharded index/cache.
- `SESSION_SOURCE=local-scan`: parser-debug mode that scans directly on request.
- `SESSION_SOURCE=hybrid-index`: scan the server-local machine and also accept pushed machine data.
- `SESSION_SOURCE=push-index`: accept pushed machine data without server-local scanning.

Legacy `APP_MODE=local` and `APP_MODE=remote` values are still accepted as aliases for `dev` and `production`.

### Local Development

Use this on your laptop or development machine.

```bash
npm install
npm run dev
```

Open:

```text
http://localhost:5173
```

With the default `SESSION_SOURCE=local-index`, the service scans session files owned by the user running the process and writes a local sharded index/cache under `./data`.

### Production Deployment

Use this on a server or workstation that runs the service behind HTTPS reverse proxy.

Production mode still uses the configured data source mode. With the default `SESSION_SOURCE=local-index`, it scans the current machine's local session directories directly. It does not mean Mac-to-server push ingestion.

```bash
npm ci
npm run build

NODE_ENV=production \
APP_MODE=production \
SESSION_SOURCE=hybrid-index \
SESSION_ACCESS_TOKEN="<long-random-browser-token>" \
SESSION_PUSH_TOKENS="macbook:<different-long-random-push-token>" \
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

For real deployment notes, including `BASE_PATH`, Caddy examples, Docker bridge networking, reverse proxy auth, and Rollup/glibc build compatibility, see [docs/deployment.md](docs/deployment.md). Known deployment and maintenance pitfalls are collected in [docs/pitfalls.md](docs/pitfalls.md).

Chinese deployment notes are available at [docs/deployment.zh-CN.md](docs/deployment.zh-CN.md).

## Outbound Push

To show laptop sessions on a remote server without opening inbound laptop ports, run the web service in `SESSION_SOURCE=hybrid-index` and run the pusher on the laptop:

```bash
SESSION_PUSH_URL=https://your-domain.example \
SESSION_PUSH_TOKEN="<server-push-token>" \
SESSION_PUSH_MACHINE_ID=macbook \
SESSION_PUSH_MACHINE_LABEL="MacBook" \
npm run push -- --once
```

Omit `--once` to keep watching local session files and pushing incremental changes.

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
- Do not reuse `SESSION_ACCESS_TOKEN` as a push token.
- Bind push tokens to machine ids with `SESSION_PUSH_TOKENS=macbook:<token>`.
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
