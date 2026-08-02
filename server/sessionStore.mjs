import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";

const DEFAULT_STORE_PATH = path.resolve("data/session-store.json");
const PROVIDERS = new Set(["claude", "codex", "doujie"]);

let writeQueue = Promise.resolve();
const migratedProviders = new Set();

export function getSessionStorePath() {
  return process.env.SESSION_STORE_PATH || DEFAULT_STORE_PATH;
}

export function getSessionDataDir() {
  return process.env.SESSION_DATA_DIR || path.dirname(getSessionStorePath());
}

export function isPushSourceMode() {
  return process.env.SESSION_SOURCE === "push";
}

export function isLocalIndexSourceMode() {
  return process.env.SESSION_SOURCE === "local-index";
}

export function isShardedSourceMode() {
  return isPushSourceMode() || isLocalIndexSourceMode();
}

export async function getPushedIndex(provider) {
  validateProvider(provider);
  await ensureProviderMigrated(provider);
  const index = await readProviderIndex(provider);
  return index ? sanitizeIndex(provider, index) : makeEmptyIndex(provider);
}

export async function getPushedProjectSessions(provider, projectId) {
  validateProvider(provider);
  await ensureProviderMigrated(provider);
  const index = await readProviderIndex(provider);
  return index?.projectSessions?.[projectId] || [];
}

export async function getPushedSessionDetail(provider, sessionId) {
  validateProvider(provider);
  await ensureProviderMigrated(provider);
  const detail = await readSessionDetail(provider, sessionId);
  if (!detail) return null;

  const row = await findSessionRow(provider, sessionId);
  return {
    ...detail,
    parentSessionRowId: row?.parentSessionRowId || detail.parentSessionRowId || "",
    parentSessionTitle: row?.parentSessionTitle || detail.parentSessionTitle || "",
    childSessions: row?.childSessions || [],
    childSessionCount: row?.childSessionCount || 0,
  };
}

export async function searchPushedSessions(provider, query, limit = 80) {
  validateProvider(provider);
  await ensureProviderMigrated(provider);
  const index = await readProviderIndex(provider);
  return searchSessionRows(index?.projectSessions || {}, query, limit);
}

export async function getPushedManifest(provider) {
  validateProvider(provider);
  await ensureProviderMigrated(provider);
  const summaries = await readProviderSummaries(provider);
  return {
    provider,
    sessions: summaries.map((summary) => ({
      id: summary.id,
      filePath: summary.filePath || "",
      relativePath: summary.relativePath || "",
      fileName: summary.fileName || "",
      mtimeMs: summary.mtimeMs || 0,
      size: summary.size || 0,
      updatedAt: summary.updatedAt || summary.lastTimestamp || "",
    })),
  };
}

export async function savePushedSnapshot(provider, payload) {
  validateProvider(provider);
  validateSnapshotPayload(payload);
  const details = Object.values(payload.sessions || {});

  writeQueue = writeQueue.then(async () => {
    await resetProviderShards(provider);
    for (const detail of details) {
      await writeSessionShard(provider, normalizeDetail(provider, detail));
    }
    await rebuildProviderIndex(provider, {
      sourceHost: payload.sourceHost || hostname(),
      pushedAt: new Date().toISOString(),
    });
  });
  await writeQueue;

  const index = await readProviderIndex(provider);
  return {
    provider,
    pushedAt: index?.pushedAt || "",
    projectCount: index?.projectCount || 0,
    sessionCount: index?.sessionCount || 0,
    detailedSessionCount: details.length,
  };
}

export async function savePushedSession(provider, payload) {
  validateProvider(provider);
  const detail = normalizeDetail(provider, payload?.session || payload?.detail || payload);

  writeQueue = writeQueue.then(async () => {
    await writeSessionShard(provider, detail);
    await rebuildProviderIndex(provider, {
      sourceHost: payload?.sourceHost || hostname(),
      pushedAt: new Date().toISOString(),
    });
  });
  await writeQueue;

  const index = await readProviderIndex(provider);
  return {
    provider,
    id: detail.id,
    pushedAt: index?.pushedAt || "",
    projectCount: index?.projectCount || 0,
    sessionCount: index?.sessionCount || 0,
  };
}

export async function deletePushedSession(provider, payload) {
  validateProvider(provider);
  const sessionId = payload?.sessionId || payload?.id;
  if (!sessionId) throw new Error("Delete payload must include sessionId");

  writeQueue = writeQueue.then(async () => {
    await rm(summaryPath(provider, sessionId), { force: true });
    await rm(detailPath(provider, sessionId), { force: true });
    await rebuildProviderIndex(provider, {
      sourceHost: payload?.sourceHost || hostname(),
      pushedAt: new Date().toISOString(),
    });
  });
  await writeQueue;

  const index = await readProviderIndex(provider);
  return {
    provider,
    id: sessionId,
    pushedAt: index?.pushedAt || "",
    projectCount: index?.projectCount || 0,
    sessionCount: index?.sessionCount || 0,
  };
}

async function writeSessionShard(provider, detail) {
  const summary = summarizeDetail(detail);
  await writeJson(summaryPath(provider, detail.id), summary);
  await writeJson(detailPath(provider, detail.id), detail);
}

async function rebuildProviderIndex(provider, metadata = {}) {
  const summaries = await readProviderSummaries(provider);
  const sessionsWithChildren = attachChildren(provider, summaries);
  const rootSessions = sessionsWithChildren.filter((session) => !session.isSubagent);
  const projects = buildProjects(summaries);
  const projectSessions = {};
  for (const session of rootSessions.sort(sortByLastTimestamp)) {
    if (!projectSessions[session.projectId]) projectSessions[session.projectId] = [];
    projectSessions[session.projectId].push(session);
  }

  const index = {
    provider,
    sourceHost: metadata.sourceHost || "",
    pushedAt: metadata.pushedAt || new Date().toISOString(),
    scannedAt: metadata.pushedAt || new Date().toISOString(),
    projectCount: projects.length,
    sessionCount: summaries.length,
    mainSessionCount: summaries.filter((session) => !session.isSubagent).length,
    subagentSessionCount: summaries.filter((session) => session.isSubagent).length,
    projects,
    projectSessions,
  };
  await writeJson(indexPath(provider), index);
  return index;
}

function buildProjects(summaries) {
  const projects = new Map();
  for (const summary of summaries) {
    const existing = projects.get(summary.projectId);
    if (existing) {
      existing.totalSessionCount += 1;
      if (summary.isSubagent) {
        existing.subagentSessionCount += 1;
      } else {
        existing.sessionCount += 1;
      }
      existing.messageCount += summary.messageCount || 0;
      existing.userMessageCount += summary.userMessageCount || 0;
      existing.assistantMessageCount += summary.assistantMessageCount || 0;
      existing.toolCallCount += summary.toolCallCount || 0;
      existing.toolResultCount += summary.toolResultCount || 0;
      existing.parseErrorCount += summary.parseErrorCount || 0;
      existing.firstTimestamp = minIso(existing.firstTimestamp, summary.firstTimestamp);
      existing.lastTimestamp = maxIso(existing.lastTimestamp, summary.lastTimestamp);
    } else {
      projects.set(summary.projectId, {
        id: summary.projectId,
        dirName: summary.projectDirName,
        name: summary.projectName,
        path: summary.projectPath,
        sessionCount: summary.isSubagent ? 0 : 1,
        subagentSessionCount: summary.isSubagent ? 1 : 0,
        totalSessionCount: 1,
        messageCount: summary.messageCount || 0,
        userMessageCount: summary.userMessageCount || 0,
        assistantMessageCount: summary.assistantMessageCount || 0,
        toolCallCount: summary.toolCallCount || 0,
        toolResultCount: summary.toolResultCount || 0,
        parseErrorCount: summary.parseErrorCount || 0,
        firstTimestamp: summary.firstTimestamp || "",
        lastTimestamp: summary.lastTimestamp || "",
      });
    }
  }
  return [...projects.values()].sort(sortByLastTimestamp);
}

function attachChildren(provider, summaries) {
  if (provider === "claude") return attachClaudeChildren(summaries);
  return attachCodexChildren(summaries);
}

function attachClaudeChildren(summaries) {
  const mainByProjectAndFileSession = new Map();
  const detachedByProject = new Map();
  const cloned = summaries.map((session) => ({ ...session, childSessions: [] }));

  for (const session of cloned) {
    if (!session.isSubagent) {
      mainByProjectAndFileSession.set(
        `${session.projectDirName}/${session.fileSessionId}`,
        session,
      );
    }
  }

  for (const session of cloned) {
    if (!session.isSubagent) continue;
    const parentKey = `${session.projectDirName}/${session.parentSessionId}`;
    let parent = mainByProjectAndFileSession.get(parentKey);
    if (!parent) {
      parent = detachedByProject.get(session.projectDirName);
      if (!parent) {
        parent = makeDetachedGroup("claude", session);
        detachedByProject.set(session.projectDirName, parent);
      }
    }
    if (!parent.isVirtual) {
      session.parentSessionRowId = parent.id;
      session.parentSessionTitle = parent.title || parent.fileName || "";
    }
    parent.childSessions.push(session);
  }

  return finalizeChildren([...cloned, ...detachedByProject.values()]);
}

function attachCodexChildren(summaries) {
  const mainByThreadId = new Map();
  const detachedByProject = new Map();
  const cloned = summaries.map((session) => ({ ...session, childSessions: [] }));

  for (const session of cloned) {
    if (!session.isSubagent) {
      mainByThreadId.set(session.codexThreadId || session.fileSessionId, session);
    }
  }

  for (const session of cloned) {
    if (!session.isSubagent) continue;
    let parent = mainByThreadId.get(session.parentSessionId);
    if (!parent) {
      parent = detachedByProject.get(session.projectId);
      if (!parent) {
        parent = makeDetachedGroup("codex", session);
        detachedByProject.set(session.projectId, parent);
      }
    }
    if (!parent.isVirtual) {
      session.parentSessionRowId = parent.id;
      session.parentSessionTitle = parent.title || parent.fileName || "";
    }
    parent.childSessions.push(session);
  }

  return finalizeChildren([...cloned, ...detachedByProject.values()]);
}

function finalizeChildren(sessions) {
  for (const session of sessions) {
    session.childSessions.sort(sortByLastTimestamp);
    session.childSessionCount = session.childSessions.length;
    if (session.isVirtual) updateVirtualGroupFromChildren(session);
  }
  return sessions;
}

function makeDetachedGroup(provider, child) {
  return {
    ...child,
    id: hashId(`${provider}:detached:${child.projectId || child.projectDirName}`),
    filePath: "",
    fileName: "",
    relativePath: "detached-subagents",
    sessionId: "detached-subagents",
    fileSessionId: "detached-subagents",
    codexThreadId: provider === "codex" ? "detached-subagents" : undefined,
    parentSessionId: "",
    childSessions: [],
    childSessionCount: 0,
    title: "Detached subagents",
    firstUserText: `Parent ${provider} session files were not found; orphan subagent sessions are grouped here.`,
    isSubagent: false,
    isVirtual: true,
    isDetachedSubagentGroup: true,
    messageCount: 0,
    userMessageCount: 0,
    assistantMessageCount: 0,
    toolCallCount: 0,
    toolResultCount: 0,
    attachmentCount: 0,
    parseErrorCount: 0,
    firstTimestamp: "",
    lastTimestamp: "",
    mtimeMs: 0,
    size: 0,
  };
}

function updateVirtualGroupFromChildren(parent) {
  for (const child of parent.childSessions) {
    parent.messageCount += child.messageCount || 0;
    parent.userMessageCount += child.userMessageCount || 0;
    parent.assistantMessageCount += child.assistantMessageCount || 0;
    parent.toolCallCount += child.toolCallCount || 0;
    parent.toolResultCount += child.toolResultCount || 0;
    parent.attachmentCount += child.attachmentCount || 0;
    parent.parseErrorCount += child.parseErrorCount || 0;
    parent.firstTimestamp = minIso(parent.firstTimestamp, child.firstTimestamp);
    parent.lastTimestamp = maxIso(parent.lastTimestamp, child.lastTimestamp);
  }
  parent.title = `Detached subagents (${parent.childSessions.length})`;
}

async function ensureProviderMigrated(provider) {
  const migrationKey = `${provider}:${getSessionDataDir()}`;
  if (migratedProviders.has(migrationKey)) return;
  if (await fileExists(indexPath(provider))) {
    migratedProviders.add(migrationKey);
    return;
  }

  const legacy = await readLegacyProviderSnapshot(provider);
  if (!legacy) {
    migratedProviders.add(migrationKey);
    return;
  }

  await savePushedSnapshot(provider, legacy);
  migratedProviders.add(migrationKey);
}

async function readLegacyProviderSnapshot(provider) {
  try {
    const text = await readFile(getSessionStorePath(), "utf8");
    const parsed = JSON.parse(text);
    return parsed.providers?.[provider] || null;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function readProviderIndex(provider) {
  try {
    return JSON.parse(await readFile(indexPath(provider), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function readProviderSummaries(provider) {
  const dir = summariesDir(provider);
  let names = [];
  try {
    names = await readdir(dir);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }

  const summaries = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    summaries.push(JSON.parse(await readFile(path.join(dir, name), "utf8")));
  }
  return summaries;
}

async function readSessionDetail(provider, sessionId) {
  try {
    return JSON.parse(await readFile(detailPath(provider, sessionId), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function findSessionRow(provider, sessionId) {
  const index = await readProviderIndex(provider);
  for (const sessions of Object.values(index?.projectSessions || {})) {
    const found = findSessionInRows(sessions, sessionId);
    if (found) return found;
  }
  return null;
}

function findSessionInRows(rows, sessionId) {
  for (const row of rows) {
    if (row.id === sessionId) return row;
    const found = findSessionInRows(row.childSessions || [], sessionId);
    if (found) return found;
  }
  return null;
}

export function searchSessionRows(projectSessions, query, limit = 80) {
  const normalizedQuery = normalizeSearchValue(query);
  if (!normalizedQuery) return [];

  const matches = [];
  for (const rows of Object.values(projectSessions || {})) {
    collectSearchMatches(rows, normalizedQuery, matches);
  }

  return matches
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return String(right.session.lastTimestamp || "").localeCompare(
        String(left.session.lastTimestamp || ""),
      );
    })
    .slice(0, limit)
    .map((match) => makeSearchResultRow(match.session));
}

function collectSearchMatches(rows, query, matches) {
  for (const session of rows || []) {
    const score = scoreSessionSearchMatch(session, query);
    if (score > 0) matches.push({ session, score });
    collectSearchMatches(session.childSessions || [], query, matches);
  }
}

function scoreSessionSearchMatch(session, query) {
  const idScore = bestFieldScore(
    [
      session.id,
      session.sessionId,
      session.fileSessionId,
      session.codexThreadId,
      session.fileName,
      session.relativePath,
    ],
    query,
    1000,
  );
  if (idScore) return idScore;

  const parentScore = bestFieldScore([session.parentSessionId], query, 760);
  if (parentScore) return parentScore;

  const titleScore = bestFieldScore(
    [session.title, session.firstUserText],
    query,
    500,
  );
  if (titleScore) return titleScore;

  const agentScore = bestFieldScore(
    [session.agentName, session.agentId, session.gitBranch],
    query,
    320,
  );
  if (agentScore) return agentScore;

  return bestFieldScore(
    [session.projectName, session.projectPath, session.cwd, session.projectDirName],
    query,
    120,
  );
}

function bestFieldScore(values, query, baseScore) {
  let best = 0;
  for (const value of values) {
    const text = normalizeSearchValue(value);
    if (!text) continue;
    if (text === query) best = Math.max(best, baseScore + 300);
    else if (text.startsWith(query)) best = Math.max(best, baseScore + 200);
    else if (text.includes(query)) best = Math.max(best, baseScore + 100);
  }
  return best;
}

function normalizeSearchValue(value) {
  return String(value || "").trim().toLowerCase();
}

function makeSearchResultRow(session) {
  const { childSessions: _children, ...row } = session;
  void _children;
  return {
    ...row,
    childSessions: [],
  };
}

async function resetProviderShards(provider) {
  rmSync(providerDir(provider), { recursive: true, force: true });
  await mkdir(summariesDir(provider), { recursive: true });
  await mkdir(detailsDir(provider), { recursive: true });
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(value)}\n`, "utf8");
  await rename(tmpPath, filePath);
}

function normalizeDetail(provider, detail) {
  if (!detail || typeof detail !== "object") {
    throw new Error("Session payload must include a session object");
  }
  if (!detail.id) throw new Error("Session payload must include session.id");
  return {
    ...detail,
    provider,
    childSessions: [],
    childSessionCount: 0,
  };
}

function summarizeDetail(detail) {
  const { events: _events, raw: _raw, childSessions: _children, ...summary } = detail;
  void _events;
  void _raw;
  void _children;
  return {
    ...summary,
    childSessions: [],
    childSessionCount: 0,
  };
}

function sanitizeIndex(provider, index) {
  const {
    sessionById: _sessionById,
    sessions: _sessions,
    rootSessions: _rootSessions,
    projectSessions: _projectSessions,
    ...rest
  } = index || {};
  void _sessionById;
  void _sessions;
  void _rootSessions;
  void _projectSessions;
  return {
    ...rest,
    provider,
    scannedAt: rest.scannedAt || rest.pushedAt || new Date().toISOString(),
    projectCount: rest.projectCount || rest.projects?.length || 0,
    sessionCount: rest.sessionCount || 0,
    mainSessionCount: rest.mainSessionCount || 0,
    subagentSessionCount: rest.subagentSessionCount || 0,
    projects: Array.isArray(rest.projects) ? rest.projects : [],
  };
}

function makeEmptyIndex(provider) {
  return {
    provider,
    scannedAt: "",
    projectCount: 0,
    sessionCount: 0,
    mainSessionCount: 0,
    subagentSessionCount: 0,
    projects: [],
  };
}

function validateSnapshotPayload(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Snapshot payload must be an object");
  }
  if (!payload.index || typeof payload.index !== "object") {
    throw new Error("Snapshot payload must include index");
  }
  if (!payload.sessions || typeof payload.sessions !== "object") {
    throw new Error("Snapshot payload must include sessions");
  }
}

function validateProvider(provider) {
  if (!PROVIDERS.has(provider)) {
    throw new Error(`Unknown provider: ${provider}`);
  }
}

function providerDir(provider) {
  return path.join(getSessionDataDir(), "providers", provider);
}

function summariesDir(provider) {
  return path.join(providerDir(provider), "summaries");
}

function detailsDir(provider) {
  return path.join(providerDir(provider), "sessions");
}

function indexPath(provider) {
  return path.join(providerDir(provider), "index.json");
}

function summaryPath(provider, sessionId) {
  return path.join(summariesDir(provider), `${safeFileName(sessionId)}.json`);
}

function detailPath(provider, sessionId) {
  return path.join(detailsDir(provider), `${safeFileName(sessionId)}.json`);
}

function safeFileName(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, "_");
}

async function fileExists(filePath) {
  try {
    await readFile(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function hashId(value) {
  return createHash("sha256").update(value).digest("base64url").slice(0, 18);
}

function sortByLastTimestamp(a, b) {
  return compareIso(b.lastTimestamp, a.lastTimestamp);
}

function minIso(a, b) {
  if (!a) return b || "";
  if (!b) return a;
  return compareIso(a, b) <= 0 ? a : b;
}

function maxIso(a, b) {
  if (!a) return b || "";
  if (!b) return a;
  return compareIso(a, b) >= 0 ? a : b;
}

function compareIso(a, b) {
  const left = Date.parse(a || "");
  const right = Date.parse(b || "");
  if (Number.isNaN(left) && Number.isNaN(right)) return 0;
  if (Number.isNaN(left)) return -1;
  if (Number.isNaN(right)) return 1;
  return left - right;
}
