#!/usr/bin/env node
import chokidar from "chokidar";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { getClaudeHome, parseSessionFile } from "../server/claudeSessions.mjs";
import {
  getCodexHome,
  getDoujieHome,
  parseCodexSessionFile,
  readSessionIndex,
} from "../server/codexSessions.mjs";

const endpoint = normalizeEndpoint(process.env.SESSION_PUSH_URL);
const token = process.env.SESSION_PUSH_TOKEN;
const machineId = normalizeMachineId(process.env.SESSION_PUSH_MACHINE_ID || "mac");
const machineLabel = String(process.env.SESSION_PUSH_MACHINE_LABEL || "Mac").trim();
const providers = parseProviders(process.env.SESSION_PUSH_PROVIDERS || "codex,claude,doujie");
const debounceMs = Number(process.env.SESSION_PUSH_DEBOUNCE_MS || 1000);
const minPushIntervalMs = Number(process.env.SESSION_PUSH_MIN_INTERVAL_MS || 8000);
const allowEmptyDelete = process.env.SESSION_PUSH_ALLOW_EMPTY_DELETE === "1";
const allowLargeDelete = process.env.SESSION_PUSH_ALLOW_LARGE_DELETE === "1";
const maxDeleteRatio = Number(process.env.SESSION_PUSH_MAX_DELETE_RATIO || 0.5);
const verboseErrors = process.env.SESSION_PUSH_VERBOSE_ERRORS === "1";
const once = process.argv.includes("--once");
const activeProviders = new Set();
const pendingSync = new Map();
const pendingFiles = new Map();
const remoteManifests = new Map();
const timers = new Map();
const lastFilePushAt = new Map();

if (!endpoint || !token) {
  console.error(
    "SESSION_PUSH_URL and SESSION_PUSH_TOKEN are required. Example: SESSION_PUSH_URL=https://example.com SESSION_PUSH_TOKEN=... npm run push",
  );
  process.exit(1);
}

for (const provider of providers) {
  pendingSync.set(provider, { forceAll: false });
  try {
    await processProviderQueue(provider);
  } catch (error) {
    logError(error);
    if (once) process.exitCode = 1;
  }
}

if (once) process.exit(process.exitCode || 0);

for (const provider of providers) watchProvider(provider);

console.log(
  `[${new Date().toISOString()}] watching ${providers.join(", ")} for machine ${machineId}`,
);

function scheduleProviderSync(provider, options = {}) {
  clearTimeout(timers.get(`${provider}:sync`));
  timers.set(
    `${provider}:sync`,
    setTimeout(() => {
      const current = pendingSync.get(provider);
      pendingSync.set(provider, { forceAll: Boolean(options.forceAll || current?.forceAll) });
      processProviderQueue(provider).catch(logError);
    }, debounceMs),
  );
}

function scheduleFilePush(provider, filePath) {
  clearTimeout(timers.get(`${provider}:${filePath}`));
  timers.set(
    `${provider}:${filePath}`,
    setTimeout(() => {
      if (!pendingFiles.has(provider)) pendingFiles.set(provider, new Set());
      pendingFiles.get(provider).add(filePath);
      processProviderQueue(provider).catch(logError);
    }, debounceMs),
  );
}

async function processProviderQueue(provider) {
  if (activeProviders.has(provider)) return;
  activeProviders.add(provider);
  try {
    while (pendingSync.has(provider) || pendingFiles.get(provider)?.size) {
      const sync = pendingSync.get(provider);
      if (sync) {
        pendingSync.delete(provider);
        await syncProvider(provider, sync);
        continue;
      }

      const files = [...(pendingFiles.get(provider) || [])];
      pendingFiles.set(provider, new Set());
      for (const filePath of files) {
        await pushChangedFile(provider, filePath);
      }
    }
  } finally {
    activeProviders.delete(provider);
  }
}

async function syncProvider(provider, options = {}) {
  const startedAt = Date.now();
  const remote = await fetchManifest(provider);
  remoteManifests.set(provider, remote);
  const localFiles = await getLocalSessionFiles(provider);
  const localByPath = new Map(localFiles.map((file) => [file.filePath, file]));
  const changed = localFiles.filter((file) => {
    const existing = remote.get(file.filePath);
    return (
      options.forceAll ||
      !existing ||
      existing.size !== file.size ||
      Number(existing.mtimeMs || 0) !== Number(file.mtimeMs || 0)
    );
  });
  const deleted = [...remote.values()].filter((item) => !localByPath.has(item.filePath));
  if (!allowEmptyDelete && localFiles.length === 0 && remote.size > 0) {
    throw new Error(
      `Refusing to delete ${remote.size} remote ${provider} sessions because local scan returned no files. Set SESSION_PUSH_ALLOW_EMPTY_DELETE=1 to allow this.`,
    );
  }
  if (
    !allowLargeDelete &&
    deleted.length > 0 &&
    remote.size > 0 &&
    deleted.length / remote.size > maxDeleteRatio
  ) {
    throw new Error(
      `Refusing to delete ${deleted.length}/${remote.size} remote ${provider} sessions. Set SESSION_PUSH_ALLOW_LARGE_DELETE=1 or adjust SESSION_PUSH_MAX_DELETE_RATIO to allow this.`,
    );
  }

  console.log(
    `[${new Date().toISOString()}] sync ${provider}: ${changed.length} changed, ${deleted.length} deleted, ${localFiles.length} local`,
  );

  for (const file of changed) {
    await pushChangedFile(provider, file.filePath);
  }
  for (const item of deleted) {
    await pushDeletedSession(provider, item);
  }

  console.log(
    `[${new Date().toISOString()}] synced ${provider} in ${Date.now() - startedAt}ms`,
  );
}

async function pushChangedFile(provider, filePath) {
  const fileStats = await safeStat(filePath);
  if (!fileStats) {
    const remote = remoteManifests.get(provider) || (await fetchManifest(provider));
    const item = remote.get(filePath);
    if (item) await pushDeletedSession(provider, item);
    return;
  }
  if (!filePath.endsWith(".jsonl")) return;

  await waitForFilePushSlot(provider, filePath);

  const startedAt = Date.now();
  const detail = await parseDetail(provider, filePath);
  const response = await postJson(`/api/push/${machineId}/${provider}/session`, {
    sourceHost: machineId,
    machineId,
    machineLabel,
    session: detail,
  });
  updateRemoteManifest(provider, {
    id: detail.id,
    filePath: detail.filePath,
    relativePath: detail.relativePath,
    fileName: detail.fileName,
    mtimeMs: detail.mtimeMs,
    size: detail.size,
    updatedAt: detail.lastTimestamp || new Date().toISOString(),
  });
  lastFilePushAt.set(filePushKey(provider, filePath), Date.now());
  console.log(
    `[${new Date().toISOString()}] pushed ${provider} (${formatBytes(response.bytes)} gzip) in ${Date.now() - startedAt}ms`,
  );
}

async function pushDeletedSession(provider, item) {
  const startedAt = Date.now();
  await postJson(`/api/push/${machineId}/${provider}/delete`, {
    sourceHost: machineId,
    machineId,
    machineLabel,
    sessionId: item.id,
  });
  const remote = remoteManifests.get(provider);
  if (remote) remote.delete(item.filePath);
  console.log(
    `[${new Date().toISOString()}] deleted ${provider} session in ${Date.now() - startedAt}ms`,
  );
}

async function fetchManifest(provider) {
  const response = await fetch(`${endpoint}/api/push/${machineId}/${provider}/manifest`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      `Manifest ${provider} failed with ${response.status}: ${body.error || response.statusText}`,
    );
  }
  return new Map((body.sessions || []).map((item) => [item.filePath, item]));
}

async function postJson(pathname, payload) {
  const uploadBody = gzipSync(JSON.stringify(payload));
  const response = await fetch(`${endpoint}${pathname}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "content-encoding": "gzip",
    },
    body: uploadBody,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      `POST ${pathname} failed with ${response.status}: ${body.error || response.statusText}`,
    );
  }
  return { body, bytes: uploadBody.length };
}

async function parseDetail(provider, filePath) {
  if (provider === "claude") {
    const projectsRoot = path.join(getClaudeHome(), "projects");
    const detail = await parseSessionFile(filePath, projectsRoot, { includeEvents: true });
    return {
      ...detail.summary,
      events: detail.events,
    };
  }

  const home = getCodexLikeHome(provider);
  const titleByThreadId = await readSessionIndex(home);
  const detail = await parseCodexSessionFile(filePath, getCodexLikeSessionsRoot(provider), {
    includeEvents: true,
    provider,
    titleByThreadId,
  });
  return {
    ...detail.summary,
    events: detail.events,
  };
}

async function getLocalSessionFiles(provider) {
  const roots = provider === "claude"
    ? [path.join(getClaudeHome(), "projects")]
    : [getCodexLikeSessionsRoot(provider)];
  const files = [];
  for (const root of roots) {
    const rootStats = await safeStat(root);
    if (!rootStats?.isDirectory()) {
      throw new Error(`Local ${provider} session root is missing or not a directory`);
    }
    for (const filePath of await findJsonlFiles(root)) {
      const fileStats = await safeStat(filePath);
      if (!fileStats) continue;
      files.push({
        filePath,
        fileName: path.basename(filePath),
        mtimeMs: fileStats.mtimeMs,
        size: fileStats.size,
      });
    }
  }
  return files;
}

function watchProvider(provider) {
  const targetPaths = provider === "claude"
    ? [path.join(getClaudeHome(), "projects")]
    : [
        getCodexLikeSessionsRoot(provider),
        path.join(getCodexLikeHome(provider), "session_index.jsonl"),
      ];

  const watcher = chokidar.watch(targetPaths, {
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: {
      stabilityThreshold: 150,
      pollInterval: 50,
    },
    ignored: (watchedPath, stats) => {
      if (!stats) return false;
      if (stats.isDirectory()) return false;
      return !watchedPath.endsWith(".jsonl");
    },
  });

  watcher.on("all", (eventType, changedPath) => {
    if (provider !== "claude" && changedPath.endsWith("session_index.jsonl")) {
      scheduleProviderSync(provider);
      return;
    }
    scheduleFilePush(provider, changedPath);
  });
  watcher.on("error", (error) => {
    console.error(`[${new Date().toISOString()}] ${provider} watcher error: ${error.message}`);
  });
}

async function findJsonlFiles(root) {
  const files = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.name.endsWith(".jsonl")) {
        if (entry.isFile()) {
          files.push(fullPath);
        } else if (entry.isSymbolicLink()) {
          const targetStats = await safeStat(fullPath);
          if (targetStats?.isFile()) files.push(fullPath);
        }
      }
    }
  }
  await walk(root);
  return files;
}

async function safeStat(filePath) {
  try {
    return await stat(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function updateRemoteManifest(provider, item) {
  const manifest = remoteManifests.get(provider) || new Map();
  manifest.set(item.filePath, item);
  remoteManifests.set(provider, manifest);
}

async function waitForFilePushSlot(provider, filePath) {
  if (once || minPushIntervalMs <= 0) return;
  const key = filePushKey(provider, filePath);
  const previous = lastFilePushAt.get(key);
  if (!previous) return;
  const remaining = minPushIntervalMs - (Date.now() - previous);
  if (remaining > 0) {
    await new Promise((resolve) => setTimeout(resolve, remaining));
  }
}

function filePushKey(provider, filePath) {
  return `${provider}:${filePath}`;
}

function getCodexLikeHome(provider) {
  return provider === "doujie" ? getDoujieHome() : getCodexHome();
}

function getCodexLikeSessionsRoot(provider) {
  return provider === "doujie"
    ? path.join(getDoujieHome(), "sessions", "links")
    : path.join(getCodexHome(), "sessions");
}

function normalizeEndpoint(value) {
  return String(value || "").replace(/\/+$/, "");
}

function parseProviders(value) {
  const parsed = value
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return parsed.length ? parsed : ["codex", "claude", "doujie"];
}

function normalizeMachineId(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(normalized)) {
    throw new Error("SESSION_PUSH_MACHINE_ID must use lowercase letters, numbers, dots, underscores, or dashes");
  }
  return normalized;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function logError(error) {
  const message = verboseErrors ? error.stack || error.message : sanitizeErrorMessage(error);
  console.error(`[${new Date().toISOString()}] ${message}`);
}

function sanitizeErrorMessage(error) {
  const name = error?.name && error.name !== "Error" ? `${error.name}: ` : "";
  const rawMessage = String(error?.message || error || "Unknown push error");
  const message = rawMessage
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer <redacted>")
    .replace(/(SESSION_PUSH_TOKEN=)[^\s]+/g, "$1<redacted>")
    .replace(/([A-Za-z]:)?\/[^\s:]+/g, "<path>");
  return `${name}${message}`;
}
