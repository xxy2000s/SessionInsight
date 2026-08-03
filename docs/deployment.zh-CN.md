# 部署说明

这份文档用中文说明 SessionInsight 当前适合怎么部署，以及实际部署时踩到的问题。文档刻意不记录真实域名、IP、token、密码或 hash，避免开源时泄漏信息。

## 当前服务模型

SessionInsight 的推荐部署方式是：

```text
浏览器
  -> HTTPS 反向代理
  -> SessionInsight Node 服务
  -> 当前机器上的 agent session 文件
  -> 可选：其他机器通过 outbound push 推上来的 session
  -> 本地分片索引/cache
```

也就是说，服务会解析“运行它的那台机器”上的会话文件：

```text
~/.claude/projects
~/.codex/sessions
~/.doujie/sessions/links
```

如果 Node 服务使用的系统用户和实际运行 Claude/Codex/Doujie 的用户不同，需要显式指定路径：

```bash
CLAUDE_HOME=/home/agent/.claude
CODEX_HOME=/home/agent/.codex
DOUJIE_HOME=/home/agent/.doujie
```

## 本地模式

本地开发或本机使用：

```bash
npm install
npm run dev
```

默认访问：

```text
http://localhost:5173
```

本地模式默认会扫描当前用户的 session 文件，并把索引/cache 写入项目里的 `./data`。

## 服务器模式

服务器模式适合“服务器自己也运行 Codex/Claude/Doujie，并希望通过 Web 查看这台服务器上的 session”。

推荐环境变量：

```bash
NODE_ENV=production
APP_MODE=production
SESSION_SOURCE=hybrid-index
SESSION_ACCESS_TOKEN=<长随机 token>
SESSION_PUSH_TOKENS=macbook:<另一个长随机 push token>
SESSION_DATA_DIR=/var/lib/session-insight
HOST=127.0.0.1
PORT=5173
```

注意：`APP_MODE=production` 只表示生产运行模式，例如强制鉴权、通常放在 HTTPS 反代后面。它不表示 session 数据来自哪里。

session 数据来源由 `SESSION_SOURCE` 控制。

生产里常用的值：

```text
local-index  = 只扫描运行 Node 服务的当前机器
push-index   = 只展示通过 HTTPS 推上来的机器
hybrid-index = 扫描服务器本机，同时接收其他机器推送
```

Web UI 会把不同机器作为最外层 tab 隔离展示，避免不同机器的相同 session id 或相同项目路径互相覆盖。

旧的 `APP_MODE=remote` 仍然兼容，会被当成 `APP_MODE=production`。

生产环境必须设置 `SESSION_ACCESS_TOKEN`，否则服务会拒绝启动。

## 当前实际采用的 HTTPS 接入方式

当前更合理的方式是给 SessionInsight 一个独立域名，并放在 Caddy 后面：

```text
浏览器
  -> Caddy HTTPS
  -> Caddy Basic Auth
  -> Caddy 自动注入 Authorization: Bearer <SESSION_ACCESS_TOKEN>
  -> SessionInsight Node 服务
```

这样浏览器侧只需要输入 Caddy 的账号密码，不需要再在 URL 里手动带 `?token=`。同时，SessionInsight 自身的 `SESSION_ACCESS_TOKEN` 仍然保留，Node 服务不会裸露。

Caddy 示例：

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

这里 `/api/push/*` 没有放在浏览器 Basic Auth 后面，是为了让 Mac pusher 不需要携带浏览器账号密码。push API 自己仍然要求绑定到机器 id 的 push token，并且必须走 HTTPS。

其中：

- `SESSION_INSIGHT_PASSWORD_HASH` 是 Caddy Basic Auth 的密码 hash。
- `SESSION_INSIGHT_TOKEN` 要和 Node 服务里的 `SESSION_ACCESS_TOKEN` 一致。
- 真实密码、token、hash 都应该放在服务器环境文件里，不要提交到 Git。

生成 Caddy 密码 hash：

```bash
caddy hash-password --plaintext '<你的密码>'
```

有些 Caddy 2.10 Docker 镜像的 `hash-password` 仍会输出 `$2a$...` 这样的原始 bcrypt 字符串，但 `basic_auth` 加载配置时会把密码字段当成 base64 解码。如果输出中包含 `$`，推荐先把 bcrypt hash 做 base64 编码，再写入 Docker Compose 的 `.env`。这样也能避免 Compose 把 `$...` 当作变量展开。

示例：

```bash
BCRYPT_HASH="$(docker run --rm caddy:2.10.2-alpine caddy hash-password --plaintext '<你的密码>')"
SESSION_INSIGHT_PASSWORD_HASH="$(printf '%s' "$BCRYPT_HASH" | base64 | tr -d '\n')"
```

## Caddy 在 Docker 里时的注意点

如果 Caddy 在 Docker 容器里，而 SessionInsight Node 服务跑在宿主机上，那么 Caddy 容器里的 `127.0.0.1` 指向的是 Caddy 容器自己，不是宿主机。

可选方案：

1. 把 SessionInsight 也放进同一个 Docker network，用容器名反代。
2. 让 SessionInsight 监听 Docker bridge gateway 地址，Caddy 反代到这个地址。
3. Caddy 使用 host network。

实际部署中采用的是第 2 类方案：

```text
SessionInsight HOST=<Docker bridge gateway>
Caddy reverse_proxy <Docker bridge gateway>:5173
```

这个地址必须是内网 bridge 地址，不应该直接把 Node 服务绑定到公网 `0.0.0.0`。

## 构建兼容性问题

实际服务器上遇到过：

```text
/lib64/libc.so.6: version `GLIBC_2.33' not found
```

原因是：

- `npm run build` 会调用 Vite/Rollup。
- Rollup 会安装平台相关的 native optional dependency。
- 某些 Rollup native 包需要比服务器更高版本的 glibc。
- 但 Node 运行服务本身不依赖这个 Rollup native 包，所以 `npm start` 仍然可以跑。

当前可行做法：

1. 在本地或兼容环境中运行 `npm run build`。
2. 把源码同步到服务器。
3. 把本地生成的 `dist/client` 同步到服务器。
4. 重启服务器上的 systemd 服务。

不要为了这个问题手动升级生产服务器的 glibc，风险比较高。

## 预构建产物发布

GitHub 支持发布已经构建好的产物。更推荐放在 GitHub Release 里，而不是把 `dist/client` 直接提交进 Git 仓库。

推荐的 release 包结构：

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

不要包含：

```text
node_modules/
data/
.env
.env.*
真实 session 文件
token、密码、密码 hash、真实域名、IP
```

`.env.example` 会包含在产物里，因为它只包含占位示例，不包含真实密钥。

服务器部署时可以这样：

```bash
tar -xzf session-insight-vX.Y.Z.tar.gz -C /opt/session-insight
cd /opt/session-insight
npm ci --omit=dev
systemctl restart session-insight
```

这样服务器不需要执行 `npm run build`，也就绕开了 Vite/Rollup native 包和 glibc 的问题。服务器仍然需要有合适的 Node 版本，并且需要安装生产依赖，但不需要安装和运行 Vite/Rollup 构建链。

长期更合理的发布方式是：

1. 源码推到 GitHub。
2. GitHub Actions 在现代 Linux runner 上执行 `npm ci`、`npm run lint`、`npm test`、`npm run build`。
3. 把源码和 `dist/client` 打成 tarball。
4. 挂到 GitHub Release。
5. 服务器直接下载这个 release 包，执行 `npm ci --omit=dev` 后启动。

仓库里已经提供 `.github/workflows/release.yml`。发版方式是推一个版本 tag：

```bash
git tag v0.1.1
git push origin v0.1.1
```

GitHub Actions 会生成：

```text
session-insight-v0.1.1.tar.gz
session-insight-v0.1.1.tar.gz.sha256
```

手动运行 workflow 也会生成可下载的 workflow artifact，但只有推 tag 才会发布到 GitHub Release。

几个方案的取舍：

- 直接提交 `dist/client` 到 Git：最简单，但每次前端变化都会产生大量构建文件 diff，容易忘记更新。
- 用 GitHub Release 放构建产物：比较适合开源项目和服务器部署。
- 发布 Docker 镜像：最稳定可复现，但服务器要跑容器，并正确挂载 session 目录。
- 每台服务器自己 `npm run build`：流程简单，但老 glibc 服务器可能失败。

## 子路径部署

如果不是独立域名，而是挂在现有域名的某个路径下，例如：

```text
https://your-domain.example/session-insight/
```

构建时需要：

```bash
BASE_PATH=/session-insight/ npm run build
```

现在独立域名部署更简单，所以一般不需要 `BASE_PATH`。

## 验证方式

服务内部健康检查：

```bash
curl -sS http://127.0.0.1:5173/api/health
```

如果 Node 服务监听的是 Docker bridge gateway，就把 `127.0.0.1` 换成对应 bridge 地址。

通过 token 检查内部 API：

```bash
TOKEN=$(sed -n 's/^SESSION_ACCESS_TOKEN=//p' /etc/session-insight/session-insight.env)
curl -sS -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:5173/api/providers/codex/projects
```

公网未登录访问应该返回 `401`：

```bash
curl -sS -o /dev/null -w "%{http_code}\n" https://session-insight.example.com/
```

公网使用 Basic Auth 后应该能访问：

```bash
curl -u 'user:<password>' \
  https://session-insight.example.com/api/health
```

期望返回：

```json
{"ok":true,"mode":"production","source":"hybrid-index"}
```

push API 未带 push token 应该返回 `401`：

```bash
curl -sS -o /dev/null -w "%{http_code}\n" \
  https://session-insight.example.com/api/push/macbook/claude/manifest
```

Mac 一次性推送：

```bash
SESSION_PUSH_URL=https://session-insight.example.com \
SESSION_PUSH_TOKEN=<push-token> \
SESSION_PUSH_MACHINE_ID=macbook \
SESSION_PUSH_MACHINE_LABEL="MacBook" \
npm run push -- --once
```

## 当前已知状态

更细的踩坑记录和排障命令见 [pitfalls.md](pitfalls.md)，包括 Caddy Basic Auth hash、GitHub SSH 443、push 安全和浏览器测试凭据处理。

当前部署已经验证过的事实：

- 独立域名 HTTPS 接入可用。
- Caddy Basic Auth 可用，未登录访问会返回 `401`。
- Caddy 会向 SessionInsight 自动注入 bearer token，所以浏览器侧不需要再输入 `?token=`。
- Node 服务仍然保留 `SESSION_ACCESS_TOKEN`，没有裸奔。
- 服务器本地 Codex session 可以通过 `SESSION_SOURCE=local-index` 被解析。
- 如果要同时看服务器本机和 Mac 本机数据，应使用 `SESSION_SOURCE=hybrid-index`，并通过 machine tab 隔离两边数据。
- 服务器上暂时没有 Claude session 目录时，Claude 项目为空是正常现象。
- 服务器直接 `npm run build` 可能因为 glibc/Rollup native 包失败，当前用本地构建、打包、同步 `dist/client` 的方式绕过。
- 以后可以改成 GitHub Actions 构建 release 包，服务器直接拉预构建产物，不依赖你的本地 Mac。
