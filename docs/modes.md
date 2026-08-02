# Modes

SessionInsight separates runtime mode from data source mode.

Runtime mode answers "how is the app running?"

Data source mode answers "where does session data come from?"

## Runtime Modes

### Dev Mode

Dev mode is for local development.

```bash
npm run dev
```

Defaults:

```text
APP_MODE=dev
NODE_ENV=development
HOST=127.0.0.1
PORT=5173
```

### Production Mode

Production mode is for a deployed service behind HTTPS reverse proxy.

```bash
NODE_ENV=production APP_MODE=production SESSION_ACCESS_TOKEN=... npm start
```

Defaults and recommendations:

```text
APP_MODE=production
NODE_ENV=production
HOST=127.0.0.1
PORT=5173
```

Production startup fails when `SESSION_ACCESS_TOKEN` is not set.

Legacy values are still accepted for compatibility:

```text
APP_MODE=local  -> dev
APP_MODE=remote -> production
```

## Data Source Modes

### Local Index

`SESSION_SOURCE=local-index` is the default data source mode.

It scans session files on the machine running the Node process and writes them into a persistent sharded index/cache.

```text
SESSION_SOURCE=local-index
SESSION_DATA_DIR=./data                   # dev default
SESSION_DATA_DIR=/var/lib/session-insight # production recommendation
```

Default scanned paths:

```text
~/.claude/projects
~/.codex/sessions
~/.doujie/sessions/links
```

This has the same data behavior on a laptop and on a server: it reads the current machine's session files.

### Local Scan Debug Mode

`SESSION_SOURCE=local-scan` bypasses the persistent sharded cache and directly scans files on request.

```bash
npm run dev:scan
```

Use it only when debugging parsers.

### Future Linked / Push Mode

A future linked data mode should be separate from `APP_MODE`.

Potential shape:

```text
APP_MODE=production
SESSION_SOURCE=hybrid-index
```

That mode would combine:

```text
server-local session scanning
Mac-side outbound session push
```

The current open-source version does not yet implement push ingestion.

## Path Overrides

Use these when the service user is not the same user that runs the agents:

```bash
CLAUDE_HOME=/home/agent/.claude
CODEX_HOME=/home/agent/.codex
DOUJIE_HOME=/home/agent/.doujie
SESSION_DATA_DIR=/var/lib/session-insight
```

The service account must be able to read the session directories and write `SESSION_DATA_DIR`.
