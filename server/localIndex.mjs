import { readdir, stat } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { getClaudeHome, parseSessionFile } from "./claudeSessions.mjs";
import {
  getCodexHome,
  getDoujieHome,
  parseCodexSessionFile,
  readSessionIndex,
} from "./codexSessions.mjs";
import {
  deletePushedSession,
  getPushedManifest,
  savePushedSession,
} from "./sessionStore.mjs";

const DEFAULT_LOCAL_INDEX_CACHE_MS = 2_000;
const localIndexCache = new Map();

export function getLocalProviderConfig(provider) {
  if (provider === "claude") {
    const home = getClaudeHome();
    return {
      provider,
      home,
      root: path.join(home, "projects"),
      watchPaths: [path.join(home, "projects")],
    };
  }

  if (provider === "codex") {
    const home = getCodexHome();
    return {
      provider,
      home,
      root: path.join(home, "sessions"),
      sessionIndexPath: path.join(home, "session_index.jsonl"),
      watchPaths: [path.join(home, "sessions"), path.join(home, "session_index.jsonl")],
    };
  }

  if (provider === "doujie") {
    const home = getDoujieHome();
    return {
      provider,
      home,
      root: path.join(home, "sessions", "links"),
      sessionIndexPath: path.join(home, "session_index.jsonl"),
      watchPaths: [
        path.join(home, "sessions", "links"),
        path.join(home, "session_index.jsonl"),
      ],
    };
  }

  return null;
}

export function clearLocalIndexCache(provider) {
  if (!provider) {
    localIndexCache.clear();
    return;
  }
  for (const key of localIndexCache.keys()) {
    if (key.startsWith(`${provider}:`)) localIndexCache.delete(key);
  }
}

export async function ensureLocalProviderIndex(provider, options = {}) {
  const config = getLocalProviderConfig(provider);
  if (!config) return null;

  const cacheMs = options.cacheMs ?? DEFAULT_LOCAL_INDEX_CACHE_MS;
  const cacheKey = `${provider}:${config.root}:${config.home}`;
  const now = Date.now();
  const cached = localIndexCache.get(cacheKey);
  if (!options.force && cached && now - cached.createdAt < cacheMs) {
    return cached.result;
  }

  const result = await reconcileLocalProvider(provider, config);
  localIndexCache.set(cacheKey, { createdAt: Date.now(), result });
  return result;
}

export async function rebuildLocalProviderIndex(provider) {
  clearLocalIndexCache(provider);
  const config = getLocalProviderConfig(provider);
  if (!config) return null;
  return reconcileLocalProvider(provider, config);
}

export async function syncLocalProviderPath(provider, changedPath, eventType = "change") {
  clearLocalIndexCache(provider);
  const config = getLocalProviderConfig(provider);
  if (!config) return null;

  if (
    changedPath === config.sessionIndexPath ||
    eventType === "addDir" ||
    eventType === "unlinkDir"
  ) {
    return reconcileLocalProvider(provider, config);
  }

  if (!changedPath.endsWith(".jsonl")) return null;

  if (eventType === "unlink") {
    return deleteLocalProviderPath(provider, changedPath);
  }

  const detail = await parseLocalSessionDetail(provider, changedPath, config);
  if (!detail) return null;
  return savePushedSession(provider, {
    sourceHost: hostname(),
    session: detail,
  });
}

export async function deleteLocalProviderPath(provider, filePath) {
  clearLocalIndexCache(provider);
  const manifest = await getPushedManifest(provider);
  const match = manifest.sessions.find((session) => session.filePath === filePath);
  if (!match) return { provider, id: "", deleted: false };
  const result = await deletePushedSession(provider, {
    sourceHost: hostname(),
    sessionId: match.id,
  });
  return { ...result, deleted: true };
}

async function reconcileLocalProvider(provider, config) {
  const files = await findJsonlFiles(config.root);
  const localByPath = new Map();
  for (const filePath of files) {
    const fileStats = await stat(filePath);
    localByPath.set(filePath, {
      filePath,
      mtimeMs: fileStats.mtimeMs,
      size: fileStats.size,
    });
  }

  const manifest = await getPushedManifest(provider);
  const remoteByPath = new Map(
    manifest.sessions
      .filter((session) => session.filePath)
      .map((session) => [session.filePath, session]),
  );

  let upserted = 0;
  let deleted = 0;
  for (const local of localByPath.values()) {
    const remote = remoteByPath.get(local.filePath);
    if (
      remote &&
      Number(remote.mtimeMs || 0) === local.mtimeMs &&
      Number(remote.size || 0) === local.size
    ) {
      continue;
    }

    const detail = await parseLocalSessionDetail(provider, local.filePath, config);
    if (!detail) continue;
    await savePushedSession(provider, {
      sourceHost: hostname(),
      session: detail,
    });
    upserted += 1;
  }

  for (const remote of remoteByPath.values()) {
    if (localByPath.has(remote.filePath)) continue;
    await deletePushedSession(provider, {
      sourceHost: hostname(),
      sessionId: remote.id,
    });
    deleted += 1;
  }

  return {
    provider,
    fileCount: localByPath.size,
    upserted,
    deleted,
    syncedAt: new Date().toISOString(),
  };
}

async function parseLocalSessionDetail(provider, filePath, config) {
  if (provider === "claude") {
    const detail = await parseSessionFile(filePath, config.root, {
      includeEvents: true,
    });
    return {
      ...detail.summary,
      provider,
      events: detail.events,
    };
  }

  const titleByThreadId = await readSessionIndex(config.home);
  const detail = await parseCodexSessionFile(filePath, config.root, {
    includeEvents: true,
    provider,
    titleByThreadId,
  });
  return {
    ...detail.summary,
    provider,
    events: detail.events,
  };
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
          const targetStats = await stat(fullPath).catch((error) => {
            if (error.code === "ENOENT") return null;
            throw error;
          });
          if (targetStats?.isFile()) files.push(fullPath);
        }
      }
    }
  }

  await walk(root);
  return files;
}
