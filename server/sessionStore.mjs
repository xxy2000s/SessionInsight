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
import path from "node:path";

const DEFAULT_STORE_PATH = path.resolve("data/session-store.json");
const PROVIDERS = new Set(["claude", "codex", "doujie"]);
const DEFAULT_MACHINE_ID = "server";
const DEFAULT_MACHINE_LABEL = "Server";

let writeQueue = Promise.resolve();
const migratedProviders = new Set();

export function getSessionStorePath() {
  return process.env.SESSION_STORE_PATH || DEFAULT_STORE_PATH;
}

export function getSessionDataDir() {
  return process.env.SESSION_DATA_DIR || path.dirname(getSessionStorePath());
}

export function isPushSourceMode() {
  return process.env.SESSION_SOURCE === "push" || process.env.SESSION_SOURCE === "push-index";
}

export function isLocalIndexSourceMode() {
  return (
    process.env.SESSION_SOURCE === "local-index" ||
    process.env.SESSION_SOURCE === "hybrid-index"
  );
}

export function isHybridSourceMode() {
  return process.env.SESSION_SOURCE === "hybrid-index";
}

export function isShardedSourceMode() {
  return isPushSourceMode() || isLocalIndexSourceMode();
}

export function getDefaultMachineId() {
  return normalizeMachineId(process.env.SESSION_LOCAL_MACHINE_ID || DEFAULT_MACHINE_ID);
}

export function getDefaultMachineLabel() {
  return normalizeMachineLabel(process.env.SESSION_LOCAL_MACHINE_LABEL || DEFAULT_MACHINE_LABEL);
}

export async function getMachines() {
  const machines = new Map();
  const addMachine = (machine) => {
    const id = normalizeMachineId(machine.id);
    machines.set(id, {
      id,
      label: normalizeMachineLabel(machine.label || id),
      kind: machine.kind || "remote",
      updatedAt: machine.updatedAt || "",
    });
  };

  if (isLocalIndexSourceMode()) {
    addMachine({
      id: getDefaultMachineId(),
      label: getDefaultMachineLabel(),
      kind: "local",
    });
  }

  let names = [];
  try {
    names = await readdir(machinesDir(), { withFileTypes: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  for (const entry of names) {
    if (!entry.isDirectory()) continue;
    const machine = await readMachineMetadata(entry.name);
    addMachine(machine || { id: entry.name, label: entry.name });
  }

  return [...machines.values()].sort((left, right) => {
    if (left.id === getDefaultMachineId()) return -1;
    if (right.id === getDefaultMachineId()) return 1;
    return left.label.localeCompare(right.label);
  });
}

export async function getPushedIndex(provider, machineId = getDefaultMachineId()) {
  validateProvider(provider);
  const normalizedMachineId = normalizeMachineId(machineId);
  await ensureProviderMigrated(provider, normalizedMachineId);
  const index = await readProviderIndex(provider, normalizedMachineId);
  return index
    ? sanitizeIndex(provider, index, normalizedMachineId)
    : makeEmptyIndex(provider, normalizedMachineId);
}

export async function getPushedProjectSessions(
  provider,
  projectId,
  machineId = getDefaultMachineId(),
) {
  validateProvider(provider);
  const normalizedMachineId = normalizeMachineId(machineId);
  await ensureProviderMigrated(provider, normalizedMachineId);
  const index = await readProviderIndex(provider, normalizedMachineId);
  return index?.projectSessions?.[projectId] || [];
}

export async function getPushedSessionDetail(
  provider,
  sessionId,
  machineId = getDefaultMachineId(),
) {
  validateProvider(provider);
  const normalizedMachineId = normalizeMachineId(machineId);
  await ensureProviderMigrated(provider, normalizedMachineId);
  const detail = await readSessionDetail(provider, sessionId, normalizedMachineId);
  if (!detail) return null;

  const row = await findSessionRow(provider, sessionId, normalizedMachineId);
  return {
    ...detail,
    machineId: normalizedMachineId,
    parentSessionRowId: row?.parentSessionRowId || detail.parentSessionRowId || "",
    parentSessionTitle: row?.parentSessionTitle || detail.parentSessionTitle || "",
    childSessions: row?.childSessions || [],
    childSessionCount: row?.childSessionCount || 0,
  };
}

export async function searchPushedSessions(
  provider,
  query,
  limit = 80,
  machineId = getDefaultMachineId(),
) {
  validateProvider(provider);
  const normalizedMachineId = normalizeMachineId(machineId);
  await ensureProviderMigrated(provider, normalizedMachineId);
  const index = await readProviderIndex(provider, normalizedMachineId);
  return searchSessionRows(index?.projectSessions || {}, query, limit);
}

export async function getPushedManifest(provider, machineId = getDefaultMachineId()) {
  validateProvider(provider);
  const normalizedMachineId = normalizeMachineId(machineId);
  await ensureProviderMigrated(provider, normalizedMachineId);
  const summaries = await readProviderSummaries(provider, normalizedMachineId);
  return {
    provider,
    machineId: normalizedMachineId,
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

export async function savePushedSnapshot(
  provider,
  payload,
  machineId = payload?.machineId || getDefaultMachineId(),
) {
  validateProvider(provider);
  const normalizedMachineId = normalizeMachineId(machineId);
  validateSnapshotPayload(payload);
  const details = Object.values(payload.sessions || {});

  writeQueue = writeQueue.then(async () => {
    await writeMachineMetadata({
      id: normalizedMachineId,
      label: payload.machineLabel || payload.sourceLabel || payload.sourceHost || normalizedMachineId,
      kind: payload.machineKind || "push",
    });
    await resetProviderShards(provider, normalizedMachineId);
    for (const detail of details) {
      await writeSessionShard(provider, normalizeDetail(provider, detail, normalizedMachineId));
    }
    await rebuildProviderIndex(provider, normalizedMachineId, {
      sourceHost: payload.sourceHost || normalizedMachineId,
      machineLabel: payload.machineLabel || payload.sourceLabel || payload.sourceHost || "",
      pushedAt: new Date().toISOString(),
    });
  });
  await writeQueue;

  const index = await readProviderIndex(provider, normalizedMachineId);
  return {
    provider,
    machineId: normalizedMachineId,
    pushedAt: index?.pushedAt || "",
    projectCount: index?.projectCount || 0,
    sessionCount: index?.sessionCount || 0,
    detailedSessionCount: details.length,
  };
}

export async function savePushedSession(
  provider,
  payload,
  machineId = payload?.machineId || getDefaultMachineId(),
) {
  validateProvider(provider);
  const normalizedMachineId = normalizeMachineId(machineId);
  const detail = normalizeDetail(provider, payload?.session || payload?.detail || payload, normalizedMachineId);

  writeQueue = writeQueue.then(async () => {
    await writeMachineMetadata({
      id: normalizedMachineId,
      label: payload?.machineLabel || payload?.sourceLabel || payload?.sourceHost || normalizedMachineId,
      kind: payload?.machineKind || "push",
    });
    await writeSessionShard(provider, detail, normalizedMachineId);
    await rebuildProviderIndex(provider, normalizedMachineId, {
      sourceHost: payload?.sourceHost || normalizedMachineId,
      machineLabel: payload?.machineLabel || payload?.sourceLabel || payload?.sourceHost || "",
      pushedAt: new Date().toISOString(),
    });
  });
  await writeQueue;

  const index = await readProviderIndex(provider, normalizedMachineId);
  return {
    provider,
    machineId: normalizedMachineId,
    id: detail.id,
    pushedAt: index?.pushedAt || "",
    projectCount: index?.projectCount || 0,
    sessionCount: index?.sessionCount || 0,
  };
}

export async function deletePushedSession(
  provider,
  payload,
  machineId = payload?.machineId || getDefaultMachineId(),
) {
  validateProvider(provider);
  const normalizedMachineId = normalizeMachineId(machineId);
  const sessionId = payload?.sessionId || payload?.id;
  if (!sessionId) throw new Error("Delete payload must include sessionId");

  writeQueue = writeQueue.then(async () => {
    await rm(summaryPath(provider, sessionId, normalizedMachineId), { force: true });
    await rm(detailPath(provider, sessionId, normalizedMachineId), { force: true });
    await writeMachineMetadata({
      id: normalizedMachineId,
      label: payload?.machineLabel || payload?.sourceLabel || payload?.sourceHost || normalizedMachineId,
      kind: payload?.machineKind || "push",
    });
    await rebuildProviderIndex(provider, normalizedMachineId, {
      sourceHost: payload?.sourceHost || normalizedMachineId,
      machineLabel: payload?.machineLabel || payload?.sourceLabel || payload?.sourceHost || "",
      pushedAt: new Date().toISOString(),
    });
  });
  await writeQueue;

  const index = await readProviderIndex(provider, normalizedMachineId);
  return {
    provider,
    machineId: normalizedMachineId,
    id: sessionId,
    pushedAt: index?.pushedAt || "",
    projectCount: index?.projectCount || 0,
    sessionCount: index?.sessionCount || 0,
  };
}

async function writeSessionShard(provider, detail, machineId) {
  const summary = summarizeDetail(detail);
  await writeJson(summaryPath(provider, detail.id, machineId), summary);
  await writeJson(detailPath(provider, detail.id, machineId), detail);
}

async function rebuildProviderIndex(provider, machineId, metadata = {}) {
  const normalizedMachineId = normalizeMachineId(machineId);
  const summaries = await readProviderSummaries(provider, normalizedMachineId);
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
    machineId: normalizedMachineId,
    machineLabel: normalizeMachineLabel(metadata.machineLabel || normalizedMachineId),
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
  await writeJson(indexPath(provider, normalizedMachineId), index);
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

async function ensureProviderMigrated(provider, machineId = getDefaultMachineId()) {
  const normalizedMachineId = normalizeMachineId(machineId);
  const migrationKey = `${normalizedMachineId}:${provider}:${getSessionDataDir()}`;
  if (migratedProviders.has(migrationKey)) return;
  if (await fileExists(indexPath(provider, normalizedMachineId))) {
    migratedProviders.add(migrationKey);
    return;
  }

  const legacy = await readLegacyProviderSnapshot(provider);
  if (!legacy) {
    migratedProviders.add(migrationKey);
    return;
  }

  await savePushedSnapshot(provider, {
    ...legacy,
    machineId: normalizedMachineId,
    machineLabel: normalizedMachineId === getDefaultMachineId()
      ? getDefaultMachineLabel()
      : normalizedMachineId,
  }, normalizedMachineId);
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

async function readProviderIndex(provider, machineId) {
  try {
    return JSON.parse(await readFile(indexPath(provider, machineId), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function readProviderSummaries(provider, machineId) {
  const dir = summariesDir(provider, machineId);
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

async function readSessionDetail(provider, sessionId, machineId) {
  try {
    return JSON.parse(await readFile(detailPath(provider, sessionId, machineId), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function findSessionRow(provider, sessionId, machineId) {
  const index = await readProviderIndex(provider, machineId);
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

async function resetProviderShards(provider, machineId) {
  rmSync(providerDir(provider, machineId), { recursive: true, force: true });
  await mkdir(summariesDir(provider, machineId), { recursive: true });
  await mkdir(detailsDir(provider, machineId), { recursive: true });
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(value)}\n`, "utf8");
  await rename(tmpPath, filePath);
}

function normalizeDetail(provider, detail, machineId) {
  if (!detail || typeof detail !== "object") {
    throw new Error("Session payload must include a session object");
  }
  if (!detail.id) throw new Error("Session payload must include session.id");
  return {
    ...detail,
    provider,
    machineId,
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

function sanitizeIndex(provider, index, machineId) {
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
    machineId,
    machineLabel: rest.machineLabel || machineId,
    scannedAt: rest.scannedAt || rest.pushedAt || new Date().toISOString(),
    projectCount: rest.projectCount || rest.projects?.length || 0,
    sessionCount: rest.sessionCount || 0,
    mainSessionCount: rest.mainSessionCount || 0,
    subagentSessionCount: rest.subagentSessionCount || 0,
    projects: Array.isArray(rest.projects) ? rest.projects : [],
  };
}

function makeEmptyIndex(provider, machineId = getDefaultMachineId()) {
  return {
    provider,
    machineId,
    machineLabel: machineId,
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

function machinesDir() {
  return path.join(getSessionDataDir(), "machines");
}

function machineDir(machineId) {
  return path.join(machinesDir(), normalizeMachineId(machineId));
}

function machineMetadataPath(machineId) {
  return path.join(machineDir(machineId), "machine.json");
}

function providerDir(provider, machineId) {
  return path.join(machineDir(machineId), "providers", provider);
}

function summariesDir(provider, machineId) {
  return path.join(providerDir(provider, machineId), "summaries");
}

function detailsDir(provider, machineId) {
  return path.join(providerDir(provider, machineId), "sessions");
}

function indexPath(provider, machineId) {
  return path.join(providerDir(provider, machineId), "index.json");
}

function summaryPath(provider, sessionId, machineId) {
  return path.join(summariesDir(provider, machineId), `${safeFileName(sessionId)}.json`);
}

function detailPath(provider, sessionId, machineId) {
  return path.join(detailsDir(provider, machineId), `${safeFileName(sessionId)}.json`);
}

function safeFileName(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, "_");
}

function normalizeMachineId(value) {
  const machineId = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(machineId)) {
    throw new Error("Machine id must use 1-64 lowercase letters, numbers, dots, underscores, or dashes");
  }
  return machineId;
}

function normalizeMachineLabel(value) {
  return String(value || "").trim().slice(0, 80) || DEFAULT_MACHINE_LABEL;
}

async function readMachineMetadata(machineId) {
  try {
    const parsed = JSON.parse(await readFile(machineMetadataPath(machineId), "utf8"));
    return {
      id: normalizeMachineId(parsed.id || machineId),
      label: normalizeMachineLabel(parsed.label || parsed.id || machineId),
      kind: parsed.kind || "remote",
      updatedAt: parsed.updatedAt || "",
    };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeMachineMetadata(machine) {
  const id = normalizeMachineId(machine.id);
  await writeJson(machineMetadataPath(id), {
    id,
    label: normalizeMachineLabel(machine.label || id),
    kind: machine.kind || "remote",
    updatedAt: new Date().toISOString(),
  });
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
