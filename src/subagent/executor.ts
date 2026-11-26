/**
 * Subagent executor — spawns and manages child pi processes.
 *
 * This is the core execution engine for subagent delegation.
 * Based on pi-subagents' subagent-executor.ts, adapted for:
 * - Unified AgentDefinition
 * - PI_OPEN_AGENTS_* env vars (renamed from PI_SUBAGENT_*)
 * - Unified thinking defaults (inherits from settings, not hardcoded 'off')
 */

import {
  ModelRegistry,
  SessionManager,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentDefinition } from "../types.ts";
import { splitModelVariant } from "../config/model-variant.ts";
import { byteLength, keepTailByBytes, safeFilePart, truncateHeadContent } from "../utils/format.ts";
import { buildSubagentPrompt } from "./prompt.ts";
import { buildSubagentEnv, type SubagentEnvVars } from "./env.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AgentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  contextWindow?: number;
}

export interface AgentToolLog {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: "running" | "done";
  nested?: AgentProgress;
}

export type SubagentSessionMode = "none" | "fork";

export interface SubagentSessionInfo {
  requested: SubagentSessionMode;
  effective: SubagentSessionMode;
  warning?: string;
  file?: string;
}

export interface AgentProgress {
  agent: string;
  status: "running" | "done" | "error";
  output: string;
  tools: AgentToolLog[];
  /**
   * Pid of the child pi process, for hosts that supervise long calls: they
   * probe the process tree for CPU movement once the call is suspended.
   * Absent where that evidence would mislead — see PID_EVIDENCE_PLATFORMS.
   */
  pid?: number;
  /**
   * Whether the child is inside a tool call right now. A host that supervises
   * long calls must not read a child waiting on its own tool as making no
   * progress: `npm test` inside the child emits nothing for minutes.
   */
  busy?: boolean;
  /**
   * Live run log of this delegation: one line per child event, appended while
   * it runs. A host that suspends the call into a background job loses the
   * rendered row, and this file is then the only readable timeline.
   */
  runLogPath?: string;
  usage: AgentUsage;
  startedAt: number;
  elapsedMs: number;
  model?: string;
  session?: SubagentSessionInfo;
}

export interface AgentResult extends AgentProgress {
  isError: boolean;
  exitCode: number;
  stderr: string;
}

export interface PiResolution {
  command: string;
  entryPoint: string;
}

export interface ProcessInvocation {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface ProcessHandlers {
  stdout(chunk: string): void;
  stderr(chunk: string): void;
  /**
   * Reported once, as soon as the child process exists (undefined when the
   * spawn failed). A host that supervises long calls — pi's tool supervisor
   * suspends a call past its deadline into a background job — probes this pid
   * for CPU movement, so a delegated run that is thinking without emitting
   * text is not reported as a stalled one.
   */
  pid?(pid: number | undefined): void;
}

export type ProcessRunner = (
  invocation: ProcessInvocation,
  handlers: ProcessHandlers,
  signal?: AbortSignal,
) => Promise<{ exitCode: number }>;

export interface ExecutorFs {
  makeTempDir(prefix: string): Promise<string>;
  writeFile(filePath: string, content: string): Promise<void>;
  removeDir(dir: string): Promise<void>;
  /**
   * Append one chunk to the run log. Optional so a fake filesystem can skip it;
   * the default appends without ever rejecting into the run.
   */
  appendFile?(filePath: string, chunk: string): Promise<void>;
}

export interface RunSubagentOptions {
  agent: AgentDefinition;
  task: string;
  cwd: string;
  signal?: AbortSignal;
  onProgress?: (progress: AgentProgress) => void;
  depth?: number;
  availableAgents?: string[];
  tempRoot?: string;
  outputArchiveDir?: string;
  agentDir?: string;
  session?: SubagentSessionInfo;
  /** Per-call model override ("provider/model-id"). Takes precedence over agent.model. */
  modelOverride?: string;
  /**
   * Parent's effective tool authority at delegation time (issue #8).
   * The child's representable toolset is intersected with it; the result
   * travels to the grandchild through pi's own active set (CLI ceiling),
   * so authority can only shrink along the delegation chain.
   * Undefined = no ceiling (unrestricted parent or host without
   * getActiveTools). Empty array = hard zero-tool ceiling.
   */
  parentCeiling?: string[];
  /** Parent's restrictive (deny/ask) permission rules, inherited into the child's gate via env. */
  parentRules?: Array<{ permission: string; pattern: string; action: "deny" | "ask" }>;
  /**
   * Commissioned deliverable path (issue #32). When set, the child is
   * instructed to write its main deliverable there (resolved against cwd
   * when relative) and cite it in the outcome block. Independent from the
   * automatic temp archive of the full transcript output.
   */
  outputPath?: string;
  resolvePi?: () => Promise<PiResolution> | PiResolution;
  runner?: ProcessRunner;
  fs?: ExecutorFs;
  now?: () => number;
  /** Platform deciding whether pid evidence is published (see PID_EVIDENCE_PLATFORMS). Defaults to process.platform. */
  platform?: NodeJS.Platform;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const TASK_FILE_THRESHOLD = 8000;
const OUTPUT_MAX_BYTES = 50 * 1024;
const OUTPUT_MAX_LINES = 2000;

/** One field of one run-log line: flattened and capped so a line stays a line. */
const LOG_FIELD_CHARS = 300;

/**
 * Platforms where the child pid is worth publishing to a supervising host.
 *
 * pi's tool supervisor samples the process tree for CPU movement to tell a
 * working call from a stalled one. That reading is only sound where the tree
 * can be sampled at all, and where a waiting child still burns CPU: on Windows
 * a child blocked on the model response shows none, so pid evidence there
 * would report a healthy run as stalled and invite the model to kill it.
 */
const PID_EVIDENCE_PLATFORMS: ReadonlySet<string> = new Set(["linux", "darwin"]);

// ─── Default FS ──────────────────────────────────────────────────────────────

const defaultExecutorFs: ExecutorFs = {
  makeTempDir(prefix) {
    return fs.mkdtemp(prefix);
  },
  async writeFile(filePath, content) {
    await withFileMutationQueue(filePath, async () => {
      await fs.writeFile(filePath, content, { encoding: "utf8", mode: 0o600 });
    });
  },
  async removeDir(dir) {
    await fs.rm(dir, { recursive: true, force: true });
  },
  async appendFile(filePath, chunk) {
    await fs.appendFile(filePath, chunk, { encoding: "utf8", mode: 0o600 });
  },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Derive a tools whitelist from the agent definition for the child process.
 *
 * The `--tools` CLI flag is a whitelist (include only these). It works with:
 * - Explicit `agent.tools` array (pi-style CSV)
 * - Simple permission allow-lists (keys with "allow", no wildcard)
 *
 * Does NOT work with:
 * - Wildcard permissions (`*: allow` + specific denies) — can't derive a
 *   finite whitelist. The child gets all tools. This is a known limitation
 *   of the `--tools` flag (it's a whitelist, not a deny-list).
 * - Pattern-based permissions (`edit: { "*.env": deny }`) — patterns can't
 *   be expressed as a flat tool whitelist.
 */
function deriveToolsWhitelist(agent: AgentDefinition): string[] | undefined {
  // Explicit tools array — use directly
  if (agent.tools && agent.tools.length > 0) {
    return agent.tools;
  }

  // Derive from permission config
  if (agent.permission) {
    // Can't derive a finite whitelist when wildcard is present
    if ("*" in agent.permission) return undefined;

    const allowed = Object.entries(agent.permission)
      .filter(([, value]) => value === "allow")
      .map(([key]) => key);

    return allowed.length > 0 ? allowed : undefined;
  }

  return undefined;
}

function emptyUsage(): AgentUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0 };
}

/** Collapse one value to a single capped line for the run log. */
function logField(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > LOG_FIELD_CHARS ? `${flat.slice(0, LOG_FIELD_CHARS)}...` : flat;
}

/** Name a tool call by its command when it has one, else by its args. */
function logToolArgs(args: Record<string, unknown>): string {
  return typeof args.command === "string" ? `$ ${logField(args.command)}` : logField(JSON.stringify(args));
}

/**
 * Compose the child's `--tools` value under the parent ceiling (#8).
 *
 * - No ceiling → child's own whitelist as-is (undefined when unrestricted).
 * - Ceiling + own whitelist → own ∩ ceiling, preserving own's order.
 * - Ceiling only (child unrestricted) → the ceiling itself.
 * - Empty result → "none": the caller must pass `--no-tools` — omitting
 *   `--tools` would mean ALL tools and fail open.
 */
export function composeChildTools(
  own: string[] | undefined,
  ceiling: string[] | undefined,
): string[] | "none" | undefined {
  if (ceiling === undefined) return own && own.length > 0 ? own : undefined;
  const base = own ?? ceiling;
  const allowed = new Set(ceiling);
  const result = base.filter((t) => allowed.has(t));
  return result.length > 0 ? result : "none";
}

/**
 * Marker separating the child's full transcript from its closing outcome
 * block (issue #32). The child is instructed (see buildClosingContract) to
 * end its final message with a `## Outcome` line followed by 2-3 lines.
 */
export const OUTCOME_MARKER = "## Outcome";

/**
 * Split the child's closing outcome block off the full output.
 *
 * Returns the text after the LAST marker line (case-insensitive, surrounding
 * whitespace ignored), or undefined when the child omitted the block —
 * older agents and error paths fall back to today's truncated inline.
 */
export function extractOutcomeBlock(output: string): string | undefined {
  const lines = output.split("\n");
  let idx = -1;
  lines.forEach((line, i) => {
    if (line.trim().toLowerCase() === OUTCOME_MARKER.toLowerCase()) idx = i;
  });
  if (idx === -1) return undefined;
  const rest = lines.slice(idx + 1).join("\n").trim();
  return rest ? rest : undefined;
}

export function subagentSessionDir(
  cwd: string,
  agentDir = path.join(os.homedir(), ".pi", "agent"),
): string {
  const safeProject = `--${path
    .resolve(cwd)
    .replace(/^[/\\]/, "")
    .replace(/[/\\:]/g, "-")}--`;
  return path.join(agentDir, "sessions", safeProject, "subagents");
}

/**
 * Detect Bun's in-memory virtual paths (issue #28).
 *
 * Inside a `bun build --compile` single-file binary, `process.argv[1]` (and on
 * some platforms `process.execPath`) resolves to a compile-time virtual entry
 * such as `/$bunfs/root/pi`. That path does not exist on disk — any
 * `realpathSync`/`lstat` on it throws ENOENT. A real on-disk executable path
 * never contains these markers, so the check has no false positives.
 */
export function isVirtualBunPath(candidate: string | undefined | null): boolean {
  if (!candidate) return false;
  return (
    candidate.includes("$bunfs") || candidate.includes("~BUN") || candidate.includes("%7EBUN")
  );
}

/**
 * Injectable host-process values for {@link resolvePiEntryPoint}.
 *
 * The production default reads `process.execPath` / `process.argv` /
 * `/proc/self/exe` directly. Tests inject exact strings (including the
 * virtual `/$bunfs/...` paths a compiled host reports) without spawning
 * a real compiled binary.
 */
export interface HostProcessProbe {
  execPath?: string;
  argv0?: string;
  argv1?: string;
  readProcSelfExe?: () => string;
}

/**
 * Pick the real executable for a compiled single-file host (issue #28).
 *
 * Priority order (most reliable first):
 * 1. `/proc/self/exe` (kernel truth on Linux),
 * 2. `process.execPath` (real in every observed compiled binary),
 * 3. `process.argv[0]` — ONLY when absolute. A compiled Bun binary reports
 *    the bare word `"bun"` here, which must never become the spawn command
 *    (it would resolve via PATH to the Bun runtime instead of pi).
 *
 * Returns `undefined` when every candidate is missing or virtual — the caller
 * turns that into a descriptive error instead of spawning a `$bunfs` path.
 */
export function resolveCompiledCommand(probe: {
  execPath?: string;
  argv0?: string;
  procSelfExe?: string | undefined;
}): string | undefined {
  for (const candidate of [probe.procSelfExe, probe.execPath]) {
    if (candidate && !isVirtualBunPath(candidate)) return candidate;
  }
  const argv0 = probe.argv0;
  if (argv0 && path.isAbsolute(argv0) && !isVirtualBunPath(argv0)) return argv0;
  return undefined;
}

export function resolvePiEntryPoint(
  resolveSelf: (specifier: string) => string = (specifier) => import.meta.resolve(specifier),
  hostProbe?: HostProcessProbe,
): PiResolution {
  const execPath = hostProbe?.execPath ?? process.execPath;
  const argv0 = hostProbe?.argv0 ?? process.argv[0];
  const argv1 = hostProbe?.argv1 ?? process.argv[1];

  // Compiled single-file host (`bun build --compile`): the entry "file" is a
  // virtual `$bunfs` path that does not exist on disk. The binary IS the CLI,
  // so resolve the real executable and return an empty entry point — the args
  // builder omits it and the child receives only real CLI flags.
  if (isVirtualBunPath(execPath) || isVirtualBunPath(argv1)) {
    let procSelfExe: string | undefined;
    try {
      procSelfExe = hostProbe?.readProcSelfExe
        ? hostProbe.readProcSelfExe()
        : realpathSync("/proc/self/exe");
    } catch {
      procSelfExe = undefined;
    }
    const command = resolveCompiledCommand({ execPath, argv0, procSelfExe });
    if (!command) {
      throw new Error(
        "pi-open-agents: running inside a compiled single-file pi binary but the real " +
          "executable path could not be determined (only virtual paths available). " +
          "Subagent delegation is unavailable in this environment.",
      );
    }
    return { command, entryPoint: "" };
  }

  let packageEntryPoint: string;
  try {
    packageEntryPoint = fileURLToPath(resolveSelf("@earendil-works/pi-coding-agent"));
  } catch {
    // npm-distributed plugin + bundled pi: the loader resolves host imports
    // through virtualModules, but import.meta.resolve falls back to native
    // resolution which cannot see the host package from the plugin's install
    // tree (peer dependencies are never installed next to it). Fall back to
    // the running pi entry itself — the child must run the same pi anyway.
    if (!argv1) {
      throw new Error(
        "pi-open-agents: cannot resolve the pi CLI entry point (host package " +
          "self-resolution failed and process.argv[1] is missing). " +
          "Subagent delegation is unavailable in this environment.",
      );
    }
    return {
      command: execPath,
      entryPoint: realpathSync(argv1),
    };
  }
  const packageRoot = path.dirname(path.dirname(packageEntryPoint));
  return {
    command: execPath,
    entryPoint: path.join(packageRoot, "dist", "cli.js"),
  };
}

export const defaultRunner: ProcessRunner = (invocation, handlers, signal) =>
  new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: invocation.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    handlers.pid?.(child.pid);
    child.stdout.on("data", (chunk) => handlers.stdout(String(chunk)));
    child.stderr.on("data", (chunk) => handlers.stderr(String(chunk)));
    child.on("error", reject);
    child.on("close", (code) => resolve({ exitCode: code ?? 0 }));

    if (signal) {
      const abort = () => child.kill("SIGTERM");
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }
  });

/**
 * Compute which subagents an agent is allowed to spawn.
 */
export function availableSubagentsForAgent(
  agent: AgentDefinition,
  candidateNames?: string[],
): string[] {
  const names = candidateNames ?? agent.allowedAgents ?? [];
  const allowed = agent.allowedAgents ? new Set(agent.allowedAgents) : undefined;
  const seen = new Set<string>();

  return names.filter((name) => {
    if (seen.has(name)) return false;
    if (allowed && !allowed.has(name)) return false;
    seen.add(name);
    return true;
  });
}

// ─── JSON Event Parsing ──────────────────────────────────────────────────────

type ContextWindowLookup = {
  find: (provider: string, modelId: string) => { contextWindow?: number } | undefined;
};

function textFromMessage(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  for (const part of content) {
    if (part && typeof part === "object" && (part as { type?: unknown }).type === "text") {
      const text = (part as { text?: unknown }).text;
      if (typeof text === "string") return text;
    }
  }
  return undefined;
}

function contextWindowFromMessage(
  message: unknown,
  modelRegistry?: ContextWindowLookup,
): number | undefined {
  if (!message || typeof message !== "object" || !modelRegistry) return undefined;
  const provider = (message as { provider?: unknown }).provider;
  const model = (message as { model?: unknown }).model;
  if (typeof provider !== "string" || typeof model !== "string") return undefined;
  return modelRegistry.find(provider, model)?.contextWindow;
}

function usageFromMessage(
  message: unknown,
  modelRegistry?: ContextWindowLookup,
): Partial<AgentUsage> | undefined {
  if (!message || typeof message !== "object") return undefined;
  const usage = (message as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") return undefined;
  const typed = usage as Record<string, unknown>;
  const cost =
    typed.cost && typeof typed.cost === "object"
      ? (typed.cost as Record<string, unknown>)
      : undefined;

  return {
    input: typeof typed.input === "number" ? typed.input : undefined,
    output: typeof typed.output === "number" ? typed.output : undefined,
    cacheRead: typeof typed.cacheRead === "number" ? typed.cacheRead : undefined,
    cacheWrite: typeof typed.cacheWrite === "number" ? typed.cacheWrite : undefined,
    cost: typeof cost?.total === "number" ? cost.total : undefined,
    contextTokens: typeof typed.totalTokens === "number" ? typed.totalTokens : undefined,
    contextWindow:
      typeof typed.contextWindow === "number"
        ? typed.contextWindow
        : contextWindowFromMessage(message, modelRegistry),
  };
}

/**
 * Extract the display model string from an assistant message (issue #27).
 *
 * `AssistantMessage` always carries both `provider` and `model`, so prefix the
 * bare id (`provider/model`) to match the `model:` frontmatter format and the
 * per-call override (`parseModelRef` splits on the first slash, so a
 * namespaced id such as `anthropic/claude-opus-5.5` under `openrouter`
 * round-trips exactly). No `provider` → bare id, as before.
 *
 * The `startsWith` guard prevents `provider/provider/...` when a host echoes
 * an already-qualified id. Deliberately NOT `responseModel`: that is the
 * provider-native answering snapshot (alias → dated version), a different
 * granularity from "which provider ran the agent".
 */
function modelFromMessage(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const data = message as { provider?: unknown; model?: unknown };
  if (typeof data.model !== "string") return undefined;
  if (typeof data.provider === "string" && !data.model.startsWith(`${data.provider}/`)) {
    return `${data.provider}/${data.model}`;
  }
  return data.model;
}

function updateUsage(target: AgentUsage, update: Partial<AgentUsage> | undefined) {
  if (!update) return;
  target.input += update.input ?? 0;
  target.output += update.output ?? 0;
  target.cacheRead += update.cacheRead ?? 0;
  target.cacheWrite += update.cacheWrite ?? 0;
  target.cost += update.cost ?? 0;
  target.contextTokens = update.contextTokens ?? target.contextTokens;
  target.contextWindow = update.contextWindow ?? target.contextWindow;
}

function replaceUsage(target: AgentUsage, source: AgentUsage) {
  target.input = source.input;
  target.output = source.output;
  target.cacheRead = source.cacheRead;
  target.cacheWrite = source.cacheWrite;
  target.cost = source.cost;
  target.contextTokens = source.contextTokens;
  target.contextWindow = source.contextWindow;
}

function usageFromMessages(
  messages: unknown,
  modelRegistry?: ContextWindowLookup,
): AgentUsage | undefined {
  if (!Array.isArray(messages)) return undefined;
  const aggregate = emptyUsage();
  let sawUsage = false;

  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    if ((message as { role?: unknown }).role !== "assistant") continue;
    const update = usageFromMessage(message, modelRegistry);
    if (!update) continue;
    sawUsage = true;
    updateUsage(aggregate, update);
  }

  return sawUsage ? aggregate : undefined;
}

function lastAssistantModel(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || typeof message !== "object") continue;
    if ((message as { role?: unknown }).role !== "assistant") continue;
    const model = modelFromMessage(message);
    if (model) return model;
  }
  return undefined;
}

function progressFromPartialResult(partialResult: unknown): AgentProgress | undefined {
  if (!partialResult || typeof partialResult !== "object") return undefined;
  const details = (partialResult as { details?: unknown }).details;
  if (!details || typeof details !== "object") return undefined;
  const agent = (details as { agent?: unknown }).agent;
  const status = (details as { status?: unknown }).status;
  if (typeof agent !== "string") return undefined;
  if (status !== "running" && status !== "done" && status !== "error") return undefined;
  return details as AgentProgress;
}

function buildTaskArgument(task: string, taskFilePath: string | undefined): string {
  return taskFilePath ? `Task: @${taskFilePath}` : `Task: ${task}`;
}

// ─── Model Registry (best-effort) ───────────────────────────────────────────

interface AuthFactory {
  create(authPath?: string): unknown;
}
interface RegistryFactory {
  create(authStore: unknown, modelsPath: string | undefined): ContextWindowLookup;
}

/**
 * Build a model registry for cost/context-window enrichment — best-effort and
 * resilient.
 *
 * AuthStorage/ModelRegistry availability and signatures vary across
 * pi-coding-agent host versions (AuthStorage was removed in newer releases;
 * ModelRegistry's create() signature also changed). The registry is purely
 * cosmetic — downstream usage enrichment tolerates a missing registry (see the
 * contextWindowFromMessage / usageFromMessage guards). This must never throw, or
 * subagent delegation breaks entirely. Factories are injectable for testing;
 * pass `{ auth: undefined, model: undefined }` to simulate a host that lacks
 * these symbols.
 */
export function buildModelRegistry(
  agentDir: string | undefined,
  factories: { auth?: AuthFactory; model?: RegistryFactory } = {},
): ContextWindowLookup | undefined {
  // AuthStorage was removed from newer pi-coding-agent hosts. A static named
  // import of it would fail module linking on hosts that no longer export it,
  // so look it up on the namespace object instead (absent → undefined).
  const hostAuth = (piCodingAgent as Record<string, unknown>).AuthStorage;
  const auth = ("auth" in factories ? factories.auth : hostAuth) as AuthFactory | undefined;
  const model = ("model" in factories ? factories.model : ModelRegistry) as RegistryFactory | undefined;
  try {
    if (!auth || typeof auth.create !== "function") return undefined;
    if (!model || typeof model.create !== "function") return undefined;
    const authPath = agentDir ? path.join(agentDir, "auth.json") : undefined;
    const modelsPath = agentDir ? path.join(agentDir, "models.json") : undefined;
    return model.create(auth.create(authPath), modelsPath);
  } catch {
    return undefined;
  }
}

// ─── Main Executor ───────────────────────────────────────────────────────────

/**
 * Run a subagent in a child pi process.
 *
 * Steps:
 * 1. Build system prompt (agent body + skills)
 * 2. Build CLI args from AgentDefinition
 * 3. Spawn child pi process with scoped tools, model, thinking
 * 4. Stream JSON events from stdout
 * 5. Render progress via callback
 * 6. Return result
 */
export async function runSubagent(options: RunSubagentOptions): Promise<AgentResult> {
  const fileSystem = options.fs ?? defaultExecutorFs;
  const resolvePi = options.resolvePi ?? resolvePiEntryPoint;
  const runner = options.runner ?? defaultRunner;
  const now = options.now ?? Date.now;
  const startedAt = now();
  const tempPrefix = path.join(options.tempRoot ?? os.tmpdir(), "pi-open-agents-");
  const tempDir = await fileSystem.makeTempDir(tempPrefix);

  const usage = emptyUsage();
  const tools: AgentToolLog[] = [];
  let output = "";
  let stderr = "";
  let model = options.agent.model;
  let stdoutBuffer = "";
  let childPid: number | undefined;
  let runLogPath: string | undefined;
  /** Last `stopReason: "error"` the child reported on an assistant turn. */
  let assistantError: string | undefined;
  /** Serializes run-log appends so lines never interleave. */
  let logChain: Promise<void> = Promise.resolve();
  const platform = options.platform ?? process.platform;

  // The run log lives beside the output archive, not in tempDir: it must stay
  // readable after the run ends, including when the call was suspended into a
  // background job and its row is gone.
  const runLogFile = path.join(
    options.outputArchiveDir ?? os.tmpdir(),
    `${safeFilePart(options.agent.name)}-${startedAt}-run.log`,
  );

  const stamp = () => `+${((now() - startedAt) / 1000).toFixed(1)}s`;

  /**
   * Append one line to the run log. Swallows failures: a debug log must never
   * break a delegation. `runLogPath` is set on the first line so progress only
   * advertises a file that exists.
   */
  const logRun = (line: string) => {
    const append = fileSystem.appendFile;
    if (!append) return;
    runLogPath ??= runLogFile;
    logChain = logChain
      .then(() => append.call(fileSystem, runLogFile, `${line}\n`))
      .catch(() => {});
  };

  const progress = (status: AgentProgress["status"]): AgentProgress => ({
    agent: options.agent.name,
    status,
    output,
    tools: [...tools],
    ...(childPid === undefined || !PID_EVIDENCE_PLATFORMS.has(platform) ? {} : { pid: childPid }),
    ...(tools.some((tool) => tool.status === "running") ? { busy: true } : {}),
    ...(runLogPath === undefined ? {} : { runLogPath }),
    usage: { ...usage },
    startedAt,
    elapsedMs: now() - startedAt,
    model,
    session: options.session ?? { requested: "none", effective: "none" },
  });

  const emit = (status: AgentProgress["status"] = "running") =>
    options.onProgress?.(progress(status));

  try {
    // ── Commissioned deliverable (issue #32) ──
    // Resolved against the child cwd so the closing contract can name the
    // exact path and the task can point at it.
    const deliverablePath =
      options.outputPath && options.outputPath.trim()
        ? path.resolve(options.cwd, options.outputPath)
        : undefined;
    const task =
      deliverablePath !== undefined
        ? `${options.task}\n\nDeliverable: save your main deliverable to ${deliverablePath} and cite it in the outcome block.`
        : options.task;

    logRun(
      `[${stamp()}] run ${options.agent.name} model=${options.modelOverride ?? options.agent.model ?? "inherit"} cwd=${options.cwd} task=${logField(task)}`,
    );

    // ── Build system prompt ──
    const promptFilePath = path.join(tempDir, "system-prompt.md");
    const promptResult = await buildSubagentPrompt({
      agent: options.agent,
      cwd: options.cwd,
      agentDir: options.agentDir,
      outputPath: deliverablePath,
    });

    for (const source of promptResult.skills.skippedPackages) {
      console.warn(`[pi-open-agents] package not installed, skipping skills: ${source}`);
    }
    for (const warning of promptResult.skills.warnings) {
      console.warn(`[pi-open-agents] ${warning}`);
    }
    for (const name of promptResult.skills.missing) {
      console.warn(`[pi-open-agents] skill not found: ${name}`);
    }
    await fileSystem.writeFile(promptFilePath, promptResult.prompt);

    // ── Write task to file if too long ──
    let taskFilePath: string | undefined;
    if (task.length > TASK_FILE_THRESHOLD) {
      taskFilePath = path.join(tempDir, "task.md");
      await fileSystem.writeFile(taskFilePath, task);
    }

    // ── Resolve pi CLI entry point ──
    const pi = await resolvePi();

    // ── Build model registry for cost lookups (best-effort) ──
    const modelRegistry = buildModelRegistry(options.agentDir);

    // ── Build CLI args ──
    // A compiled single-file host IS the CLI: its PiResolution carries an
    // empty entryPoint (issue #28) and the child receives only real CLI
    // flags. Non-compiled hosts keep runtime + script + flags, unchanged.
    const args = [
      ...(pi.entryPoint ? [pi.entryPoint] : []),
      "--mode", "json",
      "-p",
      "--no-skills",
      "--no-prompt-templates",
    ];

    // System prompt mode controls context files
    if (options.agent.systemPrompt === "replace-all") {
      args.push("--no-context-files");
    }

    // Model: per-call override wins over the agent definition default. An
    // OpenCode-style "#variant" suffix is split off — pi resolves only the ":"
    // form, so the raw id would reach the provider and be rejected.
    const modelRef = splitModelVariant(options.modelOverride ?? options.agent.model);
    if (modelRef.model) {
      args.push("--model", modelRef.model);
    }
    model = modelRef.model ?? options.agent.model;

    // Thinking level: an inline variant wins over the agent's `thinking:` field
    args.push("--thinking", modelRef.thinking ?? options.agent.thinking);

    // Tools whitelist, intersected with the parent's ceiling (#8)
    const childTools = composeChildTools(deriveToolsWhitelist(options.agent), options.parentCeiling);
    if (childTools === "none") {
      args.push("--no-tools");
    } else if (childTools) {
      args.push("--tools", childTools.join(","));
    }

    // System prompt file (append or replace)
    args.push(
      options.agent.systemPrompt === "append" ? "--append-system-prompt" : "--system-prompt",
      promptFilePath,
    );

    // Session directory
    args.push("--session-dir", subagentSessionDir(options.cwd, options.agentDir));

    // Session fork
    if (options.session?.effective === "fork" && options.session.file) {
      args.push("--session", options.session.file);
    }

    // Task
    args.push(buildTaskArgument(task, taskFilePath));

    // ── Build env vars ──
    const envVars: SubagentEnvVars = {
      depth: options.depth ?? 1,
      maxDepth: options.agent.maxDepth,
      agentName: options.agent.name,
      systemPromptMode: options.agent.systemPrompt,
      session: options.session?.effective ?? "none",
      allowedAgents: availableSubagentsForAgent(options.agent, options.availableAgents),
      parentRules: options.parentRules && options.parentRules.length > 0
        ? JSON.stringify(options.parentRules)
        : undefined,
      debug: false,
    };
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...buildSubagentEnv(envVars),
      // Under an Electron host (pi desktop) process.execPath is electron.exe:
      // without this the child starts a full Electron app that finishes its
      // turn but never exits, so the runner's `close` event — and with it the
      // whole delegation — would hang forever.
      ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
    };

    // ── Process JSON events from stdout ──
    const processLine = (line: string) => {
      if (!line.trim()) return;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }

      if (event.type === "tool_execution_start") {
        const name = String(event.toolName ?? "tool");
        const args =
          event.args && typeof event.args === "object"
            ? (event.args as Record<string, unknown>)
            : {};
        tools.push({
          id: String(event.toolCallId ?? tools.length),
          name,
          args,
          status: "running",
        });
        logRun(`[${stamp()}] tool ${name} start ${logToolArgs(args)}`);
        emit();
        return;
      }

      if (event.type === "tool_execution_update") {
        const id = String(event.toolCallId ?? "");
        const tool = tools.find((item) => item.id === id);
        const nested = progressFromPartialResult(event.partialResult);
        if (tool && nested) tool.nested = nested;
        emit();
        return;
      }

      if (event.type === "tool_execution_end") {
        const id = String(event.toolCallId ?? "");
        const tool = tools.find((item) => item.id === id);
        if (tool) tool.status = "done";
        logRun(`[${stamp()}] tool ${tool?.name ?? id} done`);
        emit();
        return;
      }

      if (event.type === "message_end" && event.message) {
        // pi 0.83.0+ emits message_end for EVERY role (user, assistant, toolResult),
        // not just assistant. Only capture text/usage/model from assistant messages —
        // otherwise the echoed user task ("Task: ...") and raw tool results leak into
        // the subagent output when the final assistant turn has no text part.
        if ((event.message as { role?: unknown }).role === "assistant") {
          const text = textFromMessage(event.message);
          if (text !== undefined) {
            output = text;
            logRun(`[${stamp()}] assistant: ${logField(text)}`);
          }
          // A failed turn is reported by the child as stopReason "error" with
          // no text at all; without this the parent's result was "(no output)"
          // and the reason was only visible in the child's session file.
          if ((event.message as { stopReason?: unknown }).stopReason === "error") {
            const reported = (event.message as { errorMessage?: unknown }).errorMessage;
            assistantError =
              typeof reported === "string" && reported.trim() !== ""
                ? reported.trim()
                : "the child stopped with an unspecified model error";
            logRun(`[${stamp()}] assistant error: ${logField(assistantError)}`);
          }
          updateUsage(usage, usageFromMessage(event.message, modelRegistry));
          model = modelFromMessage(event.message) ?? model;
        }
        emit();
        return;
      }

      if (event.type === "agent_end") {
        const aggregate = usageFromMessages(event.messages, modelRegistry);
        if (aggregate) replaceUsage(usage, aggregate);
        model = lastAssistantModel(event.messages) ?? model;
        logRun(`[${stamp()}] agent end`);
        emit();
      }
    };

    // ── Run the child process ──
    const exit = await runner(
      { command: pi.command, args, cwd: options.cwd, env: childEnv },
      {
        stdout(chunk) {
          stdoutBuffer += chunk;
          const lines = stdoutBuffer.split("\n");
          stdoutBuffer = lines.pop() ?? "";
          for (const line of lines) processLine(line);
        },
        stderr(chunk) {
          stderr += chunk;
          logRun(`[${stamp()}] stderr: ${logField(chunk)}`);
        },
        pid(pid) {
          // No child (spawn error) and second reports change nothing.
          if (pid === undefined || childPid !== undefined) return;
          childPid = pid;
          logRun(`[${stamp()}] child pid=${pid}`);
          emit();
        },
      },
      options.signal,
    );

    // Process any remaining buffered output
    if (stdoutBuffer.trim()) processLine(stdoutBuffer);

    // A failed child turn ends the run with the provider's message and nothing
    // else: report it as the result instead of "(no output)".
    const isError = exit.exitCode !== 0 || assistantError !== undefined;
    if (!output) {
      output = assistantError ?? (isError ? stderr || `Subagent exited with code ${exit.exitCode}` : "");
    } else if (assistantError !== undefined) {
      output = `${output}\n\n[child stopped with an error: ${assistantError}]`;
    }
    logRun(`[${stamp()}] exit code=${exit.exitCode}${assistantError === undefined ? "" : " model error"}`);

    // ── Archive full output + derive the inline result (issue #32) ──
    // Every run archives the verbatim output to a temp file; inline the
    // child only sends its closing outcome block (file reference included).
    // Without the block (older agents, error paths) fall back to today's
    // truncated inline. A failed archive write must never break delegation:
    // fall back to inline-only and warn.
    const fullOutputPath = path.join(
      options.outputArchiveDir ?? os.tmpdir(),
      `${safeFilePart(options.agent.name)}-${startedAt}-output.md`,
    );
    let archived = false;
    try {
      await fileSystem.writeFile(fullOutputPath, output);
      archived = true;
    } catch (error) {
      console.warn(
        `[pi-open-agents] could not archive subagent output to ${fullOutputPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const outcome = extractOutcomeBlock(output);
    if (archived && outcome !== undefined) {
      output = `${outcome}\n\nFull output: ${fullOutputPath}`;
    } else if (archived) {
      const truncated = truncateHeadContent(output, OUTPUT_MAX_BYTES, OUTPUT_MAX_LINES);
      if (truncated !== undefined) {
        output = `${truncated}\n\n[Output truncated: original ${output.split("\n").length} lines / ${byteLength(output)} bytes. Full output: ${fullOutputPath}]`;
      }
    } else {
      const truncated = truncateHeadContent(output, OUTPUT_MAX_BYTES, OUTPUT_MAX_LINES);
      if (truncated !== undefined) {
        output = `${truncated}\n\n[Output truncated: original ${output.split("\n").length} lines / ${byteLength(output)} bytes. Archive write failed — full output unavailable.]`;
      }
    }

    const result: AgentResult = {
      ...progress(isError ? "error" : "done"),
      isError,
      exitCode: exit.exitCode,
      stderr,
    };
    emit(isError ? "error" : "done");
    return result;
  } catch (error) {
    output = error instanceof Error ? error.message : String(error);
    logRun(`[${stamp()}] crashed: ${logField(output)}`);
    return {
      ...progress("error"),
      isError: true,
      exitCode: 1,
      stderr,
    };
  } finally {
    // Let pending log writes land; the file outlives the run.
    await logChain.catch(() => {});
    await fileSystem.removeDir(tempDir);
  }
}

// ─── Session Resolution ──────────────────────────────────────────────────────

import { existsSync } from "node:fs";

function freshSessionInfo(
  requested: SubagentSessionMode,
  warning?: string,
): SubagentSessionInfo {
  return {
    requested,
    effective: "none",
    ...(warning ? { warning } : {}),
  };
}

/**
 * Resolve the session mode for a subagent.
 *
 * Handles graceful degradation from 'fork' to 'none' when prerequisites
 * (same cwd, persisted session, leaf ID) are not met.
 */
export function resolveSubagentSession(
  requested: SubagentSessionMode | undefined,
  childCwd: string,
  parentSessionFile: string | undefined,
  parentLeafId: string | null | undefined,
  agentDir?: string,
): SubagentSessionInfo {
  const mode = requested ?? "none";
  if (mode === "none") return freshSessionInfo(mode);

  if (path.resolve(childCwd) !== path.resolve(process.cwd())) {
    return freshSessionInfo(
      mode,
      "Requested fork session but cwd differs from the parent session; running with a fresh subagent session instead.",
    );
  }

  if (!parentSessionFile) {
    return freshSessionInfo(
      mode,
      "Requested fork session but the parent session is not persisted; running with a fresh subagent session instead.",
    );
  }

  if (!existsSync(parentSessionFile)) {
    return freshSessionInfo(
      mode,
      "Requested fork session but the parent session file was not materialized; running with a fresh subagent session instead.",
    );
  }

  if (!parentLeafId) {
    return freshSessionInfo(
      mode,
      "Requested fork session but the parent session has no current leaf; running with a fresh subagent session instead.",
    );
  }

  try {
    const forkSource = SessionManager.open(
      parentSessionFile,
      subagentSessionDir(childCwd, agentDir),
      childCwd,
    );
    const sessionFile = forkSource.createBranchedSession(parentLeafId);
    if (!sessionFile || !existsSync(sessionFile)) {
      return freshSessionInfo(
        mode,
        "Requested fork session but the forked session file was not materialized; running with a fresh subagent session instead.",
      );
    }
    return { requested: mode, effective: "fork", file: sessionFile };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return freshSessionInfo(
      mode,
      `Requested fork session but creating the fork failed (${message}); running with a fresh subagent session instead.`,
    );
  }
}
