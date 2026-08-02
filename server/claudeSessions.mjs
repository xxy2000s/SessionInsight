import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import readline from "node:readline";

const DEFAULT_CACHE_MS = 2_000;

let cache = null;

export function getClaudeHome() {
  return process.env.CLAUDE_HOME || path.join(homedir(), ".claude");
}

export function decodeProjectPath(projectDirName) {
  if (!projectDirName.startsWith("-")) return projectDirName;
  return `/${projectDirName.slice(1).split("-").filter(Boolean).join("/")}`;
}

export function encodeId(value) {
  return createHash("sha256").update(value).digest("base64url").slice(0, 18);
}

export function clearSessionCache() {
  cache = null;
}

export async function scanClaudeSessions(options = {}) {
  const claudeHome = options.claudeHome || getClaudeHome();
  const cacheMs = options.cacheMs ?? DEFAULT_CACHE_MS;
  const now = Date.now();

  if (
    !options.noCache &&
    cache &&
    cache.claudeHome === claudeHome &&
    now - cache.createdAt < cacheMs
  ) {
    return cache.data;
  }

  const projectsRoot = path.join(claudeHome, "projects");
  const files = await findJsonlFiles(projectsRoot);
  const sessions = [];
  const projects = new Map();

  for (const filePath of files) {
    const parsed = await parseSessionFile(filePath, projectsRoot);
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
      existing.firstTimestamp = minIso(existing.firstTimestamp, parsed.summary.firstTimestamp);
      existing.lastTimestamp = maxIso(existing.lastTimestamp, parsed.summary.lastTimestamp);
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

  const sessionsWithChildren = attachSubagentSessions(sessions);
  const rootSessions = sessionsWithChildren.filter((session) => !session.isSubagent);
  const sessionById = new Map(
    sessionsWithChildren
      .filter((session) => !session.isVirtual)
      .map((session) => [session.id, session]),
  );

  const data = {
    claudeHome,
    projectsRoot,
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

  cache = { claudeHome, createdAt: now, data };
  return data;
}

export async function getProjectSessions(projectId, options = {}) {
  const index = await scanClaudeSessions(options);
  return index.rootSessions.filter((session) => session.projectId === projectId);
}

export async function getSessionDetail(sessionId, options = {}) {
  const index = await scanClaudeSessions(options);
  const summary = index.sessionById.get(sessionId);
  if (!summary) return null;
  const detail = await parseSessionFile(summary.filePath, index.projectsRoot, {
    includeEvents: true,
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

export async function parseSessionFile(filePath, projectsRoot, options = {}) {
  const relativePath = path.relative(projectsRoot, filePath);
  const parts = relativePath.split(path.sep);
  const projectDirName = parts[0] || "unknown";
  const projectPath = decodeProjectPath(projectDirName);
  const projectName = path.basename(projectPath) || projectPath;
  const subagentIndex = parts.indexOf("subagents");
  const isSubagent = subagentIndex > -1;
  const parentSessionId = isSubagent && subagentIndex > 1 ? parts[subagentIndex - 1] : "";
  const fileSessionId = path.basename(filePath, ".jsonl");
  const fileStats = await stat(filePath);

  const summary = {
    id: encodeId(filePath),
    filePath,
    fileName: path.basename(filePath),
    relativePath,
    projectId: encodeId(projectDirName),
    projectDirName,
    projectName,
    projectPath,
    sessionId: fileSessionId,
    fileSessionId,
    claudeSessionId: "",
    parentSessionId,
    childSessions: [],
    childSessionCount: 0,
    title: "",
    agentName: "",
    permissionMode: "",
    firstUserText: "",
    cwd: "",
    gitBranch: "",
    slug: "",
    isSubagent,
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

    updateSummary(summary, raw);

    if (options.includeEvents) {
      const event = normalizeEvent(raw, summary.id, lineNumber);
      if (event) events.push(event);
    }
  }

  if (!summary.title) {
    summary.title = summary.agentName || summary.firstUserText || summary.fileName;
  }

  return { summary, events };
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
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(fullPath);
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

function updateSummary(summary, raw) {
  summary.claudeSessionId ||= raw.sessionId || "";
  if (!summary.isSubagent) {
    summary.sessionId = raw.sessionId || summary.sessionId;
  }
  summary.cwd ||= raw.cwd || "";
  summary.gitBranch ||= raw.gitBranch || "";
  summary.slug ||= raw.slug || "";
  summary.agentId ||= raw.agentId || "";
  summary.promptId ||= raw.promptId || "";
  summary.isSidechain = summary.isSidechain || Boolean(raw.isSidechain);

  if (raw.timestamp) {
    summary.firstTimestamp = minIso(summary.firstTimestamp, raw.timestamp);
    summary.lastTimestamp = maxIso(summary.lastTimestamp, raw.timestamp);
  }

  if (raw.type === "custom-title" && raw.customTitle) {
    summary.title = raw.customTitle;
  }
  if (raw.type === "agent-name" && raw.agentName) {
    summary.agentName = raw.agentName;
  }
  if (raw.type === "permission-mode" && raw.permissionMode) {
    summary.permissionMode = raw.permissionMode;
  }

  if (raw.attachment) {
    summary.attachmentCount += 1;
  }

  const role = raw.message?.role || raw.type;
  const content = raw.message?.content;
  const segments = extractSegments(content);
  const isToolResultEvent = isOnlyToolResultSegments(role, segments);
  const isMetaArtifact = isMetaConversationArtifact(raw, role, segments);

  if (
    (role === "user" || role === "assistant") &&
    !isToolResultEvent &&
    !isMetaArtifact
  ) {
    summary.messageCount += 1;
    if (role === "user") summary.userMessageCount += 1;
    if (role === "assistant") summary.assistantMessageCount += 1;
  }

  for (const segment of segments) {
    if (segment.kind === "tool_call") summary.toolCallCount += 1;
    if (segment.kind === "tool_result") summary.toolResultCount += 1;
    if (
      !summary.firstUserText &&
      role === "user" &&
      segment.kind === "text" &&
      !isMetaArtifact
    ) {
      summary.firstUserText = compactText(segment.text, 140);
    }
  }
}

function normalizeEvent(raw, sessionHash, lineNumber) {
  if (raw.type === "custom-title") {
    return {
      id: `${sessionHash}:${lineNumber}`,
      kind: "metadata",
      label: "Custom title",
      value: raw.customTitle,
      sessionId: raw.sessionId,
      lineNumber,
    };
  }

  if (raw.type === "agent-name") {
    return {
      id: `${sessionHash}:${lineNumber}`,
      kind: "metadata",
      label: "Agent name",
      value: raw.agentName,
      sessionId: raw.sessionId,
      lineNumber,
    };
  }

  if (raw.type === "permission-mode") {
    return {
      id: `${sessionHash}:${lineNumber}`,
      kind: "metadata",
      label: "Permission mode",
      value: raw.permissionMode,
      sessionId: raw.sessionId,
      lineNumber,
    };
  }

  if (raw.attachment) {
    return {
      id: `${sessionHash}:${lineNumber}`,
      kind: "attachment",
      role: "system",
      title: raw.attachment.hookName || raw.attachment.type || "Attachment",
      timestamp: raw.timestamp || "",
      cwd: raw.cwd || "",
      lineNumber,
      attachment: raw.attachment,
      rawType: raw.type,
    };
  }

  const role = raw.message?.role || raw.type;
  const content = raw.message?.content;
  if (role === "user" || role === "assistant") {
    const segments = extractSegments(content);
    const isMetaArtifact = isMetaConversationArtifact(raw, role, segments);
    if (isOnlyToolResultSegments(role, segments)) {
      return {
        id: raw.uuid || `${sessionHash}:${lineNumber}`,
        uuid: raw.uuid || "",
        parentUuid: raw.parentUuid || "",
        role: "tool",
        sourceRole: role,
        kind: "tool_result",
        timestamp: raw.timestamp || "",
        cwd: raw.cwd || "",
        gitBranch: raw.gitBranch || "",
        isMeta: Boolean(raw.isMeta),
        isMetaArtifact,
        isSidechain: Boolean(raw.isSidechain),
        agentId: raw.agentId || "",
        segments,
        rawType: raw.type,
        lineNumber,
      };
    }

    return {
      id: raw.uuid || `${sessionHash}:${lineNumber}`,
      uuid: raw.uuid || "",
      parentUuid: raw.parentUuid || "",
      role,
      kind: "message",
      timestamp: raw.timestamp || "",
      cwd: raw.cwd || "",
      gitBranch: raw.gitBranch || "",
      model: raw.message?.model || "",
      stopReason: raw.message?.stop_reason || "",
      isMeta: Boolean(raw.isMeta),
      isMetaArtifact,
      isSidechain: Boolean(raw.isSidechain),
      agentId: raw.agentId || "",
      segments,
      rawType: raw.type,
      lineNumber,
    };
  }

  return {
    id: `${sessionHash}:${lineNumber}`,
    kind: "raw",
    rawType: raw.type || "unknown",
    timestamp: raw.timestamp || "",
    lineNumber,
    raw,
  };
}

function attachSubagentSessions(sessions) {
  const sessionsByProjectAndFileSession = new Map();
  const detachedSubagentGroups = new Map();
  const cloned = sessions.map((session) => ({ ...session, childSessions: [] }));

  for (const session of cloned) {
    if (!session.isSubagent) {
      sessionsByProjectAndFileSession.set(
        `${session.projectDirName}/${session.fileSessionId}`,
        session,
      );
    }
  }

  for (const session of cloned) {
    if (!session.isSubagent) continue;
    const parentKey = `${session.projectDirName}/${session.parentSessionId}`;
    let parent = sessionsByProjectAndFileSession.get(parentKey);
    if (!parent) {
      parent = detachedSubagentGroups.get(session.projectDirName);
      if (!parent) {
        parent = makeDetachedSubagentGroup(session);
        detachedSubagentGroups.set(session.projectDirName, parent);
      }
    }
    if (!parent.isVirtual) {
      session.parentSessionRowId = parent.id;
      session.parentSessionTitle = parent.title || parent.fileName || "";
    }
    parent.childSessions.push(session);
  }

  const withVirtualParents = [...cloned, ...detachedSubagentGroups.values()];

  for (const session of withVirtualParents) {
    if (session.isVirtual) {
      updateVirtualParentFromChildren(session);
    }
    session.childSessions.sort(sortByLastTimestamp);
    session.childSessionCount = session.childSessions.length;
  }

  return withVirtualParents;
}

function makeDetachedSubagentGroup(childSession) {
  return {
    id: encodeId(`virtual-detached:${childSession.projectDirName}`),
    filePath: "",
    fileName: "",
    relativePath: `${childSession.projectDirName}/detached-subagents`,
    projectId: childSession.projectId,
    projectDirName: childSession.projectDirName,
    projectName: childSession.projectName,
    projectPath: childSession.projectPath,
    sessionId: "detached-subagents",
    fileSessionId: "detached-subagents",
    claudeSessionId: "",
    parentSessionId: "",
    childSessions: [],
    childSessionCount: 0,
    title: "Detached subagents",
    agentName: "",
    permissionMode: "",
    firstUserText:
      "Parent session files were not found; orphan subagent sessions are grouped here.",
    cwd: childSession.cwd,
    gitBranch: childSession.gitBranch,
    slug: "",
    isSubagent: false,
    isVirtual: true,
    isDetachedSubagentGroup: true,
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
    mtimeMs: 0,
    size: 0,
  };
}

function updateVirtualParentFromChildren(parent) {
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
  if (parent.isDetachedSubagentGroup) {
    parent.title = `Detached subagents (${parent.childSessions.length})`;
  } else {
    parent.title = `${parent.title} (${parent.childSessions.length} subagents)`;
  }
}

function isOnlyToolResultSegments(role, segments) {
  return (
    role === "user" &&
    segments.length > 0 &&
    segments.every((segment) => segment.kind === "tool_result")
  );
}

function isMetaConversationArtifact(raw, role, segments) {
  if (raw.isMeta) return true;
  if (role !== "user") return false;

  const text = segments
    .filter((segment) => segment.kind === "text")
    .map((segment) => segment.text)
    .join("\n")
    .trim();

  return (
    text.startsWith("<local-command-") ||
    text.startsWith("<command-name>") ||
    text.includes("<command-message>") ||
    text.includes("<command-args>")
  );
}

export function extractSegments(content) {
  if (typeof content === "string") {
    return content ? [{ kind: "text", text: content }] : [];
  }

  if (!Array.isArray(content)) return [];

  return content.map((part, index) => {
    if (!part || typeof part !== "object") {
      return { kind: "text", text: String(part ?? ""), index };
    }

    if (part.type === "text") {
      return { kind: "text", text: part.text || "", index };
    }

    if (part.type === "thinking") {
      return { kind: "thinking", text: part.thinking || "", index };
    }

    if (part.type === "tool_use") {
      return {
        kind: "tool_call",
        id: part.id || "",
        name: part.name || "tool",
        input: part.input ?? null,
        index,
      };
    }

    if (part.type === "tool_result") {
      return {
        kind: "tool_result",
        toolUseId: part.tool_use_id || "",
        content: part.content ?? "",
        isError: Boolean(part.is_error),
        index,
      };
    }

    return { kind: "unknown", type: part.type || "unknown", value: part, index };
  });
}

export function compactText(value, maxLength = 180) {
  const text = stringifyContent(value).replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trimEnd()}...`;
}

export function stringifyContent(value) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") return item;
        if (item?.type === "text") return item.text || "";
        if (item?.type === "thinking") return item.thinking || "";
        if (item?.type === "tool_result") return stringifyContent(item.content);
        return JSON.stringify(item);
      })
      .join("\n");
  }
  return JSON.stringify(value, null, 2);
}

function sortByLastTimestamp(a, b) {
  return (b.lastTimestamp || "").localeCompare(a.lastTimestamp || "");
}

function minIso(current, candidate) {
  if (!candidate) return current || "";
  if (!current) return candidate;
  return candidate < current ? candidate : current;
}

function maxIso(current, candidate) {
  if (!candidate) return current || "";
  if (!current) return candidate;
  return candidate > current ? candidate : current;
}
