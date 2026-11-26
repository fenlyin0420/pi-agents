/**
 * Visibility of a delegated run to a host that supervises long calls.
 *
 * pi suspends a tool call past its deadline into a background job: the row the
 * TUI drew is finalised, and from then on the call is read through text —
 * `job {action:"output"}` and the background settle notice carry the tool's
 * streaming content. Two things must therefore hold for a suspended subagent:
 *
 * 1. The progress carries the child's pid, so the supervisor probes its process
 *    tree for CPU movement instead of judging a thinking child as stalled
 *    (whose evidence would invite the model to kill a live run).
 * 2. The streaming content names what is running — agent, tool count, elapsed,
 *    current tool — because the rendered row is gone.
 *
 * Peer-dependency handling mirrors the other suites (skip when absent).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { AgentDefinition } from "../src/types.ts";

type ExecutorModule = typeof import("../src/subagent/executor.ts");
type ToolModule = typeof import("../src/subagent/tool.ts");
type RenderModule = typeof import("../src/subagent/render.ts");
type AgentProgress = import("../src/subagent/executor.ts").AgentProgress;

let executor: ExecutorModule | undefined;
let toolMod: ToolModule | undefined;
let renderMod: RenderModule | undefined;
try {
  executor = await import("../src/subagent/executor.ts");
  renderMod = await import("../src/subagent/render.ts");
  toolMod = await import("../src/subagent/tool.ts");
} catch {
  executor = undefined;
  toolMod = undefined;
  renderMod = undefined;
}

const run = executor && toolMod && renderMod ? test : test.skip;

// ─── Fixtures ────────────────────────────────────────────────────────────────

const emptyUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0 };

const baseAgent: AgentDefinition = {
  name: "worker",
  mode: "subagent",
  hidden: true,
  disable: false,
  thinking: "off",
  systemPrompt: "replace",
  authority: "standalone",
  maxDepth: 1,
  prompt: "You are a worker subagent.",
  source: "project",
  filePath: "/tmp/worker.agent.md",
};

const fakeFs = {
  makeTempDir: async () => "/tmp/fake-subagent",
  writeFile: async () => {},
  removeDir: async () => {},
};

/** Replay one child stream, reporting `pid` to the executor when given. */
async function driveRun(pid: number | undefined, platform: NodeJS.Platform = "linux") {
  const seen: AgentProgress[] = [];
  const result = await executor!.runSubagent({
    agent: baseAgent,
    task: "run the suite",
    cwd: process.cwd(),
    fs: fakeFs,
    platform,
    resolvePi: async () => ({ command: "node", entryPoint: "/fake/cli.js" }),
    runner: async (_invocation, handlers) => {
      if (pid !== undefined) handlers.pid?.(pid);
      for (const event of [
        { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "npm test" } },
        { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "halfway there" }] } },
      ]) {
        handlers.stdout(JSON.stringify(event) + "\n");
      }
      return { exitCode: 0 };
    },
    onProgress: (progress) => seen.push(progress),
  });
  return { seen, result };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

run("progress carries the child pid for the supervisor to probe", async () => {
  const { seen } = await driveRun(4242, "linux");
  assert.ok(seen.length > 0, "expected progress emits");
  for (const progress of seen) {
    assert.equal(progress.pid, 4242, "every emit names the child process");
  }
});

run("no pid is invented when the runner cannot report one", async () => {
  const { seen, result } = await driveRun(undefined, "linux");
  assert.ok(seen.length > 0);
  for (const progress of seen) {
    assert.equal("pid" in progress, false, "an unknown pid stays absent, not 0");
  }
  assert.equal("pid" in result, false);
});

run("pid is withheld where the supervisor cannot read CPU movement", async () => {
  // Windows has no process-tree sampling: the supervisor would see 0ms of CPU
  // for a child that is merely waiting on the model, count it as stalled, and
  // stop a healthy run after three checks. Withholding the pid keeps the host
  // on its safe path (no facts → no no-progress strikes).
  const { seen } = await driveRun(4242, "win32");
  assert.ok(seen.length > 0);
  for (const progress of seen) {
    assert.equal("pid" in progress, false);
  }
});

run("progress marks a child that is inside a tool call as busy", async () => {
  const seen: AgentProgress[] = [];
  await executor!.runSubagent({
    agent: baseAgent,
    task: "run the suite",
    cwd: process.cwd(),
    fs: fakeFs,
    platform: "linux",
    resolvePi: async () => ({ command: "node", entryPoint: "/fake/cli.js" }),
    runner: async (_invocation, handlers) => {
      for (const event of [
        { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "npm test" } },
        { type: "tool_execution_end", toolCallId: "t1" },
      ]) {
        handlers.stdout(JSON.stringify(event) + "\n");
      }
      return { exitCode: 0 };
    },
    onProgress: (progress) => seen.push(progress),
  });

  const busyFlags = seen.map((progress) => progress.busy);
  assert.equal(busyFlags[0], true, "the emit during the tool call marks the child busy");
  assert.ok(
    busyFlags.slice(1).every((busy) => busy === undefined),
    "no later emit claims a busy child once the tool returned",
  );
});

run("the streaming content names what is running (job output / settle notice)", async () => {
  const { registerSubagentTool } = toolMod!;
  const updates: string[] = [];
  let capturedExecute: ((params: unknown, ctx: unknown) => Promise<unknown>) | undefined;
  const fakePi = {
    registerTool: (def: {
      execute: (
        id: string,
        p: unknown,
        s: unknown,
        u: (r: { content: Array<{ text: string }> }) => void,
        c: unknown,
      ) => Promise<unknown>;
    }) => {
      capturedExecute = (p, c) =>
        def.execute("id", p, undefined, (r) => updates.push(r.content[0]!.text), c);
    },
  };
  const fakeRun = async (opts: { onProgress?: (p: unknown) => void }) => {
    opts.onProgress?.({
      agent: "worker",
      status: "running",
      output: "halfway there",
      tools: [{ id: "t1", name: "bash", args: { command: "npm test" }, status: "running" }],
      pid: 4242,
      usage: { ...emptyUsage },
      startedAt: 0,
      elapsedMs: 83_000,
    });
    return {
      agent: "worker",
      status: "done",
      output: "## Outcome\ndone",
      tools: [],
      pid: 4242,
      usage: { ...emptyUsage },
      startedAt: 0,
      elapsedMs: 90_000,
      isError: false,
      exitCode: 0,
      stderr: "",
    };
  };
  registerSubagentTool(fakePi as never, { agents: [baseAgent], run: fakeRun } as never);
  await capturedExecute!({ agent: "worker", task: "run the suite" }, { cwd: process.cwd() });

  assert.equal(updates.length, 1, "one live update");
  const [status, ...rest] = updates[0]!.split("\n");
  assert.equal(
    status,
    "subagent worker · 1 tool · 83s · ▸ $ npm test",
    "status line names agent, tools, elapsed and the tool in flight",
  );
  assert.ok(rest.join("\n").includes("halfway there"), "the child's text follows the status line");
});

run("a finished status line drops the tool arrow", () => {
  const line = renderMod!.formatLiveStatus({
    agent: "worker",
    status: "done",
    output: "",
    tools: [{ id: "t1", name: "read", args: { path: "/tmp/a.ts" }, status: "done" }],
    usage: { ...emptyUsage },
    startedAt: 0,
    elapsedMs: 12_000,
  });
  assert.equal(line, "subagent worker · 1 tool · 12s · done");
});

run("a run between tools reads as thinking", () => {
  const line = renderMod!.formatLiveStatus({
    agent: "worker",
    status: "running",
    output: "",
    tools: [{ id: "t1", name: "read", args: { path: "/tmp/a.ts" }, status: "done" }],
    usage: { ...emptyUsage },
    startedAt: 0,
    elapsedMs: 5_000,
  });
  assert.equal(line, "subagent worker · 1 tool · 5s · thinking");
});
