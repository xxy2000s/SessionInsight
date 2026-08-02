import assert from "node:assert/strict";
import { mkdir, mkdtemp, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  rebuildLocalProviderIndex,
  syncLocalProviderPath,
} from "../server/localIndex.mjs";
import {
  getPushedIndex,
  getPushedProjectSessions,
  getPushedSessionDetail,
  searchPushedSessions,
} from "../server/sessionStore.mjs";

test("local index builds sharded store from local Claude files and handles deletes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "local-index-"));
  const claudeHome = path.join(root, "claude");
  const store = path.join(root, "store");
  const projectDir = path.join(claudeHome, "projects", "-Users-test-localindex");
  await mkdir(projectDir, { recursive: true });

  process.env.CLAUDE_HOME = claudeHome;
  process.env.SESSION_DATA_DIR = store;
  process.env.SESSION_STORE_PATH = path.join(root, "legacy.json");

  const sessionFile = path.join(projectDir, "local-session.jsonl");
  await writeFile(
    sessionFile,
    [
      JSON.stringify({
        type: "custom-title",
        customTitle: "Local indexed session",
        sessionId: "local-session",
      }),
      JSON.stringify({
        type: "user",
        uuid: "u1",
        timestamp: "2026-07-30T01:00:00.000Z",
        sessionId: "local-session",
        cwd: "/Users/test/localindex",
        gitBranch: "main",
        message: {
          role: "user",
          content: "Index this local session",
        },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "a1",
        parentUuid: "u1",
        timestamp: "2026-07-30T01:00:02.000Z",
        sessionId: "local-session",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Indexed." }],
        },
      }),
    ].join("\n"),
  );

  const rebuild = await rebuildLocalProviderIndex("claude");
  assert.equal(rebuild.fileCount, 1);
  assert.equal(rebuild.upserted, 1);

  const index = await getPushedIndex("claude");
  assert.equal(index.provider, "claude");
  assert.equal(index.projectCount, 1);
  assert.equal(index.sessionCount, 1);
  assert.equal(index.projects[0].name, "localindex");

  const sessions = await getPushedProjectSessions("claude", index.projects[0].id);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].title, "Local indexed session");

  const detail = await getPushedSessionDetail("claude", sessions[0].id);
  assert.equal(detail.events.length, 3);
  assert.equal(detail.events[1].role, "user");
  assert.equal(detail.events[2].role, "assistant");

  const searchResults = await searchPushedSessions("claude", "local-session");
  assert.equal(searchResults[0].id, sessions[0].id);

  await unlink(sessionFile);
  const deleted = await syncLocalProviderPath("claude", sessionFile, "unlink");
  assert.equal(deleted.deleted, true);

  const indexAfterDelete = await getPushedIndex("claude");
  assert.equal(indexAfterDelete.sessionCount, 0);
  assert.equal(indexAfterDelete.projectCount, 0);
});
