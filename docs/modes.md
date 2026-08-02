# Modes

SessionInsight has two supported public modes.

## Local Mode

Local mode is for a developer machine.

```bash
npm run dev
```

Defaults:

```text
APP_MODE=local
NODE_ENV=development
SESSION_SOURCE=local-index
HOST=127.0.0.1
PORT=5173
SESSION_DATA_DIR=./data
```

It scans session files for the current OS user:

```text
~/.claude/projects
~/.codex/sessions
~/.doujie/sessions/links
```

## Remote Mode

Remote mode is for a server that itself runs the coding agents and therefore has local session files.

```bash
NODE_ENV=production APP_MODE=remote SESSION_ACCESS_TOKEN=... npm start
```

Defaults and recommendations:

```text
APP_MODE=remote
NODE_ENV=production
SESSION_SOURCE=local-index
HOST=127.0.0.1
PORT=5173
SESSION_DATA_DIR=/var/lib/session-insight
```

Run it behind HTTPS reverse proxy. Production startup fails when `SESSION_ACCESS_TOKEN` is not set.

## Path Overrides

Use these when the service user is not the same user that runs the agents:

```bash
CLAUDE_HOME=/home/agent/.claude
CODEX_HOME=/home/agent/.codex
DOUJIE_HOME=/home/agent/.doujie
SESSION_DATA_DIR=/var/lib/session-insight
```

The service account must be able to read the session directories and write `SESSION_DATA_DIR`.

## Debug Mode

`SESSION_SOURCE=local-scan` bypasses the persistent sharded cache and directly scans files on request.

```bash
npm run dev:scan
```

Use it only when debugging parsers.

