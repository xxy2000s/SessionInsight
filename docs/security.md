# Security Notes

SessionInsight displays agent session history. Treat the data as sensitive.

## Sensitive Data

Session histories may include:

- prompts and assistant responses
- source code snippets
- shell commands and command output
- tool parameters and tool results
- file paths and URLs
- API responses
- accidental secrets from terminal output or files

Tool and system events are hidden or folded by default in the UI, but authenticated users can still request full details.

## Production Requirements

- Set `SESSION_ACCESS_TOKEN`.
- Bind Node to `HOST=127.0.0.1` unless you deliberately know otherwise.
- Put the service behind HTTPS reverse proxy.
- Keep the cache directory private to the service user.
- Do not commit runtime data or environment files.

Production startup fails without `SESSION_ACCESS_TOKEN`.

## Token Login

Open the site once with:

```text
https://your-domain.example/?token=<token>
```

The server writes an HttpOnly cookie and redirects to `/`.

Use HTTPS so the cookie receives the `Secure` attribute via `X-Forwarded-Proto: https` or direct TLS.

## Future Hardening

Useful follow-ups before broad public use:

- configurable redaction for common secrets
- security headers such as CSP, Referrer-Policy, and X-Content-Type-Options
- optional basic auth / OAuth integration at the reverse proxy layer
- retention controls for old indexed sessions

