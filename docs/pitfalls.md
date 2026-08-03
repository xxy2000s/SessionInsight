# Pitfalls

This file records deployment and maintenance pitfalls that have already caused issues. Read it before changing remote deployment, reverse proxy authentication, release packaging, or push ingestion.

## Caddy Basic Auth Hashes

Some Caddy 2.10 Docker images print a raw bcrypt hash from:

```bash
caddy hash-password --plaintext '<password>'
```

The hash can look like `$2a$...`, but `basic_auth` may load the configured password value as base64. When Caddy runs through Docker Compose and the hash is stored in `.env`, use this safer shape:

```bash
BCRYPT_HASH="$(docker run --rm caddy:2.10.2-alpine caddy hash-password --plaintext '<password>')"
SESSION_INSIGHT_PASSWORD_HASH="$(printf '%s' "$BCRYPT_HASH" | base64 | tr -d '\n')"
```

Do not blindly replace `$` with `$$`. In this deployment, that made the container receive an invalid value and caused a Caddy restart loop with errors like:

```text
base64-decoding password: illegal base64 data
```

Validation commands:

```bash
docker compose exec -T caddy caddy validate --config /etc/caddy/Caddyfile
curl -k -s -u 'user:<password>' https://your-domain.example/api/health
```

## Caddy Bind Mounts And Recreate

If `/etc/caddy/Caddyfile` is bind-mounted from the host and the host file is replaced atomically, the running container can keep the old mounted inode. In that case, the host file and the container file may differ.

Check both sides:

```bash
sed -n '20,48p' /opt/slow/Caddyfile
docker exec slow-caddy-1 sed -n '20,48p' /etc/caddy/Caddyfile
docker inspect slow-caddy-1 --format '{{range .Mounts}}{{println .Source "->" .Destination}}{{end}}'
```

If they differ, recreate the Caddy container instead of only reloading:

```bash
cd /opt/slow
docker compose up -d --force-recreate caddy
```

## Basic Auth Credential Leakage During Browser Tests

Do not open URLs like this in tools that print page URLs or snapshots:

```text
https://user:password@your-domain.example/
```

Use a browser context with HTTP credentials instead. If a password is printed in logs or command output, rotate it immediately, update the Caddy hash, recreate Caddy, and verify the new password returns `200`.

## Remote Password Source

For deployments that keep the browser password in a server-side password file, Caddy will not pick up password-file changes automatically. Regenerate the hash, update the reverse proxy environment file, recreate Caddy, and verify:

```bash
PASSWORD="$(cat /path/to/password-file)"
curl -k -s -u "user:${PASSWORD}" https://your-domain.example/api/health
```

Never print the password file content or the generated hash in logs.

## GitHub SSH Port 22

GitHub SSH on port `22` can fail in this environment with:

```text
Connection closed by ... port 22
```

Use GitHub SSH over port `443` without changing permanent Git config:

```bash
GIT_SSH_COMMAND='ssh -p 443 -o HostName=ssh.github.com -o BatchMode=yes' git push origin master
GIT_SSH_COMMAND='ssh -p 443 -o HostName=ssh.github.com -o BatchMode=yes' git push origin vX.Y.Z
```

## GitHub API Rate Limits

Unauthenticated GitHub API polling can hit rate limits. When waiting for a release artifact, prefer checking the public asset URL directly:

```bash
curl -L -s -o /tmp/session-insight.sha256 -w '%{http_code}' \
  https://github.com/<owner>/<repo>/releases/download/vX.Y.Z/session-insight-vX.Y.Z.tar.gz.sha256
```

## Server-Side Builds

Do not assume `npm run build` works on the target server. Older glibc hosts can fail on Rollup native optional dependencies. The reliable path is:

1. Build in GitHub Actions or a compatible local machine.
2. Publish a release artifact containing `dist/client`.
3. Deploy the artifact to the server.
4. Run `npm ci --omit=dev` on the server.

## Machine-Scoped Push Auth

Normalize machine IDs before every push auth decision. The route value, token map key, default-machine check, store write, and SSE event must use the same normalized ID.

Security regression to keep:

```text
/api/push/server/... with a macbook token -> 401
/api/push/SERVER/... with a macbook token -> 401
```

Do not allow a pushed machine token to write the default server machine unless explicitly enabled.

## Snapshot And Delete Safety

Snapshot push is destructive because it can replace a whole machine/provider. Keep it disabled by default. Empty snapshots must require an explicit flag.

The Mac pusher should refuse suspicious deletes:

- local scan returns zero files while remote manifest has entries
- delete ratio is above `SESSION_PUSH_MAX_DELETE_RATIO` unless explicitly allowed

## Push Logging

Push logs must not include tokens, real session content, or local file paths. Default error logging should be sanitized. Verbose stack logging should remain opt-in only:

```bash
SESSION_PUSH_VERBOSE_ERRORS=1 npm run push
```

Use verbose mode only in a trusted local terminal.

## Real Data In Tests

End-to-end tests should use synthetic session files under temporary directories. Do not test push ingestion by reading real `~/.claude`, `~/.codex`, or `~/.doujie` data unless the user explicitly asks for that.

After synthetic remote push tests, delete the synthetic pushed session and verify the test machine/provider counts are back to zero when appropriate.

## Subagent Review Scope

When using subagents for review, make the target repository explicit. A previous review accidentally inspected the old private `devix` worktree instead of the open-source `session-insight` worktree. The prompt should include:

```text
/path/to/session-insight
```

and should tell the agent not to read real session directories or secret files.
