# Deployment Notes

This document records the current production deployment model and the issues found during a real server deployment.

## Recommended Deployment Shape

Run SessionInsight as a Node service behind an HTTPS reverse proxy.

```text
Browser
  -> HTTPS reverse proxy
  -> SessionInsight Node service
  -> local session files on the same machine
  -> sharded index/cache
```

The server running SessionInsight must be able to read the local agent session directories:

```text
~/.claude/projects
~/.codex/sessions
~/.doujie/sessions/links
```

If the service user differs from the agent user, set:

```bash
CLAUDE_HOME=/home/agent/.claude
CODEX_HOME=/home/agent/.codex
DOUJIE_HOME=/home/agent/.doujie
```

## Production Environment

Baseline production environment:

```bash
NODE_ENV=production
APP_MODE=remote
SESSION_ACCESS_TOKEN=<long-random-token>
SESSION_DATA_DIR=/var/lib/session-insight
HOST=127.0.0.1
PORT=5173
```

Production currently fails closed when `SESSION_ACCESS_TOKEN` is missing.

## systemd

See:

```text
deploy/systemd/session-insight.service.example
```

Important points:

- Use `NODE_ENV=production`.
- Use `APP_MODE=remote`.
- Put `SESSION_ACCESS_TOKEN` in an environment file outside the repository.
- Keep `SESSION_DATA_DIR` writable by the service user.
- Prefer binding to `127.0.0.1` when the reverse proxy runs on the host network.

## Build Compatibility

On some Linux servers, `npm run build` can fail even though the Node service can run.

The observed failure was:

```text
/lib64/libc.so.6: version `GLIBC_2.33' not found
```

Cause:

- `vite build` uses Rollup.
- Rollup installs a platform-specific native optional dependency such as `@rollup/rollup-linux-x64-gnu`.
- That native binary may require a newer glibc than the server provides.
- Runtime serving does not use Rollup, so `node server/index.mjs` can still run.

Practical options:

1. Build on a compatible machine and copy `dist/client` to the server.
2. Build inside a modern Docker image and copy or run the result.
3. Upgrade the server OS to a distro with a compatible glibc.

Avoid manually upgrading glibc on a production host unless you are deliberately managing the OS, because it can break system tools.

## Subpath Deployment

If SessionInsight is mounted under a path instead of its own domain, build with `BASE_PATH`.

Example:

```bash
BASE_PATH=/session-insight/ npm run build
```

Then route the same path prefix to the Node service:

```text
https://your-domain.example/session-insight/
```

`BASE_PATH` is used by Vite so that JavaScript, CSS, favicon, API calls, and SSE connect through the same prefix.

## Caddy Examples

### Dedicated Domain

```caddyfile
session-insight.example.com {
  encode zstd gzip

  reverse_proxy 127.0.0.1:5173
}
```

Build with the default base path:

```bash
npm run build
```

### Subpath On Existing Domain

```caddyfile
example.com {
  encode zstd gzip

  handle_path /session-insight* {
    reverse_proxy 127.0.0.1:5173
  }

  handle {
    reverse_proxy app:80
  }
}
```

Build with:

```bash
BASE_PATH=/session-insight/ npm run build
```

## Caddy In Docker

If Caddy runs inside Docker and SessionInsight runs on the host, `127.0.0.1` inside the Caddy container points to the container, not the host.

Options:

1. Put SessionInsight in the same Docker network and reverse proxy by container name.
2. Bind SessionInsight to the Docker bridge gateway address and proxy to that address.
3. Run Caddy with host networking.

Example bridge-gateway shape:

```text
SessionInsight HOST=172.20.0.1
Caddy reverse_proxy 172.20.0.1:5173
```

Find the gateway address with:

```bash
ip -4 addr show
docker inspect <caddy-container>
```

Only use a bridge address that is not publicly reachable. Do not bind SessionInsight directly to `0.0.0.0` unless you are intentionally exposing it.

## Authentication Options

Current built-in production auth uses `SESSION_ACCESS_TOKEN`.

Flow:

```text
https://your-domain.example/?token=<token>
```

or, for subpath deployment:

```text
https://your-domain.example/session-insight/?token=<token>
```

The app writes an HttpOnly cookie and redirects to the clean URL.

If the reverse proxy already enforces Basic Auth or SSO, this creates two authentication layers:

```text
reverse proxy auth
SessionInsight token auth
```

This is secure but inconvenient.

Planned improvement:

```text
TRUST_REVERSE_PROXY_AUTH=1
```

When implemented, production could run without `SESSION_ACCESS_TOKEN` only when protected by a trusted reverse proxy. Until then, keep the token enabled.

## Real Deployment Findings

During a real server deployment:

- The service could read server-local Codex sessions.
- The server did not have a Claude session directory yet.
- Direct server-side build failed because Rollup's native binary required newer glibc.
- Building locally and copying `dist/client` worked.
- Existing HTTPS was provided by a Caddy container.
- Subpath deployment required `BASE_PATH=/session-insight/`.
- Because Caddy ran in Docker, the Node service had to listen on the Docker bridge gateway instead of `127.0.0.1`.
- Existing reverse proxy Basic Auth plus `SESSION_ACCESS_TOKEN` produced two login steps.

## Smoke Tests

Local service health:

```bash
curl -sS http://127.0.0.1:5173/api/health
```

Authenticated API check:

```bash
TOKEN=$(sed -n 's/^SESSION_ACCESS_TOKEN=//p' /etc/session-insight/session-insight.env)
curl -sS -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:5173/api/providers/codex/projects
```

Subpath static asset check:

```bash
curl -I https://your-domain.example/session-insight/
```

