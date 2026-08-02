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

It scans session files on the machine running the Node process and writes them into a persistent sharded index/cache under the local machine tab.

```text
SESSION_SOURCE=local-index
SESSION_LOCAL_MACHINE_ID=server
SESSION_LOCAL_MACHINE_LABEL=Server
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

### Push Index

`SESSION_SOURCE=push-index` serves only machine data pushed over HTTPS.

The server requires:

```text
SESSION_PUSH_TOKENS=macbook:<long random token>
```

Mac-side pusher example:

```bash
SESSION_PUSH_URL=https://your-domain.example \
SESSION_PUSH_TOKEN=... \
SESSION_PUSH_MACHINE_ID=macbook \
SESSION_PUSH_MACHINE_LABEL="MacBook" \
npm run push -- --once
```

### Hybrid Index

`SESSION_SOURCE=hybrid-index` combines:

```text
server-local session scanning
outbound pushed machine data
```

The UI shows each machine as a top-level tab. Each machine keeps its own provider/project/session tree, so identical session ids or project paths on different machines do not collide.

Push tokens are bound to machine ids. A token configured for `macbook` cannot write to the `server` machine or another pushed machine.

### Local Scan Debug Mode

`SESSION_SOURCE=local-scan` bypasses the persistent sharded cache and directly scans files on request.

```bash
npm run dev:scan
```

Use it only when debugging parsers.

## Path Overrides

Use these when the service user is not the same user that runs the agents:

```bash
CLAUDE_HOME=/home/agent/.claude
CODEX_HOME=/home/agent/.codex
DOUJIE_HOME=/home/agent/.doujie
SESSION_DATA_DIR=/var/lib/session-insight
```

The service account must be able to read the session directories and write `SESSION_DATA_DIR`.
