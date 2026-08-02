import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGunzip, gzipSync } from "node:zlib";
import chokidar from "chokidar";
import {
  clearSessionCache,
  getClaudeHome,
  getProjectSessions,
  getSessionDetail,
  scanClaudeSessions,
} from "./claudeSessions.mjs";
import {
  clearCodexSessionCache,
  clearDoujieSessionCache,
  getCodexHome,
  getDoujieHome,
  getCodexProjectSessions,
  getCodexSessionDetail,
  getDoujieProjectSessions,
  getDoujieSessionDetail,
  scanCodexSessions,
  scanDoujieSessions,
} from "./codexSessions.mjs";
import {
  clearLocalIndexCache,
  ensureLocalProviderIndex,
  getLocalProviderConfig,
  rebuildLocalProviderIndex,
  syncLocalProviderPath,
} from "./localIndex.mjs";
import {
  deletePushedSession,
  getDefaultMachineId,
  getMachines,
  getPushedIndex,
  getPushedManifest,
  getPushedProjectSessions,
  getPushedSessionDetail,
  isLocalIndexSourceMode,
  isShardedSourceMode,
  savePushedSession,
  savePushedSnapshot,
  searchPushedSessions,
  searchSessionRows,
} from "./sessionStore.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const isDev = process.env.NODE_ENV !== "production";
const appMode = normalizeAppMode(process.env.APP_MODE || (isDev ? "dev" : "production"));
if (!process.env.SESSION_SOURCE) {
  process.env.SESSION_SOURCE = "local-index";
}
if (!isDev && !process.env.SESSION_ACCESS_TOKEN) {
  throw new Error("SESSION_ACCESS_TOKEN is required in production");
}
const port = Number(process.env.PORT || 5173);
const host = process.env.HOST || "127.0.0.1";
const eventClients = new Set();
const watcherStatus = new Map();
const maxPushBytes = Number(process.env.SESSION_PUSH_MAX_BYTES || 200 * 1024 * 1024);

let watchersStarted = false;
let changeVersion = 0;
const changeTimers = new Map();
const WATCH_DEBOUNCE_MS = 350;

let vite = null;
if (isDev) {
  const { createServer: createViteServer } = await import("vite");
  vite = await createViteServer({
    root,
    server: { middlewareMode: true },
    appType: "spa",
  });
}

const server = createServer(async (req, res) => {
  res.acceptEncoding = req.headers["accept-encoding"] || "";
  try {
    if (!req.url) {
      sendJson(res, 400, { error: "Missing URL" });
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (!authorizeAccess(url, req, res)) {
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      await handleApi(url, req, res);
      return;
    }

    if (vite) {
      vite.middlewares(req, res, () => {
        if (!res.headersSent) sendJson(res, 404, { error: "Not found" });
      });
      return;
    }

    await serveProductionClient(url, res);
  } catch (error) {
    if (vite) vite.ssrFixStacktrace(error);
    sendJson(res, 500, { error: error.message });
  }
});

server.listen(port, host, () => {
  console.log(`SessionInsight running at http://${host}:${port}`);
});

async function handleApi(url, req, res) {
  if (url.pathname === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      mode: appMode,
      source: getSessionSourceMode(),
    });
    return;
  }

  if (url.pathname === "/api/machines") {
    sendJson(res, 200, { machines: await getMachines() });
    return;
  }

  const pushManifestMatch = url.pathname.match(
    /^\/api\/push\/([^/]+)\/([^/]+)\/manifest$/,
  );
  if (pushManifestMatch) {
    await handlePushManifest(pushManifestMatch[1], pushManifestMatch[2], req, res);
    return;
  }

  const pushSessionMatch = url.pathname.match(
    /^\/api\/push\/([^/]+)\/([^/]+)\/session$/,
  );
  if (pushSessionMatch) {
    await handlePushSession(pushSessionMatch[1], pushSessionMatch[2], req, res);
    return;
  }

  const pushDeleteMatch = url.pathname.match(
    /^\/api\/push\/([^/]+)\/([^/]+)\/delete$/,
  );
  if (pushDeleteMatch) {
    await handlePushDelete(pushDeleteMatch[1], pushDeleteMatch[2], req, res);
    return;
  }

  const pushSnapshotMatch = url.pathname.match(
    /^\/api\/push\/([^/]+)\/([^/]+)\/snapshot$/,
  );
  if (pushSnapshotMatch) {
    await handlePushSnapshot(pushSnapshotMatch[1], pushSnapshotMatch[2], req, res);
    return;
  }

  if (url.pathname === "/api/events") {
    handleEvents(url, req, res);
    return;
  }

  if (url.pathname === "/api/rescan") {
    if (isLocalIndexSourceMode()) {
      await rebuildLocalProviderIndex("claude");
      const index = await getPushedIndex("claude");
      sendJson(res, 200, summarizeIndex(index));
      return;
    }
    clearSessionCache();
    const index = await scanClaudeSessions({ noCache: true });
    sendJson(res, 200, summarizeIndex(index));
    return;
  }

  const providerRescanMatch = url.pathname.match(/^\/api\/providers\/([^/]+)\/rescan$/);
  if (providerRescanMatch) {
    const provider = providerRescanMatch[1];
    if (isLocalIndexSourceMode()) {
      const result = await rebuildLocalProviderIndex(provider);
      if (!result) {
        sendJson(res, 404, { error: `Unknown provider: ${provider}` });
        return;
      }
      const index = await getPushedIndex(provider);
      sendJson(res, 200, summarizeIndex(index));
      return;
    }
    clearProviderCache(provider);
    const index = await scanProviderSessions(provider, { noCache: true });
    if (!index) {
      sendJson(res, 404, { error: `Unknown provider: ${provider}` });
      return;
    }
    sendJson(res, 200, summarizeIndex(index));
    return;
  }

  const providerProjectsMatch = url.pathname.match(/^\/api\/providers\/([^/]+)\/projects$/);
  if (providerProjectsMatch) {
    const index = await scanMachineProviderSessions(
      getDefaultMachineId(),
      providerProjectsMatch[1],
    );
    if (!index) {
      sendJson(res, 404, { error: `Unknown provider: ${providerProjectsMatch[1]}` });
      return;
    }
    sendJson(res, 200, summarizeIndex(index));
    return;
  }

  const providerProjectMatch = url.pathname.match(
    /^\/api\/providers\/([^/]+)\/projects\/([^/]+)\/sessions$/,
  );
  if (providerProjectMatch) {
    const sessions = await getMachineProviderProjectSessions(
      getDefaultMachineId(),
      providerProjectMatch[1],
      providerProjectMatch[2],
    );
    if (!sessions) {
      sendJson(res, 404, { error: `Unknown provider: ${providerProjectMatch[1]}` });
      return;
    }
    sendJson(res, 200, { sessions });
    return;
  }

  const providerSessionSearchMatch = url.pathname.match(
    /^\/api\/providers\/([^/]+)\/sessions\/search$/,
  );
  if (providerSessionSearchMatch) {
    const provider = providerSessionSearchMatch[1];
    const query = url.searchParams.get("q") || "";
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit") || 80)));
    const sessions = await searchMachineProviderSessions(
      getDefaultMachineId(),
      provider,
      query,
      limit,
    );
    if (!sessions) {
      sendJson(res, 404, { error: `Unknown provider: ${provider}` });
      return;
    }
    sendJson(res, 200, { sessions });
    return;
  }

  const providerSessionMatch = url.pathname.match(
    /^\/api\/providers\/([^/]+)\/sessions\/([^/]+)$/,
  );
  if (providerSessionMatch) {
    const session = await getMachineProviderSessionDetail(
      getDefaultMachineId(),
      providerSessionMatch[1],
      providerSessionMatch[2],
    );
    if (!session) {
      sendJson(res, 404, { error: "Session not found" });
      return;
    }
    sendJson(res, 200, {
      session: makePublicSessionDetail(session, {
        includeHiddenEvents: url.searchParams.get("includeHiddenEvents") === "1",
      }),
    });
    return;
  }

  const machineProjectsMatch = url.pathname.match(
    /^\/api\/machines\/([^/]+)\/providers\/([^/]+)\/projects$/,
  );
  if (machineProjectsMatch) {
    const index = await scanMachineProviderSessions(
      machineProjectsMatch[1],
      machineProjectsMatch[2],
    );
    if (!index) {
      sendJson(res, 404, { error: `Unknown provider: ${machineProjectsMatch[2]}` });
      return;
    }
    sendJson(res, 200, summarizeIndex(index));
    return;
  }

  const machineRescanMatch = url.pathname.match(
    /^\/api\/machines\/([^/]+)\/providers\/([^/]+)\/rescan$/,
  );
  if (machineRescanMatch) {
    const result = await rescanMachineProvider(machineRescanMatch[1], machineRescanMatch[2]);
    if (!result) {
      sendJson(res, 404, { error: `Unknown provider: ${machineRescanMatch[2]}` });
      return;
    }
    sendJson(res, 200, summarizeIndex(result));
    return;
  }

  const machineProjectMatch = url.pathname.match(
    /^\/api\/machines\/([^/]+)\/providers\/([^/]+)\/projects\/([^/]+)\/sessions$/,
  );
  if (machineProjectMatch) {
    const sessions = await getMachineProviderProjectSessions(
      machineProjectMatch[1],
      machineProjectMatch[2],
      machineProjectMatch[3],
    );
    if (!sessions) {
      sendJson(res, 404, { error: `Unknown provider: ${machineProjectMatch[2]}` });
      return;
    }
    sendJson(res, 200, { sessions });
    return;
  }

  const machineSessionSearchMatch = url.pathname.match(
    /^\/api\/machines\/([^/]+)\/providers\/([^/]+)\/sessions\/search$/,
  );
  if (machineSessionSearchMatch) {
    const query = url.searchParams.get("q") || "";
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit") || 80)));
    const sessions = await searchMachineProviderSessions(
      machineSessionSearchMatch[1],
      machineSessionSearchMatch[2],
      query,
      limit,
    );
    if (!sessions) {
      sendJson(res, 404, { error: `Unknown provider: ${machineSessionSearchMatch[2]}` });
      return;
    }
    sendJson(res, 200, { sessions });
    return;
  }

  const machineSessionMatch = url.pathname.match(
    /^\/api\/machines\/([^/]+)\/providers\/([^/]+)\/sessions\/([^/]+)$/,
  );
  if (machineSessionMatch) {
    const session = await getMachineProviderSessionDetail(
      machineSessionMatch[1],
      machineSessionMatch[2],
      machineSessionMatch[3],
    );
    if (!session) {
      sendJson(res, 404, { error: "Session not found" });
      return;
    }
    sendJson(res, 200, {
      session: makePublicSessionDetail(session, {
        includeHiddenEvents: url.searchParams.get("includeHiddenEvents") === "1",
      }),
    });
    return;
  }

  if (url.pathname === "/api/projects") {
    const index = await scanClaudeSessions();
    sendJson(res, 200, summarizeIndex(index));
    return;
  }

  const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/sessions$/);
  if (projectMatch) {
    const sessions = await getProjectSessions(projectMatch[1]);
    sendJson(res, 200, { sessions });
    return;
  }

  const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (sessionMatch) {
    const session = await getSessionDetail(sessionMatch[1]);
    if (!session) {
      sendJson(res, 404, { error: "Session not found" });
      return;
    }
    sendJson(res, 200, { session });
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

function authorizeAccess(url, req, res) {
  if (!process.env.SESSION_ACCESS_TOKEN) return true;
  if (url.pathname === "/api/health") return true;
  if (url.pathname.startsWith("/api/push/")) return true;

  const token = url.searchParams.get("token");
  if (token && token === process.env.SESSION_ACCESS_TOKEN) {
    const cleanUrl = new URL(url);
    cleanUrl.searchParams.delete("token");
    const redirectTarget = `${cleanUrl.pathname}${cleanUrl.search}${cleanUrl.hash}`;
    res.writeHead(302, {
      location: redirectTarget || "/",
      "set-cookie": makeAccessCookie(token, req),
      "cache-control": "no-store",
    });
    res.end();
    return false;
  }

  if (getBearerToken(req) === process.env.SESSION_ACCESS_TOKEN) return true;
  if (getCookie(req, "session_insight_token") === process.env.SESSION_ACCESS_TOKEN) {
    return true;
  }

  sendJson(res, 401, {
    error: "Unauthorized",
    hint: "Open the site with ?token=<SESSION_ACCESS_TOKEN> once to set the browser cookie.",
  });
  return false;
}

function makeAccessCookie(token, req) {
  const parts = [
    `session_insight_token=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=2592000",
  ];
  if (isSecureRequest(req)) parts.push("Secure");
  return parts.join("; ");
}

function isSecureRequest(req) {
  return (
    req.socket?.encrypted ||
    String(req.headers["x-forwarded-proto"] || "")
      .split(",")[0]
      .trim()
      .toLowerCase() === "https"
  );
}

function getBearerToken(req) {
  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1] || "";
}

function getCookie(req, name) {
  const cookieHeader = req.headers.cookie || "";
  for (const part of cookieHeader.split(";")) {
    const [key, ...valueParts] = part.trim().split("=");
    if (key === name) return decodeURIComponent(valueParts.join("="));
  }
  return "";
}

function normalizeAppMode(value) {
  if (value === "dev" || value === "production") return value;
  if (value === "local") return "dev";
  if (value === "remote") return "production";
  throw new Error(`Unknown APP_MODE: ${value}`);
}

async function scanProviderSessions(provider, options) {
  return scanMachineProviderSessions(getDefaultMachineId(), provider, options);
}

async function scanMachineProviderSessions(machineId, provider, options) {
  if (machineId !== getDefaultMachineId()) {
    return getPushedIndex(provider, machineId);
  }
  if (isLocalIndexSourceMode()) {
    const result = await ensureLocalProviderIndex(provider, {
      force: options?.noCache,
    });
    if (!result) return null;
    return getPushedIndex(provider, machineId);
  }
  if (provider === "claude") return scanClaudeSessions(options);
  if (provider === "codex") return scanCodexSessions(options);
  if (provider === "doujie") return scanDoujieSessions(options);
  return null;
}

async function getMachineProviderProjectSessions(machineId, provider, projectId) {
  if (machineId !== getDefaultMachineId()) {
    return getPushedProjectSessions(provider, projectId, machineId);
  }
  if (isLocalIndexSourceMode()) {
    const result = await ensureLocalProviderIndex(provider);
    if (!result) return null;
    return getPushedProjectSessions(provider, projectId, machineId);
  }
  if (provider === "claude") return getProjectSessions(projectId);
  if (provider === "codex") return getCodexProjectSessions(projectId);
  if (provider === "doujie") return getDoujieProjectSessions(projectId);
  return null;
}

async function getMachineProviderSessionDetail(machineId, provider, sessionId) {
  if (machineId !== getDefaultMachineId()) {
    return getPushedSessionDetail(provider, sessionId, machineId);
  }
  if (isLocalIndexSourceMode()) {
    const result = await ensureLocalProviderIndex(provider);
    if (!result) return null;
    return getPushedSessionDetail(provider, sessionId, machineId);
  }
  if (provider === "claude") return getSessionDetail(sessionId);
  if (provider === "codex") return getCodexSessionDetail(sessionId);
  if (provider === "doujie") return getDoujieSessionDetail(sessionId);
  return null;
}

async function searchMachineProviderSessions(machineId, provider, query, limit) {
  if (machineId !== getDefaultMachineId()) {
    return searchPushedSessions(provider, query, limit, machineId);
  }
  if (isLocalIndexSourceMode()) {
    const result = await ensureLocalProviderIndex(provider);
    if (!result) return null;
    return searchPushedSessions(provider, query, limit, machineId);
  }
  const index = await scanProviderSessions(provider);
  if (!index) return null;
  const projectSessions = {};
  for (const session of index.rootSessions || []) {
    if (!projectSessions[session.projectId]) projectSessions[session.projectId] = [];
    projectSessions[session.projectId].push(session);
  }
  return searchSessionRows(projectSessions, query, limit);
}

async function rescanMachineProvider(machineId, provider) {
  if (machineId !== getDefaultMachineId()) {
    return getPushedIndex(provider, machineId);
  }
  if (isLocalIndexSourceMode()) {
    const result = await rebuildLocalProviderIndex(provider);
    if (!result) return null;
    return getPushedIndex(provider, machineId);
  }
  clearProviderCache(provider);
  return scanProviderSessions(provider, { noCache: true });
}

async function handlePushManifest(machineId, provider, req, res) {
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }
  if (!isPushAuthorized(req, machineId)) {
    sendJson(res, 401, { error: "Unauthorized" });
    return;
  }
  try {
    sendJson(res, 200, await getPushedManifest(provider, machineId));
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
}

async function handlePushSession(machineId, provider, req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }
  if (!isPushAuthorized(req, machineId)) {
    sendJson(res, 401, { error: "Unauthorized" });
    return;
  }
  try {
    const payload = await readRequestJson(req, maxPushBytes);
    const result = await savePushedSession(provider, { ...payload, machineId }, machineId);
    sendPushChange(machineId, provider, result.pushedAt, "push-session", result.id);
    sendJson(res, 200, { ok: true, ...result });
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
}

async function handlePushDelete(machineId, provider, req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }
  if (!isPushAuthorized(req, machineId)) {
    sendJson(res, 401, { error: "Unauthorized" });
    return;
  }
  try {
    const payload = await readRequestJson(req, maxPushBytes);
    const result = await deletePushedSession(provider, { ...payload, machineId }, machineId);
    sendPushChange(machineId, provider, result.pushedAt, "push-delete", result.id);
    sendJson(res, 200, { ok: true, ...result });
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
}

async function handlePushSnapshot(machineId, provider, req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }
  if (!isPushAuthorized(req, machineId)) {
    sendJson(res, 401, { error: "Unauthorized" });
    return;
  }
  if (process.env.SESSION_PUSH_ENABLE_SNAPSHOT !== "1") {
    sendJson(res, 403, { error: "Snapshot push is disabled" });
    return;
  }
  try {
    const payload = await readRequestJson(req, maxPushBytes);
    if (!payload.allowEmptySnapshot && Object.keys(payload.sessions || {}).length === 0) {
      sendJson(res, 400, { error: "Empty snapshot requires allowEmptySnapshot=true" });
      return;
    }
    const result = await savePushedSnapshot(provider, { ...payload, machineId }, machineId);
    sendPushChange(machineId, provider, result.pushedAt, "push-snapshot", "snapshot");
    sendJson(res, 200, { ok: true, ...result });
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
}

function clearProviderCache(provider) {
  clearLocalIndexCache(provider);
  if (provider === "claude") clearSessionCache();
  if (provider === "codex") clearCodexSessionCache();
  if (provider === "doujie") clearDoujieSessionCache();
}

function handleEvents(url, req, res) {
  const provider = url.searchParams.get("provider") || "all";
  const machineId = url.searchParams.get("machine") || getDefaultMachineId();
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });

  startWatchers();

  res.write(
    `event: ready\ndata: ${JSON.stringify({
      machineId,
      provider,
      watchers: getWatcherStatus(provider),
    })}\n\n`,
  );

  const client = { machineId, provider, res };
  eventClients.add(client);
  req.on("close", () => {
    eventClients.delete(client);
  });
}

function startWatchers() {
  if (watchersStarted) return;
  watchersStarted = true;
  if (isLocalIndexSourceMode()) {
    for (const provider of ["claude", "codex", "doujie"]) {
      const config = getLocalProviderConfig(provider);
      if (config) watchProvider(provider, config.watchPaths);
    }
    return;
  }

  if (getSessionSourceMode() === "local-scan") {
    const claudeProjectsPath = path.join(getClaudeHome(), "projects");
    const codexSessionsPath = path.join(getCodexHome(), "sessions");
    const doujieSessionsPath = path.join(getDoujieHome(), "sessions", "links");
    watchProvider("claude", [claudeProjectsPath]);
    watchProvider("codex", [
      codexSessionsPath,
      path.join(getCodexHome(), "session_index.jsonl"),
    ]);
    watchProvider("doujie", [
      doujieSessionsPath,
      path.join(getDoujieHome(), "session_index.jsonl"),
    ]);
  }
}

function watchProvider(provider, targetPaths) {
  const key = `${provider}:${targetPaths.join(":")}`;
  try {
    const watcher = chokidar.watch(targetPaths, {
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: {
        stabilityThreshold: 150,
        pollInterval: 50,
      },
      ignored: (watchedPath, stats) => {
        if (!stats) return false;
        if (stats?.isDirectory()) return false;
        return !watchedPath.endsWith(".jsonl");
      },
    });

    watcherStatus.set(key, {
      provider,
      targetPaths,
      ok: true,
      ready: false,
      engine: "chokidar",
    });

    watcher
      .on("ready", () => {
        watcherStatus.set(key, {
          provider,
          targetPaths,
          ok: true,
          ready: true,
          engine: "chokidar",
        });
        sendProviderWatcherStatus(provider);
      })
      .on("all", (eventType, changedPath) => {
        scheduleProviderChange(provider, {
          eventType,
          changedPath,
          fileName: path.relative(path.dirname(targetPaths[0]), changedPath),
        });
      })
      .on("error", (error) => {
        watcherStatus.set(key, {
          provider,
          targetPaths,
          ok: false,
          ready: false,
          engine: "chokidar",
          error: error.message,
        });
        sendProviderWatcherStatus(provider);
        scheduleProviderChange(provider, {
          eventType: "watch-error",
          fileName: "",
        });
      });
  } catch (error) {
    watcherStatus.set(key, {
      provider,
      targetPaths,
      ok: false,
      ready: false,
      engine: "chokidar",
      error: error.message,
    });
    // The endpoint still works with manual refresh if the directory does not exist.
  }
}

function getWatcherStatus(provider) {
  if (isShardedSourceMode() && !isLocalIndexSourceMode()) {
    const providers = provider === "all" ? ["claude", "codex", "doujie"] : [provider];
    return providers.map((item) => ({
      provider: item,
      ok: true,
      ready: true,
      engine: "push",
      targetPaths: ["remote snapshots"],
    }));
  }
  return [...watcherStatus.values()].filter(
    (watcher) => provider === "all" || watcher.provider === provider,
  );
}

function sendProviderWatcherStatus(provider) {
  const payload = {
    machineId: getDefaultMachineId(),
    provider,
    watchers: getWatcherStatus(provider),
    at: new Date().toISOString(),
  };
  for (const client of eventClients) {
    if (client.machineId !== getDefaultMachineId()) continue;
    if (client.provider !== "all" && client.provider !== provider) continue;
    client.res.write(`event: watcher-status\ndata: ${JSON.stringify(payload)}\n\n`);
  }
}

function sendPushChange(machineId, provider, at, eventType, fileName) {
  changeVersion += 1;
  const payload = {
    machineId,
    provider,
    version: changeVersion,
    at: at || new Date().toISOString(),
    eventType,
    fileName,
  };
  for (const client of eventClients) {
    if (client.machineId !== machineId) continue;
    if (client.provider !== "all" && client.provider !== provider) continue;
    client.res.write(`event: change\ndata: ${JSON.stringify(payload)}\n\n`);
  }
}

function scheduleProviderChange(provider, detail) {
  clearTimeout(changeTimers.get(provider));
  changeTimers.set(
    provider,
    setTimeout(async () => {
      if (isLocalIndexSourceMode()) {
        try {
          await syncLocalProviderPath(provider, detail.changedPath || "", detail.eventType);
        } catch (error) {
          watcherStatus.set(`local-index-error:${provider}`, {
            provider,
            ok: false,
            ready: true,
            engine: "local-index",
            targetPaths: [],
            error: error.message,
          });
          sendProviderWatcherStatus(provider);
        }
      } else {
        clearProviderCache(provider);
      }
      changeVersion += 1;
      const payload = {
        machineId: getDefaultMachineId(),
        provider,
        version: changeVersion,
        at: new Date().toISOString(),
        ...detail,
      };
      for (const client of eventClients) {
        if (client.machineId !== getDefaultMachineId()) continue;
        if (client.provider !== "all" && client.provider !== provider) continue;
        client.res.write(`event: change\ndata: ${JSON.stringify(payload)}\n\n`);
      }
    }, WATCH_DEBOUNCE_MS),
  );
}

function getSessionSourceMode() {
  return process.env.SESSION_SOURCE || "local-scan";
}

async function readRequestJson(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new Error(`Request body exceeds ${maxBytes} bytes`);
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks);
  const body = String(req.headers["content-encoding"] || "").toLowerCase() === "gzip"
    ? await gunzipLimited(raw, maxBytes)
    : raw;
  if (body.length > maxBytes) {
    throw new Error(`Request body exceeds ${maxBytes} bytes after decompression`);
  }
  return JSON.parse(body.toString("utf8") || "{}");
}

function gunzipLimited(raw, maxBytes) {
  return new Promise((resolve, reject) => {
    const gunzip = createGunzip();
    const chunks = [];
    let total = 0;
    gunzip.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        gunzip.destroy(new Error(`Request body exceeds ${maxBytes} bytes after decompression`));
        return;
      }
      chunks.push(chunk);
    });
    gunzip.on("error", reject);
    gunzip.on("end", () => resolve(Buffer.concat(chunks)));
    gunzip.end(raw);
  });
}

function isPushAuthorized(req, machineId) {
  const token = getPushTokenForMachine(machineId);
  if (!token) return false;
  const headerToken = req.headers["x-session-push-token"];
  return getBearerToken(req) === token || headerToken === token;
}

function getPushTokenForMachine(machineId) {
  if (machineId === getDefaultMachineId() && process.env.SESSION_PUSH_ALLOW_DEFAULT_MACHINE !== "1") {
    return "";
  }
  const tokens = parseMachineTokenMap(process.env.SESSION_PUSH_TOKENS || "");
  if (tokens.has(machineId)) return tokens.get(machineId);
  if (process.env.SESSION_PUSH_TOKEN) {
    const legacyMachineId = process.env.SESSION_PUSH_MACHINE_ID || "mac";
    if (machineId === legacyMachineId) return process.env.SESSION_PUSH_TOKEN;
  }
  return "";
}

function parseMachineTokenMap(value) {
  const map = new Map();
  const trimmed = value.trim();
  if (!trimmed) return map;
  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed);
    for (const [machineId, token] of Object.entries(parsed)) {
      if (token) map.set(machineId, String(token));
    }
    return map;
  }
  for (const item of trimmed.split(",")) {
    const separator = item.indexOf(":");
    if (separator <= 0) continue;
    const machineId = item.slice(0, separator).trim();
    const token = item.slice(separator + 1).trim();
    if (machineId && token) map.set(machineId, token);
  }
  return map;
}

function summarizeIndex(index) {
  return {
    provider: index.provider || "claude",
    claudeHome: index.claudeHome,
    codexHome: index.codexHome,
    doujieHome: index.doujieHome,
    projectsRoot: index.projectsRoot,
    scannedAt: index.scannedAt,
    projectCount: index.projectCount,
    sessionCount: index.sessionCount,
    mainSessionCount: index.mainSessionCount,
    subagentSessionCount: index.subagentSessionCount,
    projects: index.projects,
  };
}

function makePublicSessionDetail(session, options = {}) {
  if (options.includeHiddenEvents) {
    return {
      ...session,
      hiddenEventsOmitted: false,
      omittedSystemEventCount: 0,
      omittedToolEventCount: 0,
    };
  }

  let omittedSystemEventCount = 0;
  let omittedToolEventCount = 0;
  const visibleEvents = [];
  for (const event of session.events || []) {
    const systemEvent = isSystemDetailEvent(event);
    const toolEvent = isToolDetailEvent(event);
    if (systemEvent || toolEvent) {
      if (systemEvent) omittedSystemEventCount += 1;
      if (toolEvent) omittedToolEventCount += 1;
      continue;
    }
    const publicEvent = makePublicEvent(event);
    if (!publicEvent) continue;
    if (publicEvent.omittedSystemSegmentCount) {
      omittedSystemEventCount += publicEvent.omittedSystemSegmentCount;
    }
    if (publicEvent.omittedToolSegmentCount) {
      omittedToolEventCount += publicEvent.omittedToolSegmentCount;
    }
    visibleEvents.push(publicEvent.event);
  }

  return {
    ...session,
    events: visibleEvents,
    hiddenEventsOmitted: omittedSystemEventCount > 0 || omittedToolEventCount > 0,
    omittedSystemEventCount,
    omittedToolEventCount,
  };
}

function makePublicEvent(event) {
  if (!Array.isArray(event.segments)) return { event };

  let omittedSystemSegmentCount = 0;
  let omittedToolSegmentCount = 0;
  const segments = [];
  for (const segment of event.segments) {
    if (isToolDetailSegment(segment)) {
      omittedToolSegmentCount += 1;
      continue;
    }
    if (isSystemDetailSegment(segment)) {
      omittedSystemSegmentCount += 1;
      continue;
    }
    segments.push(segment);
  }

  if (!segments.length) return null;
  return {
    event: { ...event, segments },
    omittedSystemSegmentCount,
    omittedToolSegmentCount,
  };
}

function isSystemDetailEvent(event) {
  return (
    event.isMetaArtifact ||
    event.kind === "metadata" ||
    event.kind === "attachment" ||
    event.kind === "raw" ||
    event.kind === "parse_error"
  );
}

function isToolDetailEvent(event) {
  return (
    event.kind === "tool_result" ||
    (event.role === "assistant" &&
      event.kind === "message" &&
      event.segments?.some(isToolDetailSegment) &&
      !event.segments?.some((segment) => segment.kind === "text"))
  );
}

function isToolDetailSegment(segment) {
  return segment.kind === "tool_call" || segment.kind === "tool_result";
}

function isSystemDetailSegment(segment) {
  return segment.kind === "thinking";
}

function sendJson(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  const encoded = encodeResponseBody(res, payload, "application/json; charset=utf-8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...encoded.headers,
  });
  res.end(encoded.body);
}

async function serveProductionClient(url, res) {
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(root, "dist/client", safePath);

  try {
    const body = await readFile(filePath);
    sendStaticBody(res, filePath, body);
  } catch {
    const fallbackPath = path.join(root, "dist/client/index.html");
    const body = await readFile(fallbackPath);
    sendStaticBody(res, fallbackPath, body);
  }
}

function sendStaticBody(res, filePath, body) {
  const type = contentType(filePath);
  const encoded = encodeResponseBody(res, body, type);
  res.writeHead(200, {
    "content-type": type,
    "cache-control": staticCacheControl(filePath),
    ...encoded.headers,
  });
  res.end(encoded.body);
}

function encodeResponseBody(res, body, type) {
  if (!isCompressible(type) || body.length < 1024) {
    return { body, headers: {} };
  }
  const accepted = String(res.acceptEncoding || "");
  if (!/\bgzip\b/i.test(accepted)) {
    return { body, headers: {} };
  }
  return {
    body: gzipSync(body),
    headers: {
      "content-encoding": "gzip",
      vary: "Accept-Encoding",
    },
  };
}

function isCompressible(type) {
  return (
    type.startsWith("text/") ||
    type.includes("javascript") ||
    type.includes("json") ||
    type.includes("svg")
  );
}

function staticCacheControl(filePath) {
  if (filePath.includes(`${path.sep}assets${path.sep}`)) {
    return "public, max-age=31536000, immutable";
  }
  return "no-cache";
}

function contentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}
