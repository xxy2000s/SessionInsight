import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  deletePushedSession,
  getPushedIndex,
  getPushedManifest,
  getPushedProjectSessions,
  getPushedSessionDetail,
  savePushedSession,
  searchPushedSessions,
} from "../server/sessionStore.mjs";

test("incremental session store updates are sharded, indexed, attached, and deleted", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "session-store-"));
  process.env.SESSION_DATA_DIR = root;
  process.env.SESSION_STORE_PATH = path.join(root, "legacy.json");

  const main = makeSession({
    id: "main",
    filePath: "/Users/test/.codex/sessions/main.jsonl",
    fileName: "main.jsonl",
    codexThreadId: "thread-main",
    title: "Main thread",
    messageCount: 2,
    toolCallCount: 1,
    lastTimestamp: "2026-07-29T01:00:00.000Z",
  });
  const child = makeSession({
    id: "child",
    filePath: "/Users/test/.codex/sessions/child.jsonl",
    fileName: "child.jsonl",
    codexThreadId: "thread-child",
    parentSessionId: "thread-main",
    title: "Child thread",
    isSubagent: true,
    isSidechain: true,
    messageCount: 1,
    lastTimestamp: "2026-07-29T01:05:00.000Z",
  });

  await savePushedSession("codex", { sourceHost: "mac", session: main });
  await savePushedSession("codex", { sourceHost: "mac", session: child });

  const index = await getPushedIndex("codex");
  assert.equal(index.projectCount, 1);
  assert.equal(index.sessionCount, 2);
  assert.equal(index.mainSessionCount, 1);
  assert.equal(index.subagentSessionCount, 1);
  assert.equal(index.projects[0].sessionCount, 1);
  assert.equal(index.projects[0].subagentSessionCount, 1);

  const sessions = await getPushedProjectSessions("codex", main.projectId);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, "main");
  assert.equal(sessions[0].childSessionCount, 1);
  assert.equal(sessions[0].childSessions[0].id, "child");
  assert.equal(sessions[0].childSessions[0].parentSessionRowId, "main");

  const detail = await getPushedSessionDetail("codex", "main");
  assert.equal(detail.events[0].segments[0].text, "hello");
  assert.equal(detail.childSessionCount, 1);
  assert.equal(detail.childSessions[0].title, "Child thread");

  const childSearchResults = await searchPushedSessions("codex", "thread-child");
  assert.equal(childSearchResults[0].id, "child");
  assert.equal(childSearchResults[0].childSessions.length, 0);

  const parentSearchResults = await searchPushedSessions("codex", "thread-main");
  assert.equal(parentSearchResults[0].id, "main");

  const manifest = await getPushedManifest("codex");
  assert.deepEqual(
    manifest.sessions.map((session) => session.fileName).sort(),
    ["child.jsonl", "main.jsonl"],
  );

  const indexShard = JSON.parse(
    await readFile(
      path.join(root, "machines", "server", "providers", "codex", "index.json"),
      "utf8",
    ),
  );
  assert.equal(indexShard.projectSessions[main.projectId][0].id, "main");

  await deletePushedSession("codex", { sessionId: "child" });
  const sessionsAfterDelete = await getPushedProjectSessions("codex", main.projectId);
  assert.equal(sessionsAfterDelete[0].childSessionCount, 0);
  const manifestAfterDelete = await getPushedManifest("codex");
  assert.deepEqual(
    manifestAfterDelete.sessions.map((session) => session.fileName),
    ["main.jsonl"],
  );
});

test("session store isolates identical session ids by machine", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "session-store-machines-"));
  process.env.SESSION_DATA_DIR = root;
  process.env.SESSION_STORE_PATH = path.join(root, "legacy.json");

  await savePushedSession(
    "codex",
    {
      sourceHost: "server",
      machineId: "server",
      machineLabel: "Server",
      session: makeSession({
        id: "same",
        filePath: "/server/same.jsonl",
        fileName: "same.jsonl",
        codexThreadId: "thread-server",
        title: "Server session",
        messageCount: 2,
        lastTimestamp: "2026-07-29T01:00:00.000Z",
      }),
    },
    "server",
  );

  await savePushedSession(
    "codex",
    {
      sourceHost: "mac",
      machineId: "macbook",
      machineLabel: "MacBook",
      session: makeSession({
        id: "same",
        filePath: "/mac/same.jsonl",
        fileName: "same.jsonl",
        codexThreadId: "thread-mac",
        title: "Mac session",
        messageCount: 3,
        lastTimestamp: "2026-07-29T02:00:00.000Z",
      }),
    },
    "macbook",
  );

  const serverDetail = await getPushedSessionDetail("codex", "same", "server");
  const macDetail = await getPushedSessionDetail("codex", "same", "macbook");
  assert.equal(serverDetail.title, "Server session");
  assert.equal(macDetail.title, "Mac session");

  const machinesIndex = JSON.parse(
    await readFile(
      path.join(root, "machines", "macbook", "providers", "codex", "index.json"),
      "utf8",
    ),
  );
  assert.equal(machinesIndex.machineId, "macbook");
});

function makeSession(overrides) {
  return {
    id: overrides.id,
    provider: "codex",
    filePath: overrides.filePath,
    fileName: overrides.fileName,
    relativePath: overrides.fileName,
    projectId: "project",
    projectDirName: "/Users/test/project",
    projectName: "project",
    projectPath: "/Users/test/project",
    sessionId: overrides.codexThreadId,
    fileSessionId: overrides.codexThreadId,
    codexThreadId: overrides.codexThreadId,
    parentSessionId: overrides.parentSessionId || "",
    childSessions: [],
    childSessionCount: 0,
    title: overrides.title,
    agentName: "",
    permissionMode: "",
    firstUserText: "hello",
    cwd: "/Users/test/project",
    gitBranch: "main",
    slug: "",
    isSubagent: Boolean(overrides.isSubagent),
    isSidechain: Boolean(overrides.isSidechain),
    agentId: "",
    promptId: "",
    messageCount: overrides.messageCount,
    userMessageCount: 1,
    assistantMessageCount: Math.max(0, overrides.messageCount - 1),
    toolCallCount: overrides.toolCallCount || 0,
    toolResultCount: 0,
    attachmentCount: 0,
    parseErrorCount: 0,
    firstTimestamp: "2026-07-29T00:59:00.000Z",
    lastTimestamp: overrides.lastTimestamp,
    mtimeMs: overrides.id === "main" ? 100 : 200,
    size: overrides.id === "main" ? 1000 : 2000,
    events: [
      {
        id: `${overrides.id}:1`,
        role: "user",
        kind: "message",
        timestamp: "2026-07-29T00:59:00.000Z",
        segments: [{ kind: "text", text: "hello", index: 0 }],
      },
    ],
  };
}
