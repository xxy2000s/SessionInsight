import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { compactText, encodeId } from "./claudeSessions.mjs";

const DEFAULT_CACHE_MS = 2_000;

const cacheByProvider = new Map();

export function getCodexHome() {
  return process.env.CODEX_HOME || path.join(homedir(), ".codex");
}

export function getDoujieHome() {
  return process.env.DOUJIE_HOME || path.join(homedir(), ".doujie");
}

export function clearCodexSessionCache() {
  clearCodexLikeSessionCache("codex");
}

export function clearDoujieSessionCache() {
  clearCodexLikeSessionCache("doujie");
}

function clearCodexLikeSessionCache(provider) {
  for (const key of cacheByProvider.keys()) {
    if (key.startsWith(`${provider}:`)) cacheByProvider.delete(key);
  }
}

export async function scanCodexSessions(options = {}) {
  const codexHome = options.codexHome || getCodexHome();
  return scanCodexLikeSessions({
    provider: "codex",
    home: codexHome,
    sessionsRoot: options.sessionsRoot || path.join(codexHome, "sessions"),
    options,
  });
}

export async function scanDoujieSessions(options = {}) {
  const doujieHome = options.doujieHome || getDoujieHome();
  return scanCodexLikeSessions({
    provider: "doujie",
    home: doujieHome,
    sessionsRoot: options.sessionsRoot || path.join(doujieHome, "sessions", "links"),
    options,
  });
}

async function scanCodexLikeSessions({ provider, home, sessionsRoot, options }) {
  const cacheMs = options.cacheMs ?? DEFAULT_CACHE_MS;
  const now = Date.now();
  const cacheKey = `${provider}:${home}:${sessionsRoot}`;
  const cache = cacheByProvider.get(cacheKey);

  if (
    !options.noCache &&
    cache &&
    now - cache.createdAt < cacheMs
  ) {
    return cache.data;
  }

  const titleByThreadId = await readSessionIndex(home);
  const files = await findJsonlFiles(sessionsRoot);
  const sessions = [];
  const projects = new Map();

  for (const filePath of files) {
    const parsed = await parseCodexSessionFile(filePath, sessionsRoot, {
      provider,
      titleByThreadId,
    });
    sessions.push(parsed.summary);

    const existing = projects.get(parsed.summary.projectId);
    if (existing) {
      existing.totalSessionCount += 1;
      if (parsed.summary.isSubagent) {
        existing.subagentSessionCount += 1;
      } else {
        existing.sessionCount += 1;
      }
      existing.messageCount += parsed.summary.messageCount;
      existing.userMessageCount += parsed.summary.userMessageCount;
      existing.assistantMessageCount += parsed.summary.assistantMessageCount;
      existing.toolCallCount += parsed.summary.toolCallCount;
      existing.toolResultCount += parsed.summary.toolResultCount;
      existing.parseErrorCount += parsed.summary.parseErrorCount;
      existing.firstTimestamp = minIso(
        existing.firstTimestamp,
        parsed.summary.firstTimestamp,
      );
      existing.lastTimestamp = maxIso(
        existing.lastTimestamp,
        parsed.summary.lastTimestamp,
      );
    } else {
      projects.set(parsed.summary.projectId, {
        id: parsed.summary.projectId,
        dirName: parsed.summary.projectDirName,
        name: parsed.summary.projectName,
        path: parsed.summary.projectPath,
        sessionCount: parsed.summary.isSubagent ? 0 : 1,
        subagentSessionCount: parsed.summary.isSubagent ? 1 : 0,
        totalSessionCount: 1,
        messageCount: parsed.summary.messageCount,
        userMessageCount: parsed.summary.userMessageCount,
        assistantMessageCount: parsed.summary.assistantMessageCount,
        toolCallCount: parsed.summary.toolCallCount,
        toolResultCount: parsed.summary.toolResultCount,
        parseErrorCount: parsed.summary.parseErrorCount,
        firstTimestamp: parsed.summary.firstTimestamp,
        lastTimestamp: parsed.summary.lastTimestamp,
      });
    }
  }

  const sessionsWithChildren = attachCodexSubagentSessions(sessions, provider);
  const rootSessions = sessionsWithChildren.filter((session) => !session.isSubagent);
  const sessionById = new Map(
    sessionsWithChildren
      .filter((session) => !session.isVirtual)
      .map((session) => [session.id, session]),
  );

  const data = {
    provider,
    codexHome: home,
    doujieHome: provider === "doujie" ? home : undefined,
    projectsRoot: sessionsRoot,
    scannedAt: new Date().toISOString(),
    projectCount: projects.size,
    sessionCount: sessions.length,
    mainSessionCount: sessions.filter((session) => !session.isSubagent).length,
    subagentSessionCount: sessions.filter((session) => session.isSubagent).length,
    projects: [...projects.values()].sort(sortByLastTimestamp),
    sessions: sessionsWithChildren.sort(sortByLastTimestamp),
    rootSessions: rootSessions.sort(sortByLastTimestamp),
    sessionById,
  };

  cacheByProvider.set(cacheKey, { createdAt: now, data });
  return data;
}

export async function getCodexProjectSessions(projectId, options = {}) {
  const index = await scanCodexSessions(options);
  return index.rootSessions.filter((session) => session.projectId === projectId);
}

export async function getDoujieProjectSessions(projectId, options = {}) {
  const index = await scanDoujieSessions(options);
  return index.rootSessions.filter((session) => session.projectId === projectId);
}

export async function getCodexSessionDetail(sessionId, options = {}) {
  const index = await scanCodexSessions(options);
  return getCodexLikeSessionDetail(index, sessionId, "codex");
}

export async function getDoujieSessionDetail(sessionId, options = {}) {
  const index = await scanDoujieSessions(options);
  return getCodexLikeSessionDetail(index, sessionId, "doujie");
}

async function getCodexLikeSessionDetail(index, sessionId, provider) {
  const summary = index.sessionById.get(sessionId);
  if (!summary) return null;
  const titleByThreadId = await readSessionIndex(index.codexHome);
  const detail = await parseCodexSessionFile(summary.filePath, index.projectsRoot, {
    includeEvents: true,
    provider,
    titleByThreadId,
  });
  return {
    ...detail.summary,
    parentSessionRowId: summary.parentSessionRowId || "",
    parentSessionTitle: summary.parentSessionTitle || "",
    childSessions: summary.childSessions || [],
    childSessionCount: summary.childSessionCount || 0,
    events: detail.events,
  };
}

export async function parseCodexSessionFile(filePath, sessionsRoot, options = {}) {
  const provider = options.provider || "codex";
  const relativePath = path.relative(sessionsRoot, filePath);
  const fileStats = await stat(filePath);
  const fileThreadId = parseThreadIdFromFileName(filePath);
  const summary = {
    id: encodeId(`${provider}:${filePath}`),
    provider,
    filePath,
    fileName: path.basename(filePath),
    relativePath,
    projectId: "",
    projectDirName: "",
    projectName: "unknown",
    projectPath: "",
    sessionId: fileThreadId,
    fileSessionId: fileThreadId,
    claudeSessionId: "",
    codexThreadId: fileThreadId,
    parentSessionId: "",
    childSessions: [],
    childSessionCount: 0,
    title: options.titleByThreadId?.get(fileThreadId)?.threadName || "",
    agentName: "",
    permissionMode: "",
    firstUserText: "",
    cwd: "",
    gitBranch: "",
    slug: "",
    isSubagent: false,
    isSidechain: false,
    agentId: "",
    promptId: "",
    messageCount: 0,
    userMessageCount: 0,
    assistantMessageCount: 0,
    toolCallCount: 0,
    toolResultCount: 0,
    attachmentCount: 0,
    parseErrorCount: 0,
    firstTimestamp: "",
    lastTimestamp: "",
    mtimeMs: fileStats.mtimeMs,
    size: fileStats.size,
  };

  const events = [];
  let lineNumber = 0;
  let sawFirstMeta = false;

  for await (const line of readJsonLines(filePath)) {
    lineNumber += 1;
    if (!line.trim()) continue;

    let raw;
    try {
      raw = JSON.parse(line);
    } catch (error) {
      summary.parseErrorCount += 1;
      if (options.includeEvents) {
        events.push({
          id: `${summary.id}:${lineNumber}`,
          kind: "parse_error",
          lineNumber,
          error: error.message,
          raw: line,
        });
      }
      continue;
    }

    updateCodexSummary(summary, raw, { sawFirstMeta });
    if (raw.type === "session_meta" && !sawFirstMeta) sawFirstMeta = true;

    if (options.includeEvents) {
      const event = normalizeCodexEvent(raw, summary.id, lineNumber);
      if (event) events.push(event);
    }
  }

  setCodexProject(summary, provider);

  if (!summary.title) {
    summary.title =
      summary.agentName ||
      summary.firstUserText ||
      options.titleByThreadId?.get(summary.codexThreadId)?.threadName ||
      summary.fileName;
  }

  return { summary, events };
}

export async function readSessionIndex(codexHome) {
  const indexPath = path.join(codexHome, "session_index.jsonl");
  const byId = new Map();

  let text = "";
  try {
    text = await readFile(indexPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return byId;
    throw error;
  }

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line);
      if (!item.id) continue;
      const existing = byId.get(item.id);
      if (!existing || compareIso(item.updated_at, existing.updatedAt) > 0) {
        byId.set(item.id, {
          threadName: item.thread_name || "",
          updatedAt: item.updated_at || "",
        });
      }
    } catch {
      // Ignore corrupt index rows; the session files are authoritative.
    }
  }

  return byId;
}

function updateCodexSummary(summary, raw, state) {
  const timestamp = raw.timestamp || raw.payload?.timestamp || raw.payload?.started_at || "";
  if (timestamp) {
    summary.firstTimestamp = minIso(summary.firstTimestamp, timestamp);
    summary.lastTimestamp = maxIso(summary.lastTimestamp, timestamp);
  }

  if (raw.type === "session_meta" && (!state.sawFirstMeta || !summary.cwd)) {
    const payload = raw.payload || {};
    summary.codexThreadId = payload.id || summary.codexThreadId;
    summary.sessionId = payload.id || summary.sessionId;
    summary.fileSessionId = payload.id || summary.fileSessionId;
    summary.cwd ||= payload.cwd || "";
    summary.gitBranch ||= payload.git?.branch || "";
    summary.isSubagent = payload.thread_source === "subagent";
    summary.isSidechain = summary.isSubagent;
    summary.parentSessionId =
      payload.parent_thread_id ||
      payload.source?.subagent?.thread_spawn?.parent_thread_id ||
      payload.forked_from_id ||
      (summary.isSubagent ? payload.session_id : "") ||
      "";
    summary.agentName ||=
      payload.agent_nickname ||
      payload.source?.subagent?.thread_spawn?.agent_nickname ||
      "";
    summary.agentId ||= payload.id || "";
  }

  if (raw.type !== "event_msg" && raw.type !== "response_item") return;

  const payload = raw.payload || {};
  if (raw.type === "event_msg" && payload.type === "user_message") {
    const text = compactText(payload.message || "", 140);
    if (text && !isCodexMetaUserText(text)) {
      summary.messageCount += 1;
      summary.userMessageCount += 1;
      summary.firstUserText ||= text;
    }
    return;
  }

  if (raw.type === "event_msg" && payload.type === "agent_message") {
    if (payload.message) {
      summary.messageCount += 1;
      summary.assistantMessageCount += 1;
    }
    return;
  }

  if (raw.type === "response_item" && isCodexToolCall(payload)) {
    summary.toolCallCount += 1;
    return;
  }

  if (raw.type === "response_item" && isCodexToolResult(payload)) {
    summary.toolResultCount += 1;
  }
}

function normalizeCodexEvent(raw, sessionHash, lineNumber) {
  const payload = raw.payload || {};
  const timestamp = raw.timestamp || payload.timestamp || payload.started_at || "";

  if (raw.type === "session_meta") {
    const meta = { ...payload };
    delete meta.base_instructions;
    return {
      id: `${sessionHash}:${lineNumber}`,
      kind: "metadata",
      label: payload.thread_source === "subagent" ? "Codex subagent" : "Codex session",
      value: payload.agent_nickname || payload.id || payload.session_id || "metadata",
      sessionId: payload.id || payload.session_id || "",
      timestamp,
      lineNumber,
      raw: meta,
    };
  }

  if (raw.type === "event_msg" && payload.type === "user_message") {
    const text = payload.message || "";
    return {
      id: `${sessionHash}:${lineNumber}`,
      role: "user",
      kind: "message",
      timestamp,
      isMetaArtifact: isCodexMetaUserText(text),
      segments: [{ kind: "text", text, index: 0 }],
      rawType: payload.type,
      lineNumber,
    };
  }

  if (raw.type === "event_msg" && payload.type === "agent_message") {
    return {
      id: `${sessionHash}:${lineNumber}`,
      role: "assistant",
      kind: "message",
      timestamp,
      isMeta: payload.phase !== "final_answer",
      phase: payload.phase || "",
      segments: [{ kind: "text", text: payload.message || "", index: 0 }],
      rawType: payload.type,
      lineNumber,
    };
  }

  if (raw.type === "response_item" && isCodexToolCall(payload)) {
    return {
      id: payload.id || `${sessionHash}:${lineNumber}`,
      role: "assistant",
      kind: "message",
      timestamp,
      isMeta: true,
      segments: [
        {
          kind: "tool_call",
          id: payload.call_id || payload.id || "",
          name: payload.name || payload.type || "tool",
          input: parseMaybeJson(payload.arguments ?? payload.input ?? ""),
          index: 0,
        },
      ],
      rawType: payload.type,
      lineNumber,
    };
  }

  if (raw.type === "response_item" && isCodexToolResult(payload)) {
    return {
      id: `${sessionHash}:${lineNumber}`,
      role: "tool",
      sourceRole: "assistant",
      kind: "tool_result",
      timestamp,
      segments: [
        {
          kind: "tool_result",
          toolUseId: payload.call_id || "",
          content: payload.output ?? "",
          isError: false,
          index: 0,
        },
      ],
      rawType: payload.type,
      lineNumber,
    };
  }

  if (raw.type === "event_msg" && payload.type === "patch_apply_end") {
    return {
      id: `${sessionHash}:${lineNumber}`,
      role: "tool",
      kind: "tool_result",
      timestamp,
      segments: [
        {
          kind: "tool_result",
          toolUseId: payload.call_id || "",
          content: formatPatchApplyEnd(payload),
          isError: payload.success === false,
          index: 0,
        },
      ],
      rawType: payload.type,
      lineNumber,
    };
  }

  if (
    raw.type === "response_item" &&
    (payload.type === "reasoning" || payload.type === "tool_search_output")
  ) {
    return {
      id: payload.id || `${sessionHash}:${lineNumber}`,
      kind: "raw",
      rawType: payload.type,
      timestamp,
      lineNumber,
      raw: compactRawPayload(payload),
    };
  }

  if (
    raw.type === "event_msg" &&
    ["token_count", "task_started", "task_complete", "thread_settings_applied"].includes(
      payload.type,
    )
  ) {
    return null;
  }

  return {
    id: `${sessionHash}:${lineNumber}`,
    kind: "raw",
    rawType: payload.type || raw.type || "unknown",
    timestamp,
    lineNumber,
    raw: compactRawPayload(raw),
  };
}

function attachCodexSubagentSessions(sessions, provider = "codex") {
  const mainByThreadId = new Map();
  const detachedByProject = new Map();
  const cloned = sessions.map((session) => ({ ...session, childSessions: [] }));

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
        parent = makeDetachedCodexGroup(session, provider);
        detachedByProject.set(session.projectId, parent);
      }
    }
    if (!parent.isVirtual) {
      session.parentSessionRowId = parent.id;
      session.parentSessionTitle = parent.title || parent.fileName || "";
    }
    parent.childSessions.push(session);
  }

  const withVirtualParents = [...cloned, ...detachedByProject.values()];
  for (const session of withVirtualParents) {
    if (session.isVirtual) updateVirtualCodexGroupFromChildren(session);
    session.childSessions.sort(sortByLastTimestamp);
    session.childSessionCount = session.childSessions.length;
  }
  return withVirtualParents;
}

function makeDetachedCodexGroup(childSession, provider = "codex") {
  const providerLabel = provider === "doujie" ? "Doujie" : "Codex";
  return {
    ...childSession,
    id: encodeId(`${provider}-detached:${childSession.projectId}`),
    filePath: "",
    fileName: "",
    relativePath: "detached-subagents",
    sessionId: "detached-subagents",
    fileSessionId: "detached-subagents",
    codexThreadId: "detached-subagents",
    parentSessionId: "",
    childSessions: [],
    childSessionCount: 0,
    title: "Detached subagents",
    firstUserText:
      `Parent ${providerLabel} thread files were not found; orphan subagent sessions are grouped here.`,
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

function updateVirtualCodexGroupFromChildren(parent) {
  for (const child of parent.childSessions) {
    parent.messageCount += child.messageCount;
    parent.userMessageCount += child.userMessageCount;
    parent.assistantMessageCount += child.assistantMessageCount;
    parent.toolCallCount += child.toolCallCount;
    parent.toolResultCount += child.toolResultCount;
    parent.attachmentCount += child.attachmentCount;
    parent.parseErrorCount += child.parseErrorCount;
    parent.firstTimestamp = minIso(parent.firstTimestamp, child.firstTimestamp);
    parent.lastTimestamp = maxIso(parent.lastTimestamp, child.lastTimestamp);
  }
  parent.title = `Detached subagents (${parent.childSessions.length})`;
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

async function* readJsonLines(filePath) {
  const rl = readline.createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    yield line;
  }
}

function parseThreadIdFromFileName(filePath) {
  const base = path.basename(filePath, ".jsonl");
  const match = base.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  return match?.[1] || base;
}

function setCodexProject(summary, provider = "codex") {
  const providerLabel = provider === "doujie" ? "Doujie" : "Codex";
  const projectPath = summary.cwd || `Unknown ${providerLabel} Project`;
  summary.projectPath = projectPath;
  summary.projectDirName = projectPath;
  summary.projectName = path.basename(projectPath) || projectPath;
  summary.projectId = encodeId(`${provider}-project:${projectPath}`);
}

function isCodexToolCall(payload) {
  return (
    payload.type === "function_call" ||
    payload.type === "custom_tool_call" ||
    payload.type === "tool_search_call"
  );
}

function isCodexToolResult(payload) {
  return (
    payload.type === "function_call_output" ||
    payload.type === "custom_tool_call_output"
  );
}

function isCodexMetaUserText(text) {
  return (
    text.trim().startsWith("<environment_context>") ||
    text.trim().startsWith("<subagent_notification>")
  );
}

function parseMaybeJson(value) {
  if (typeof value !== "string") return value;
  if (!value.trim()) return "";
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function formatPatchApplyEnd(payload) {
  return JSON.stringify(
    {
      success: payload.success,
      status: payload.status,
      stdout: payload.stdout,
      stderr: payload.stderr,
      changedFiles: Object.keys(payload.changes || {}),
    },
    null,
    2,
  );
}

function compactRawPayload(value) {
  const clone = { ...value };
  delete clone.encrypted_content;
  delete clone.base_instructions;
  return clone;
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
