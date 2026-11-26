/**
 * Tests for the discovery family filter (`agentSources` setting).
 *
 * `families: ["pi"]` must keep only pi-owned paths, so OpenCode and shared
 * `.agents/` definitions are never read.
 *
 * Paths are built with `path.join` so the suite is Windows-safe.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";

import * as os from "node:os";

import { getDiscoveryPaths } from "../src/config/paths.ts";
import { loadAgents } from "../src/discovery/loader.ts";
import type { AgentFs } from "../src/types.ts";

const HOME = path.join(path.sep, "home", "user");
const AGENT_DIR = path.join(HOME, ".pi", "agent");
const PROJECT = path.join(path.sep, "project");

/** Build a platform-correct path from "/"-separated mock keys. */
const p = (...parts: string[]) => path.join(...parts);

function makeMockFs(files: Record<string, string>): AgentFs {
  const keys = Object.keys(files).map((k) => path.normalize(k));
  const normalized: Record<string, string> = {};
  Object.keys(files).forEach((k) => {
    normalized[path.normalize(k)] = files[k];
  });

  return {
    async listFiles(dir: string): Promise<string[]> {
      return keys
        .filter((k) => k.endsWith(".md") && (path.dirname(k) === dir || k.startsWith(dir + path.sep)))
        .sort();
    },
    async readFile(filePath: string): Promise<string> {
      return normalized[path.normalize(filePath)] ?? "";
    },
    async exists(dir: string): Promise<boolean> {
      return keys.some((k) => k === dir || k.startsWith(dir + path.sep));
    },
  };
}

test("discovery families: no filter scans every family", () => {
  const families = getDiscoveryPaths(PROJECT, AGENT_DIR).map((p) => p.family);
  assert.deepEqual(families, ["pi", "opencode", "opencode", "pi", "opencode", "shared"]);
});

test("discovery families: ['pi'] keeps only pi paths", () => {
  const paths = getDiscoveryPaths(PROJECT, AGENT_DIR, { families: ["pi"] });
  assert.deepEqual(
    paths.map((entry) => entry.dir),
    [p(AGENT_DIR, "agents"), p(PROJECT, ".pi", "agents")],
  );
  assert.ok(paths.every((entry) => entry.family === "pi"));
  assert.deepEqual(
    paths.map((entry) => entry.source),
    ["global", "project"],
  );
});

test("discovery families: empty list falls back to every family", () => {
  assert.equal(getDiscoveryPaths(PROJECT, AGENT_DIR, { families: [] }).length, 6);
});

test("discovery families: duplicates are harmless", () => {
  assert.equal(getDiscoveryPaths(PROJECT, AGENT_DIR, { families: ["pi", "pi"] }).length, 2);
});

test("discovery families: ['pi'] skips opencode and shared definition files", async () => {
  const fs = makeMockFs({
    [p(AGENT_DIR, "agents", "leader.agent.md")]: `---
name: leader
description: pi global agent
mode: primary
---
Body`,
    [p(PROJECT, ".pi", "agents", "helper.md")]: `---
name: helper
description: pi project agent
mode: subagent
---
Body`,
    [p(os.homedir(), ".config", "opencode", "agents", "orchestrator.md")]: `---
description: OpenCode global agent
mode: primary
---
Body`,
    [p(PROJECT, ".opencode", "agent", "triage.md")]: `---
description: OpenCode project agent
mode: subagent
---
Body`,
    [p(PROJECT, ".agents", "agents", "shared.md")]: `---
name: shared
description: shared project agent
mode: subagent
---
Body`,
  });

  const result = await loadAgents({ fs, cwd: PROJECT, agentDir: AGENT_DIR, families: ["pi"] });

  assert.deepEqual(result.agents.map((a) => a.name).sort(), ["helper", "leader"]);
  assert.equal(result.warnings.length, 0);
});

test("discovery families: same files without the filter load everything", async () => {
  const fs = makeMockFs({
    [p(AGENT_DIR, "agents", "leader.agent.md")]: `---
name: leader
description: pi global agent
mode: primary
---
Body`,
    [p(os.homedir(), ".config", "opencode", "agents", "orchestrator.md")]: `---
description: OpenCode global agent
mode: primary
---
Body`,
    [p(PROJECT, ".agents", "agents", "shared.md")]: `---
name: shared
description: shared project agent
mode: subagent
---
Body`,
  });

  const result = await loadAgents({ fs, cwd: PROJECT, agentDir: AGENT_DIR });

  assert.deepEqual(result.agents.map((a) => a.name).sort(), ["leader", "orchestrator", "shared"]);
});

test("discovery families: pi-only drops an OpenCode-only definition", async () => {
  const fs = makeMockFs({
    [p(os.homedir(), ".config", "opencode", "agents", "executor.md")]: `---
description: OpenCode executor
mode: subagent
---
Body`,
  });

  const opencodeOnly = await loadAgents({ fs, cwd: PROJECT, agentDir: AGENT_DIR });
  assert.deepEqual(opencodeOnly.agents.map((a) => a.name), ["executor"]);

  const piOnly = await loadAgents({ fs, cwd: PROJECT, agentDir: AGENT_DIR, families: ["pi"] });
  assert.deepEqual(piOnly.agents, []);
});

test("discovery families: ['opencode'] keeps the three OpenCode roots", () => {
  const paths = getDiscoveryPaths(PROJECT, AGENT_DIR, { families: ["opencode"] });
  assert.deepEqual(
    paths.map((entry) => entry.dir),
    [
      // OpenCode globals are resolved from the real home dir (os.homedir()),
      // not from agentDir.
      p(os.homedir(), ".config", "opencode"),
      p(os.homedir(), ".opencode"),
      p(PROJECT, ".opencode"),
    ],
  );
});
