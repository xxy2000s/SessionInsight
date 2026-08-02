import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  decodeProjectPath,
  extractSegments,
  getProjectSessions,
  getSessionDetail,
  scanClaudeSessions,
} from "../server/claudeSessions.mjs";
import {
  getDoujieProjectSessions,
  getDoujieSessionDetail,
  getCodexProjectSessions,
  getCodexSessionDetail,
  scanCodexSessions,
  scanDoujieSessions,
} from "../server/codexSessions.mjs";

test("decodes Claude project directory names into paths", () => {
  assert.equal(
    decodeProjectPath("-workspace-agent-demo"),
    "/workspace/agent/demo",
  );
});

test("extracts text, thinking, tool calls, and tool results", () => {
  const segments = extractSegments([
    { type: "text", text: "hello" },
    { type: "thinking", thinking: "private notes" },
    { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } },
    {
      type: "tool_result",
      tool_use_id: "toolu_1",
      content: "done",
      is_error: false,
    },
  ]);

  assert.deepEqual(
    segments.map((segment) => segment.kind),
    ["text", "thinking", "tool_call", "tool_result"],
  );
  assert.equal(segments[2].name, "Bash");
  assert.equal(segments[3].toolUseId, "toolu_1");
});

test("scans projects and returns detailed parsed session events", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "claude-sessions-"));
  const projects = path.join(root, "projects");
  const projectDir = path.join(projects, "-Users-test-demo");
  const subagents = path.join(projectDir, "abc-session", "subagents");
  const orphanSubagents = path.join(projectDir, "missing-session", "subagents");
  const secondOrphanSubagents = path.join(
    projectDir,
    "another-missing-session",
    "subagents",
  );
  await mkdir(subagents, { recursive: true });
  await mkdir(orphanSubagents, { recursive: true });
  await mkdir(secondOrphanSubagents, { recursive: true });

  const mainFile = path.join(projectDir, "abc-session.jsonl");
  await writeFile(
    mainFile,
    [
      JSON.stringify({
        type: "custom-title",
        customTitle: "Build parser",
        sessionId: "abc-session",
      }),
      JSON.stringify({
        parentUuid: null,
        isSidechain: false,
        type: "user",
        message: { role: "user", content: "Please inspect the repo" },
        uuid: "u1",
        timestamp: "2026-07-28T01:00:00.000Z",
        cwd: "/Users/test/demo",
        sessionId: "abc-session",
        gitBranch: "main",
      }),
      JSON.stringify({
        parentUuid: "u1",
        isSidechain: false,
        type: "user",
        message: {
          role: "user",
          content:
            "<local-command-caveat>Caveat: local command generated text.</local-command-caveat>",
        },
        isMeta: true,
        uuid: "meta1",
        timestamp: "2026-07-28T01:00:10.000Z",
        sessionId: "abc-session",
      }),
      JSON.stringify({
        parentUuid: "meta1",
        isSidechain: false,
        type: "user",
        message: {
          role: "user",
          content:
            "<command-name>/exit</command-name>\n<command-message>exit</command-message>",
        },
        uuid: "meta2",
        timestamp: "2026-07-28T01:00:20.000Z",
        sessionId: "abc-session",
      }),
      JSON.stringify({
        parentUuid: "u1",
        isSidechain: false,
        type: "assistant",
        message: {
          role: "assistant",
          model: "claude",
          content: [
            { type: "text", text: "I will inspect it." },
            {
              type: "tool_use",
              id: "toolu_1",
              name: "Bash",
              input: { command: "ls" },
            },
          ],
        },
        uuid: "a1",
        timestamp: "2026-07-28T01:01:00.000Z",
        cwd: "/Users/test/demo",
        sessionId: "abc-session",
      }),
      JSON.stringify({
        parentUuid: "a1",
        isSidechain: false,
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: "package.json",
              is_error: false,
            },
          ],
        },
        uuid: "u2",
        timestamp: "2026-07-28T01:02:00.000Z",
        cwd: "/Users/test/demo",
        sessionId: "abc-session",
      }),
    ].join("\n"),
  );

  await writeFile(
    path.join(subagents, "agent-one.jsonl"),
    `${JSON.stringify({
      isSidechain: true,
      agentId: "one",
      type: "user",
      message: { role: "user", content: "Subtask" },
      timestamp: "2026-07-28T01:03:00.000Z",
      sessionId: "abc-session",
    })}\n`,
  );

  await writeFile(
    path.join(orphanSubagents, "agent-two.jsonl"),
    `${JSON.stringify({
      isSidechain: true,
      agentId: "two",
      type: "user",
      message: { role: "user", content: "Orphan subtask" },
      timestamp: "2026-07-28T01:04:00.000Z",
      sessionId: "missing-session",
    })}\n`,
  );

  await writeFile(
    path.join(secondOrphanSubagents, "agent-three.jsonl"),
    `${JSON.stringify({
      isSidechain: true,
      agentId: "three",
      type: "user",
      message: { role: "user", content: "Another orphan subtask" },
      timestamp: "2026-07-28T01:05:00.000Z",
      sessionId: "another-missing-session",
    })}\n`,
  );

  const index = await scanClaudeSessions({ claudeHome: root, noCache: true });
  assert.equal(index.projectCount, 1);
  assert.equal(index.sessionCount, 4);
  assert.equal(index.mainSessionCount, 1);
  assert.equal(index.subagentSessionCount, 3);
  assert.equal(index.projects[0].name, "demo");
  assert.equal(index.projects[0].sessionCount, 1);
  assert.equal(index.projects[0].subagentSessionCount, 3);
  assert.equal(index.projects[0].totalSessionCount, 4);
  assert.equal(index.projects[0].toolCallCount, 1);

  const sessions = await getProjectSessions(index.projects[0].id, {
    claudeHome: root,
    noCache: true,
  });
  assert.equal(sessions.length, 2);
  const main = sessions.find((session) => session.fileName === "abc-session.jsonl");
  const orphanGroup = sessions.find((session) => session.isVirtual);
  assert.equal(orphanGroup.title, "Detached subagents (2)");
  assert.equal(orphanGroup.childSessionCount, 2);
  assert.deepEqual(
    orphanGroup.childSessions.map((session) => session.fileName).sort(),
    ["agent-three.jsonl", "agent-two.jsonl"],
  );
  assert.deepEqual(
    orphanGroup.childSessions.map((session) => session.parentSessionId).sort(),
    ["another-missing-session", "missing-session"],
  );
  assert.equal(main.title, "Build parser");
  assert.equal(main.messageCount, 2);
  assert.equal(main.userMessageCount, 1);
  assert.equal(main.assistantMessageCount, 1);
  assert.equal(main.toolResultCount, 1);
  assert.equal(main.childSessionCount, 1);
  assert.equal(main.childSessions[0].fileName, "agent-one.jsonl");
  assert.equal(main.childSessions[0].parentSessionId, "abc-session");
  assert.equal(main.childSessions[0].parentSessionRowId, main.id);
  assert.equal(main.cwd, "/Users/test/demo");

  const detail = await getSessionDetail(main.id, {
    claudeHome: root,
    noCache: true,
  });
  assert.equal(detail.events.length, 6);
  assert.equal(detail.events[2].isMetaArtifact, true);
  assert.equal(detail.events[3].isMetaArtifact, true);
  assert.equal(detail.events[4].segments[1].kind, "tool_call");
  assert.equal(detail.events[5].kind, "tool_result");
  assert.equal(detail.events[5].role, "tool");
  assert.equal(detail.events[5].sourceRole, "user");
  assert.equal(detail.events[5].segments[0].kind, "tool_result");
  assert.equal(detail.childSessionCount, 1);
});

test("scans Codex sessions by cwd and attaches subagents to parent threads", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "codex-sessions-"));
  const sessionsDir = path.join(root, "sessions", "2026", "07", "28");
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(
    path.join(root, "session_index.jsonl"),
    `${JSON.stringify({
      id: "019fa8ea-e087-7cc3-88b5-37424988e7ae",
      thread_name: "session-browser",
      updated_at: "2026-07-28T13:40:00.000Z",
    })}\n`,
  );

  const mainFile = path.join(
    sessionsDir,
    "rollout-2026-07-28T21-29-53-019fa8ea-e087-7cc3-88b5-37424988e7ae.jsonl",
  );
  await writeFile(
    mainFile,
    [
      JSON.stringify({
        timestamp: "2026-07-28T13:29:53.034Z",
        type: "session_meta",
        payload: {
          id: "019fa8ea-e087-7cc3-88b5-37424988e7ae",
          session_id: "019fa8ea-e087-7cc3-88b5-37424988e7ae",
          timestamp: "2026-07-28T13:29:53.034Z",
          cwd: "/workspace/session-insight",
          thread_source: "user",
          model_provider: "openai",
          base_instructions: { text: "large system prompt" },
        },
      }),
      JSON.stringify({
        timestamp: "2026-07-28T13:30:00.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "Build a session browser" },
      }),
      JSON.stringify({
        timestamp: "2026-07-28T13:30:01.000Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "<environment_context><cwd>/workspace/session-insight</cwd></environment_context>",
        },
      }),
      JSON.stringify({
        timestamp: "2026-07-28T13:30:05.000Z",
        type: "event_msg",
        payload: {
          type: "agent_message",
          phase: "commentary",
          message: "I will inspect the files.",
        },
      }),
      JSON.stringify({
        timestamp: "2026-07-28T13:30:06.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          id: "fc_1",
          name: "exec_command",
          arguments: "{\"cmd\":\"ls\"}",
          call_id: "call_1",
        },
      }),
      JSON.stringify({
        timestamp: "2026-07-28T13:30:07.000Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call_1",
          output: "package.json",
        },
      }),
    ].join("\n"),
  );

  const subagentFile = path.join(
    sessionsDir,
    "rollout-2026-07-28T22-51-37-019fa935-b754-7b53-af71-8726e93494d5.jsonl",
  );
  await writeFile(
    subagentFile,
    [
      JSON.stringify({
        timestamp: "2026-07-28T14:51:37.833Z",
        type: "session_meta",
        payload: {
          id: "019fa935-b754-7b53-af71-8726e93494d5",
          session_id: "019fa8ea-e087-7cc3-88b5-37424988e7ae",
          parent_thread_id: "019fa8ea-e087-7cc3-88b5-37424988e7ae",
          cwd: "/workspace/session-insight",
          thread_source: "subagent",
          agent_nickname: "Dirac",
        },
      }),
      JSON.stringify({
        timestamp: "2026-07-28T14:51:38.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "Review the markdown change" },
      }),
    ].join("\n"),
  );

  const index = await scanCodexSessions({ codexHome: root, noCache: true });
  assert.equal(index.projectCount, 1);
  assert.equal(index.mainSessionCount, 1);
  assert.equal(index.subagentSessionCount, 1);
  assert.equal(index.projects[0].name, "session-insight");
  assert.equal(index.projects[0].sessionCount, 1);
  assert.equal(index.projects[0].subagentSessionCount, 1);

  const sessions = await getCodexProjectSessions(index.projects[0].id, {
    codexHome: root,
    noCache: true,
  });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].title, "session-browser");
  assert.equal(sessions[0].childSessionCount, 1);
  assert.equal(sessions[0].childSessions[0].agentName, "Dirac");
  assert.equal(sessions[0].childSessions[0].parentSessionRowId, sessions[0].id);

  const detail = await getCodexSessionDetail(sessions[0].id, {
    codexHome: root,
    noCache: true,
  });
  assert.equal(detail.events[0].kind, "metadata");
  assert.equal(detail.events[0].raw.base_instructions, undefined);
  assert.equal(detail.events[1].role, "user");
  assert.equal(detail.events[2].isMetaArtifact, true);
  assert.equal(detail.events[3].role, "assistant");
  assert.equal(detail.events[4].segments[0].kind, "tool_call");
  assert.deepEqual(detail.events[4].segments[0].input, { cmd: "ls" });
  assert.equal(detail.events[5].kind, "tool_result");
  assert.equal(detail.events[5].segments[0].content, "package.json");
});

test("scans Doujie links sessions with Codex parser", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "doujie-sessions-"));
  const codexRoot = await mkdtemp(path.join(tmpdir(), "doujie-codex-target-"));
  const sessionsDir = path.join(root, "sessions", "links", "2026", "07", "29");
  const targetDir = path.join(codexRoot, "sessions", "2026", "07", "29");
  await mkdir(sessionsDir, { recursive: true });
  await mkdir(targetDir, { recursive: true });

  const targetFile = path.join(
    targetDir,
    "rollout-2026-07-29T08-00-00-019fb000-0000-7000-8000-000000000001.jsonl",
  );
  const sessionFile = path.join(sessionsDir, "oc_test_session.jsonl");
  await writeFile(
    targetFile,
    [
      JSON.stringify({
        timestamp: "2026-07-29T08:00:00.000Z",
        type: "session_meta",
        payload: {
          id: "019fb000-0000-7000-8000-000000000001",
          cwd: "/Users/test/links",
          thread_source: "user",
        },
      }),
      JSON.stringify({
        timestamp: "2026-07-29T08:01:00.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "Parse Doujie links" },
      }),
      JSON.stringify({
        timestamp: "2026-07-29T08:01:01.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          id: "fc_doujie",
          name: "exec_command",
          arguments: "{\"cmd\":\"pwd\"}",
          call_id: "call_doujie",
        },
      }),
    ].join("\n"),
  );
  await symlink(targetFile, sessionFile);

  const index = await scanDoujieSessions({ doujieHome: root, noCache: true });
  assert.equal(index.provider, "doujie");
  assert.equal(index.projectsRoot, path.join(root, "sessions", "links"));
  assert.equal(index.projectCount, 1);
  assert.equal(index.projects[0].name, "links");

  const sessions = await getDoujieProjectSessions(index.projects[0].id, {
    doujieHome: root,
    noCache: true,
  });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].provider, "doujie");
  assert.ok(sessions[0].id);

  const detail = await getDoujieSessionDetail(sessions[0].id, {
    doujieHome: root,
    noCache: true,
  });
  assert.equal(detail.provider, "doujie");
  assert.equal(detail.events[1].role, "user");
  assert.equal(detail.events[2].segments[0].kind, "tool_call");
});
