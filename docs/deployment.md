# Deployment Notes

This document records the supported deployment shapes and the issues found during a real server deployment.

## Recommended Shape

Run SessionInsight as a Node service behind an HTTPS reverse proxy.

```text
Browser
  -> HTTPS reverse proxy
  -> SessionInsight Node service
  -> local session files on the same machine
  -> optional outbound pushed session data from another machine
  -> sharded index/cache
```

The machine running SessionInsight must be able to read the agent session directories:

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
APP_MODE=production
SESSION_SOURCE=hybrid-index
SESSION_ACCESS_TOKEN=<long-random-token>
SESSION_PUSH_TOKENS=macbook:<different-long-random-token>
SESSION_DATA_DIR=/var/lib/session-insight
HOST=127.0.0.1
PORT=5173
```

Production startup currently fails closed when `SESSION_ACCESS_TOKEN` is missing.

`APP_MODE=production` means "run with production defaults and auth requirements". It does not control where session data comes from.

Session data source is controlled by `SESSION_SOURCE`.

Useful production values:

```text
local-index  = scan only the machine running the Node process
push-index   = serve only machines that push data over HTTPS
hybrid-index = scan the server machine and accept pushed machines
```

Machine tabs isolate these data sets in the UI.

Legacy `APP_MODE=remote` is still accepted as an alias for `APP_MODE=production`.

## systemd

See:

```text
deploy/systemd/session-insight.service.example
```

Important points:

- Use `NODE_ENV=production`.
- Use `APP_MODE=production`.
- Put `SESSION_ACCESS_TOKEN` in an environment file outside the repository.
- Put `SESSION_PUSH_TOKENS` in an environment file outside the repository when accepting pushed machines.
- Keep `SESSION_DATA_DIR` writable by the service user.
- Prefer binding to `127.0.0.1` when the reverse proxy runs on the host network.
- If a containerized reverse proxy must reach a host service, bind to a private bridge gateway address instead of `0.0.0.0`.

## Authentication Models

### Built-in Token Login

SessionInsight has built-in bearer-token authentication in production.

Open the site once with:

```text
https://your-domain.example/?token=<token>
```

The app writes an HttpOnly cookie and redirects to the clean URL.

For direct API checks, send the token explicitly:

```bash
curl -H "Authorization: Bearer <token>" \
  https://your-domain.example/api/health
```

### Reverse Proxy Basic Auth With Upstream Token Injection

If the reverse proxy already provides Basic Auth, SSO, or another access-control layer, a practical deployment is:

```text
Browser
  -> reverse proxy auth
  -> reverse proxy injects Authorization: Bearer <SESSION_ACCESS_TOKEN>
  -> SessionInsight
```

This keeps `SESSION_ACCESS_TOKEN` enabled, but users only complete the reverse proxy login.

Caddy example:

```caddyfile
session-insight.example.com {
  encode zstd gzip

  handle /api/push/* {
    reverse_proxy 127.0.0.1:5173
  }

  handle {
    basic_auth {
      user {$SESSION_INSIGHT_PASSWORD_HASH}
    }

    header {
      Strict-Transport-Security "max-age=31536000; includeSubDomains"
      X-Content-Type-Options "nosniff"
      X-Frame-Options "DENY"
      Referrer-Policy "strict-origin-when-cross-origin"
      -Server
    }

    reverse_proxy 127.0.0.1:5173 {
      header_up Authorization "Bearer {$SESSION_INSIGHT_TOKEN}"
    }
  }
}
```

`/api/push/*` is intentionally outside browser Basic Auth in this example so the laptop pusher does not need browser credentials. The push API still requires a machine-bound push token over HTTPS.

Generate the Caddy password hash on the server:

```bash
caddy hash-password --plaintext '<your-password>'
```

If Caddy is run by Docker Compose and the hash is stored in a `.env` file, escape every `$` as `$$`. Otherwise Docker Compose may treat parts of the bcrypt hash as environment variables and corrupt it.

Example:

```text
SESSION_INSIGHT_PASSWORD_HASH=$$2a$$14$$...
```

Do not commit the token, password, password hash, or real deployment domain.

## Dedicated Domain

For a dedicated domain, build with the default base path:

```bash
npm run build
```

Caddy example with only built-in token auth:

```caddyfile
session-insight.example.com {
  encode zstd gzip

  reverse_proxy 127.0.0.1:5173
}
```

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

Caddy example:

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

`BASE_PATH` is used by Vite so JavaScript, CSS, favicon, API calls, and SSE connect through the same prefix.

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

## Prebuilt Release Artifacts

GitHub can host already-built deployment artifacts. This is usually better than committing `dist/client` to the repository.

Recommended release artifact shape:

```text
session-insight-vX.Y.Z.tar.gz
  package.json
  package-lock.json
  server/
  scripts/
  dist/client/
  deploy/
  docs/
  README.md
  AGENTS.md
```

The artifact should not include:

```text
node_modules/
data/
.env*
real session files
tokens, passwords, password hashes, domains, or IP addresses
```

Deployment from a prebuilt artifact:

```bash
tar -xzf session-insight-vX.Y.Z.tar.gz -C /opt/session-insight
cd /opt/session-insight
npm ci --omit=dev
systemctl restart session-insight
```

This avoids running `npm run build` on the server. The server still needs a compatible Node runtime and must install production dependencies, but it does not need Vite, Rollup, or the Rollup native build dependency.

The best long-term release path is:

1. Push source to GitHub.
2. Use GitHub Actions to run `npm ci`, `npm run lint`, `npm test`, and `npm run build` on a modern Linux runner.
3. Package source plus `dist/client`.
4. Attach the tarball to a GitHub Release.
5. Let servers download that release artifact and run `npm ci --omit=dev`.

This repository includes `.github/workflows/release.yml` for that path.

Create a release by pushing a version tag:

```bash
git tag v0.1.1
git push origin v0.1.1
```

The workflow produces:

```text
session-insight-v0.1.1.tar.gz
session-insight-v0.1.1.tar.gz.sha256
```

Manual workflow runs also produce a downloadable workflow artifact, but only tag pushes publish a GitHub Release.

Alternative paths:

- Commit `dist/client` to Git: simple, but noisy and easy to forget to refresh.
- Publish a Docker image: most reproducible, but requires a container runtime and volume mapping for session directories.
- Build on every target server: simplest source workflow, but fails on older glibc servers.

## Real Deployment Findings

During a real server deployment:

- The service could read server-local Codex sessions through `SESSION_SOURCE=local-index`.
- `SESSION_SOURCE=hybrid-index` is required when the same web service should show server-local sessions and Mac-pushed sessions.
- The server did not have a Claude session directory yet.
- Direct server-side build failed because Rollup's native binary required newer glibc.
- Building locally, packaging the result, and copying `dist/client` to the server worked.
- Existing HTTPS was provided by a Caddy container.
- A dedicated domain was simpler than mounting under a subpath.
- Because Caddy ran in Docker, the Node service listened on a private Docker bridge gateway instead of `127.0.0.1`.
- Reverse proxy Basic Auth plus upstream bearer-token injection avoided a second browser login while keeping SessionInsight's production token enabled.
- `/api/push/*` must be reachable without browser Basic Auth if the Mac pusher is not going to send Basic Auth credentials. The push endpoint still requires a machine-bound push token.

## Smoke Tests

Local service health:

```bash
curl -sS http://127.0.0.1:5173/api/health
```

Internal authenticated API check:

```bash
TOKEN=$(sed -n 's/^SESSION_ACCESS_TOKEN=//p' /etc/session-insight/session-insight.env)
curl -sS -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:5173/api/providers/codex/projects
```

Public unauthenticated check should fail when reverse proxy auth is enabled:

```bash
curl -sS -o /dev/null -w "%{http_code}\n" https://session-insight.example.com/
```

Expected:

```text
401
```

Public authenticated check:

```bash
curl -u 'user:<password>' \
  https://session-insight.example.com/api/health
```

Expected:

```json
{"ok":true,"mode":"production","source":"hybrid-index"}
```

Push API should reject missing push tokens:

```bash
curl -sS -o /dev/null -w "%{http_code}\n" \
  https://session-insight.example.com/api/push/macbook/claude/manifest
```

Expected:

```text
401
```

One-shot laptop push:

```bash
SESSION_PUSH_URL=https://session-insight.example.com \
SESSION_PUSH_TOKEN=<push-token> \
SESSION_PUSH_MACHINE_ID=macbook \
SESSION_PUSH_MACHINE_LABEL="MacBook" \
npm run push -- --once
```
