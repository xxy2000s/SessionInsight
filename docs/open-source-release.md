# Open Source Release Checklist

Use a clean repository or an orphan branch for the first public release. Do not publish private development history from another project.

## Files That Must Not Be Published

```text
.env
.env.*
data/
dist/
node_modules/
.playwright-cli/
```

`.env.example` is allowed in the public release because it contains placeholders only.

Do not publish real:

- domains or IP addresses
- SSH aliases
- tokens, cookies, or API keys
- personal absolute paths
- session JSONL files or sharded cache data

## Suggested Checks

```bash
git status --short
git ls-files '.env*' data dist node_modules .playwright-cli
rg -n --hidden -g '!node_modules' -g '!dist' -g '!data' '(Bearer |token=|SESSION_ACCESS_TOKEN=|api[_-]?key|secret|password|PRIVATE KEY|/Users/|ssh .*@|[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+)' .
npm run lint
npm test
npm run build
```

If this project was derived from a private repo, prefer:

```bash
git init
git add .
git commit -m "initial public release"
```

rather than pushing the old private Git history.
