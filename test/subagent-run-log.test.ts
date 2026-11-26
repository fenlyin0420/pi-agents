/**
 * The live run log of a delegation.
 *
 * pi's tool supervisor suspends a call past its deadline into a background job:
 * the rendered row is finalised and the call is afterwards read through text
 * (job output, the settle notice). A child that sits inside one long tool call
 * emits nothing for minutes, so the text alone cannot say whether it is alive.
 * The run log is the readable timeline: one line per child event, written while
 * the run happens, in a durable location that outlives the run.
 *
 * Peer-dependency handling mirrors the other suites (skip when absent).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";

import type { AgentDefinition } from "../src/types.ts";

type ExecutorModule = typeof import("../src/subagent/executor.ts");
type AgentProgress = import("../src/subagent/executor.ts").AgentProgress;

let executor: ExecutorModule | undefined;
let toolMod: typeof import("../src/subagent/tool.ts") | undefined;
try {
  executor = await import("../src/subagent/executor.ts");
  toolMod = await import("../src/subagent/tool.ts");
} catch {
  executor = undefined;
  toolMod = undefined;
}

const run = executor && toolMod ? test : test.skip;

// ─── Fixtures ────────────────────────────────────────────────────────────────

const emptyUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0 };

const baseAgent: AgentDefinition = {
  name: "worker",
  mode: "subagent",
  hidden: true,
  disable: false,
  thinking: "off",
  systemPrompt: "replace",
  maxDepth: 1,
  prompt: "You are a worker subagent.",
  source: "project",
  filePath: "/tmp/worker.agent.md",
};

/** One child event stream: a tool call, its result, then the answer. */
const stream = [
  { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "npm test" } },
  { type: "tool_execution_end", toolCallId: "t1" },
  { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "halfway there" }] } },
  { type: "agent_end", messages: [] },
];

/** Drive a run, capturing what the executor appends to the run log. */
async function driveRun(options: { appendFileFails?: boolean } = {}) {
  const chunks: string[] = [];
  const paths: string[] = [];
  const seen: AgentProgress[] = [];
  const result = await executor!.runSubagent({
    agent: baseAgent,
    task: "run the suite",
    cwd: "/tmp/project",
    // Fixed clock: the run-log name carries the start time.
    now: () => 0,
    platform: "linux",
    outputArchiveDir: "/tmp/fake-archive",
    fs: {
      makeTempDir: async () => "/tmp/fake-subagent",
      writeFile: async () => {},
      removeDir: async () => {},
      appendFile: async (filePath, chunk) => {
        if (options.appendFileFails) throw new Error("disk full");
        paths.push(filePath);
        chunks.push(chunk);
      },
    },
    resolvePi: async () => ({ command: "node", entryPoint: "/fake/cli.js" }),
    runner: async (_invocation, handlers) => {
      handlers.pid?.(4242);
      for (const event of stream) handlers.stdout(JSON.stringify(event) + "\n");
      handlers.stderr("warning: something\n");
      return { exitCode: 0 };
    },
    onProgress: (progress) => seen.push(progress),
  });
  return { chunks, paths, seen, result };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

run("the run log records the child's timeline line by line", async () => {
  const { chunks } = await driveRun();
  const log = chunks.join("");
  assert.match(log, /^\[\+0\.0s\] run worker model=inherit cwd=\/tmp\/project task=run the suite$/m);
  assert.match(log, /^\[\+0\.0s\] tool bash start \$ npm test$/m);
  assert.match(log, /^\[\+0\.0s\] tool bash done$/m);
  assert.match(log, /^\[\+0\.0s\] assistant: halfway there$/m);
  assert.match(log, /^\[\+0\.0s\] stderr: warning: something$/m);
  assert.match(log, /^\[\+0\.0s\] agent end$/m);
  assert.match(log, /^\[\+0\.0s\] exit code=0$/m);
});

run("the run log has one fixed path beside the output archive, not in the temp dir", async () => {
  const { paths } = await driveRun();
  assert.deepEqual(
    [...new Set(paths)],
    [path.join("/tmp/fake-archive", "worker-0-run.log")],
    "every line goes to one durable file that the temp-dir cleanup cannot remove",
  );
});

run("progress advertises the run log only once it exists", async () => {
  const { seen } = await driveRun();
  assert.ok(seen.length > 0, "expected progress emits");
  for (const progress of seen) {
    assert.equal(progress.runLogPath, path.join("/tmp/fake-archive", "worker-0-run.log"));
  }
});

run("live progress text names the run log under the status line", async () => {
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
      busy: true,
      runLogPath: "/tmp/archive/worker-0-run.log",
      usage: { ...emptyUsage },
      startedAt: 0,
      elapsedMs: 83_000,
    });
    return {
      agent: "worker",
      status: "done",
      output: "## Outcome\ndone",
      tools: [],
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

  const lines = updates[0]!.split("\n");
  assert.equal(lines[0], "subagent worker · 1 tool · 83s · ▸ $ npm test");
  assert.equal(lines[1], "run log: /tmp/archive/worker-0-run.log", "the path a suspended call is read from");
  assert.ok(updates[0]!.includes("halfway there"));
});

run("a failing log write never breaks the delegation", async () => {
  const { result } = await driveRun({ appendFileFails: true });
  assert.equal(result.isError, false, "logging is diagnostics, not part of the result");
  assert.equal(result.output, "halfway there");
});
