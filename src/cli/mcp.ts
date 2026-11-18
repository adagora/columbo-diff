import { createInterface } from "node:readline";
import vm from "node:vm";
import { concat, decodeUTF8, encodeUTF8, isValidUTF8, trimSpace } from "../meat/bytes.ts";
import { analyzeDiff, splitSourceLines } from "../meat/diff.ts";
import { analyzeDiffTriage, formatTriageMarkdown, formatTriageReport, summarizeDiffFiles, type FileDiffSummary } from "./dashboard.ts";
import { compileMeatDiff, filterDiffByFile } from "./shape.ts";
import { runState } from "./state.ts";
import { analyzeDiffForStatechart, parseDiffGitHeader, parsePlusHeader } from "./statechart.ts";

export type McpSourceReader = (
  args: readonly string[],
  staged: boolean,
  worktree: boolean,
) => Promise<{ diff: Uint8Array; source: string }>;

export interface McpContext {
  readonly readSource: McpSourceReader;
  readonly version: string;
  readonly guideText: string;
  readonly cwd?: string;
  readonly codemode?: boolean;
  readonly sessionStore?: Map<string, unknown>;
}

interface JsonRpcRequest {
  readonly jsonrpc?: unknown;
  readonly id?: string | number | null;
  readonly method?: unknown;
  readonly params?: unknown;
}

export interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: string | number | null;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
}

const SUPPORTED_PROTOCOLS = new Set([
  "2026-07-28",
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
]);
const DEFAULT_PROTOCOL = "2025-06-18";
const DEFAULT_MAX_BYTES = 32768;
const MAX_ALLOWED_BYTES = 409600;
const EXEC_SYNC_TIMEOUT_MS = 5000;
const EXEC_ASYNC_TIMEOUT_MS = 10000;
const MAX_STORE_KEYS = 64;
const MAX_STORE_BYTES = 4 * 1024 * 1024;
const RISK_RANK: Record<FileDiffSummary["risk"], number> = { high: 3, medium: 2, low: 1 };

export const MCP_TOOLS = [
  {
    name: "triage_diff",
    description:
      "Offline deterministic X-Ray (SHA-256, stripped imports, byte-exact moves, generated/lockfiles, behavioral meat) plus heuristic review order and invariants (columbo.triage.v1). No model or API key.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        source: {
          type: "string",
          description: "Git revision, range (e.g. HEAD, main...HEAD), --staged, or --worktree. Defaults to HEAD when diff is omitted.",
        },
        diff: {
          type: "string",
          description: "Raw unified diff text to analyze offline without Git access.",
        },
        top: {
          type: "integer",
          minimum: 1,
          maximum: 500,
          description: "Limit reviewOrder to the top N prioritized files.",
        },
        risk: {
          type: "string",
          enum: ["high", "medium", "low"],
          description: "Minimum heuristic risk level to include in reviewOrder.",
        },
        format: {
          type: "string",
          enum: ["json", "text", "markdown"],
          description: "Output representation in content text (default: json).",
        },
      },
    },
    outputSchema: {
      type: "object",
      required: ["schema", "sourceLabel", "deterministicTruth", "heuristicTriage"],
      properties: {
        schema: { type: "string", const: "columbo.triage.v1" },
        sourceLabel: { type: "string" },
        deterministicTruth: {
          type: "object",
          required: [
            "inputSha256",
            "rawBytes",
            "filesChanged",
            "totalChangedLines",
            "behavioralLines",
            "strippedImportLines",
            "exactMoveLines",
            "exactMovePairs",
            "generatedLines",
            "generatedFiles",
            "noiseReductionPct",
            "compilerEligible",
            "fitsSingleRun",
            "partitionCount",
          ],
          properties: {
            inputSha256: { type: "string" },
            rawBytes: { type: "integer" },
            filesChanged: { type: "integer" },
            totalChangedLines: { type: "integer" },
            behavioralLines: { type: "integer" },
            strippedImportLines: { type: "integer" },
            exactMoveLines: { type: "integer" },
            exactMovePairs: { type: "integer" },
            generatedLines: { type: "integer" },
            generatedFiles: { type: "integer" },
            noiseReductionPct: { type: "integer" },
            compilerEligible: { type: "boolean" },
            compilerReason: { type: ["string", "null"] },
            fitsSingleRun: { type: "boolean" },
            partitionCount: { type: "integer" },
            ledgerAvailable: { type: "boolean" },
            staleEvidenceCount: { type: "integer" },
            unresolvedDecisionCount: { type: "integer" },
          },
        },
        heuristicTriage: {
          type: "object",
          required: ["notSafetyProof", "guidance", "statechartRecommended", "reviewOrder", "invariantsToVerify", "recommendedCommands"],
          properties: {
            notSafetyProof: { type: "boolean", const: true },
            guidance: { type: "string" },
            statechartRecommended: { type: "boolean" },
            signals: { type: "object" },
            reviewOrder: { type: "array", items: { type: "object" } },
            invariantsToVerify: { type: "array", items: { type: "string" } },
            recommendedCommands: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
  },
  {
    name: "read_meat_diff",
    description:
      "Offline deterministic diff projection: strips proven imports, folds generated/lockfiles, collapses byte-exact moves into coordinate markers (L_old <-> L_new), and bounds output size.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        source: {
          type: "string",
          description: "Git revision, range, --staged, or --worktree. Defaults to HEAD when diff is omitted.",
        },
        diff: {
          type: "string",
          description: "Raw unified diff text to project offline.",
        },
        file: {
          type: "string",
          description: "Exact file path or substring filter to inspect a focused file or directory.",
        },
        risk: {
          type: "string",
          enum: ["high", "medium", "low"],
          description: "Only include files at or above this heuristic risk tier.",
        },
        maxBytes: {
          type: "integer",
          minimum: 256,
          maximum: MAX_ALLOWED_BYTES,
          description: "Maximum UTF-8 bytes to return in diffText (default: 32768).",
        },
      },
    },
    outputSchema: {
      type: "object",
      required: [
        "source",
        "totalChangedLines",
        "behavioralLines",
        "importLines",
        "moveLines",
        "generatedLines",
        "exactMovePairs",
        "noiseReductionPct",
        "compilerEligible",
        "truncated",
        "returnedBytes",
        "totalBytes",
        "diffText",
      ],
      properties: {
        source: { type: "string" },
        fileFilter: { type: ["string", "null"] },
        minRisk: { type: ["string", "null"] },
        totalChangedLines: { type: "integer" },
        behavioralLines: { type: "integer" },
        importLines: { type: "integer" },
        moveLines: { type: "integer" },
        generatedLines: { type: "integer" },
        exactMovePairs: { type: "integer" },
        omittedFiles: { type: "integer" },
        generatedFiles: { type: "integer" },
        noiseReductionPct: { type: "integer" },
        compilerEligible: { type: "boolean" },
        compilerReason: { type: ["string", "null"] },
        truncated: { type: "boolean" },
        returnedBytes: { type: "integer" },
        totalBytes: { type: "integer" },
        diffText: { type: "string" },
      },
    },
  },
  {
    name: "analyze_statechart",
    description:
      "Analyze diff state, error, retry, async, and branch-guard signals offline without TLA+. Emits invariants, transition delta, failure walkthrough, and starter Mermaid stateDiagram-v2.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        source: {
          type: "string",
          description: "Git revision, range, --staged, or --worktree. Defaults to HEAD when diff is omitted.",
        },
        diff: {
          type: "string",
          description: "Raw unified diff text to analyze offline.",
        },
      },
    },
    outputSchema: {
      type: "object",
      required: ["title", "evidenceLabel", "shouldGenerate", "triggerReason", "signals", "sourceRefs", "invariants", "mermaid"],
      properties: {
        title: { type: "string" },
        evidenceLabel: { type: "string" },
        shouldGenerate: { type: "boolean" },
        triggerReason: { type: "string" },
        signals: { type: "object" },
        sourceRefs: { type: "array", items: { type: "string" } },
        invariants: { type: "array", items: { type: "string" } },
        transitionDelta: { type: "array", items: { type: "object" } },
        failureWalkthrough: { type: "array", items: { type: "object" } },
        omissions: { type: "array", items: { type: "string" } },
        mermaid: { type: "string" },
      },
    },
  },
  {
    name: "evidence_status",
    description:
      "Read local columbo-state-v1 intent, evidence freshness (needs_recheck vs supporting_inputs_unchanged), and unresolved decisions. Records are attributed claims (verified_by_columbo: false).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        task: {
          type: "string",
          description: "Optional intent task ID to scope status.",
        },
        details: {
          type: "boolean",
          description: "Include full evidence claims and superseded decision history.",
        },
      },
    },
    outputSchema: {
      type: "object",
      required: ["kind", "tasks", "evidence", "decisions"],
      properties: {
        kind: { type: "string" },
        repository: { type: "string" },
        head: { type: ["string", "null"] },
        branch: { type: ["string", "null"] },
        tasks: { type: "array", items: { type: "object" } },
        evidence: { type: "array", items: { type: "object" } },
        decisions: { type: "array", items: { type: "object" } },
        unresolved_decisions: { type: "array", items: { type: "string" } },
      },
    },
  },
] as const;

const CODEMODE_DECLARATIONS = `Run an async JavaScript body in a local sandbox (no imports, no fs/process/network). Chain multiple offline columbo calls in one turn, filter in memory, and emit only what you need via text() or return.

Available globals:
declare namespace tools {
  function triageDiff(args?: { source?: string; diff?: string; top?: number; risk?: "high" | "medium" | "low"; format?: "json" | "text" | "markdown" }): Promise<{
    schema: "columbo.triage.v1";
    sourceLabel: string;
    deterministicTruth: { inputSha256: string; rawBytes: number; filesChanged: number; totalChangedLines: number; behavioralLines: number; strippedImportLines: number; exactMoveLines: number; exactMovePairs: number; generatedLines: number; generatedFiles: number; noiseReductionPct: number; compilerEligible: boolean; fitsSingleRun: boolean; partitionCount: number; ledgerAvailable: boolean; staleEvidenceCount: number; unresolvedDecisionCount: number };
    heuristicTriage: { notSafetyProof: true; guidance: string; statechartRecommended: boolean; reviewOrder: Array<{ file: string; risk: "high" | "medium" | "low"; behavioralLines: number; noiseLines: number; adds: number; deletes: number; reasons: string[] }>; invariantsToVerify: string[]; recommendedCommands: string[] };
  }>;
  function readMeatDiff(args?: { source?: string; diff?: string; file?: string; risk?: "high" | "medium" | "low"; maxBytes?: number }): Promise<{
    source: string; fileFilter: string | null; minRisk: string | null; totalChangedLines: number; behavioralLines: number; importLines: number; moveLines: number; generatedLines: number; exactMovePairs: number; omittedFiles: number; generatedFiles: number; noiseReductionPct: number; compilerEligible: boolean; truncated: boolean; returnedBytes: number; totalBytes: number; diffText: string;
  }>;
  function analyzeStatechart(args?: { source?: string; diff?: string }): Promise<{
    title: string; evidenceLabel: string; shouldGenerate: boolean; triggerReason: string; signals: Record<string, number>; sourceRefs: string[]; invariants: string[]; mermaid: string;
  }>;
  function evidenceStatus(args?: { task?: string; details?: boolean }): Promise<{
    kind: string; head: string | null; branch: string | null; tasks: unknown[]; evidence: unknown[]; decisions: unknown[]; unresolved_decisions: string[];
  }>;
}
declare const ALL_TOOLS: Record<string, { description: string; signature: string }>;
declare function text(output: string): void;
declare function store(key: string, value: unknown): void;
declare function load<T = unknown>(key: string): T | undefined;`;

export const MCP_CODEMODE_TOOLS = [
  {
    name: "exec",
    description: CODEMODE_DECLARATIONS,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["code"],
      properties: {
        code: {
          type: "string",
          minLength: 1,
          description: "Async JavaScript function body using await tools.*(), text(), store(), and load().",
        },
        maxBytes: {
          type: "integer",
          minimum: 256,
          maximum: MAX_ALLOWED_BYTES,
          description: "Maximum UTF-8 bytes returned in output (default: 32768).",
        },
      },
    },
    outputSchema: {
      type: "object",
      required: ["output", "truncated", "returnedBytes", "totalBytes", "toolCalls", "storedKeys"],
      properties: {
        output: { type: "string" },
        truncated: { type: "boolean" },
        returnedBytes: { type: "integer" },
        totalBytes: { type: "integer" },
        toolCalls: { type: "integer" },
        storedKeys: { type: "array", items: { type: "string" } },
      },
    },
  },
] as const;

const SANDBOX_TOOL_CATALOG: Record<string, { description: string; signature: string }> = {
  triageDiff: {
    description: MCP_TOOLS[0].description,
    signature: "(args?: { source?: string; diff?: string; top?: number; risk?: 'high' | 'medium' | 'low'; format?: 'json' | 'text' | 'markdown' }) => Promise<TriageSummary>",
  },
  readMeatDiff: {
    description: MCP_TOOLS[1].description,
    signature: "(args?: { source?: string; diff?: string; file?: string; risk?: 'high' | 'medium' | 'low'; maxBytes?: number }) => Promise<MeatDiffResult>",
  },
  analyzeStatechart: {
    description: MCP_TOOLS[2].description,
    signature: "(args?: { source?: string; diff?: string }) => Promise<StatechartArtifact>",
  },
  evidenceStatus: {
    description: MCP_TOOLS[3].description,
    signature: "(args?: { task?: string; details?: boolean }) => Promise<EvidenceStatus>",
  },
};

export const MCP_RESOURCES = [
  {
    uri: "columbo://guide",
    name: "Columbo Agent Workflow Guide",
    description: "Offline packet/compile, triage, meat-only diff, and evidence ledger workflow guide.",
    mimeType: "text/plain",
  },
  {
    uri: "columbo://triage-schema",
    name: "Columbo Triage v1 Truth Model",
    description: "Contract distinguishing deterministicTruth from heuristicTriage (notSafetyProof: true).",
    mimeType: "application/json",
  },
] as const;

const TRIAGE_SCHEMA_DOC = {
  schema: "columbo.triage.v1",
  deterministicTruth: [
    "inputSha256",
    "rawBytes",
    "filesChanged",
    "totalChangedLines",
    "behavioralLines",
    "strippedImportLines",
    "exactMoveLines",
    "exactMovePairs",
    "generatedLines",
    "generatedFiles",
    "noiseReductionPct",
    "compilerEligible",
    "fitsSingleRun",
    "partitionCount",
    "ledgerAvailable",
    "staleEvidenceCount",
    "unresolvedDecisionCount",
  ],
  heuristicTriage: {
    notSafetyProof: true,
    note: "Risk tiers, control-flow signals, and State Flow are review prioritization hints only. Low risk never proves a file is bug-free.",
  },
};

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function parseRisk(value: unknown): FileDiffSummary["risk"] | undefined {
  if (value === undefined) return undefined;
  if (value === "high" || value === "medium" || value === "low") return value;
  throw new Error(`Invalid risk ${JSON.stringify(value)}; expected high, medium, or low`);
}

async function resolveDiffInput(
  args: Record<string, unknown>,
  readSource: McpSourceReader,
): Promise<{ diffBytes: Uint8Array; diffText: string; sourceLabel: string; isGitTarget: boolean }> {
  if (typeof args["diff"] === "string") {
    const diffBytes = encodeUTF8(args["diff"]);
    if (trimSpace(diffBytes).length === 0) throw new Error("Provided diff is empty.");
    return {
      diffBytes,
      diffText: args["diff"],
      sourceLabel: typeof args["source"] === "string" && args["source"].trim() !== "" ? args["source"].trim() : "inline-diff",
      isGitTarget: false,
    };
  }
  const rawSource = typeof args["source"] === "string" && args["source"].trim() !== "" ? args["source"].trim() : "HEAD";
  let staged = false;
  let worktree = false;
  let revisions: string[] = [];
  if (rawSource === "--staged" || rawSource === "-staged" || rawSource === "staged") {
    staged = true;
  } else if (rawSource === "--worktree" || rawSource === "-w" || rawSource === "worktree") {
    worktree = true;
  } else {
    revisions = [rawSource];
  }
  const loaded = await readSource(revisions, staged, worktree);
  if (trimSpace(loaded.diff).length === 0) throw new Error(`No diff to inspect for source ${JSON.stringify(rawSource)}.`);
  if (!isValidUTF8(loaded.diff)) throw new Error("Diff contains non-UTF-8 bytes; inspect individual UTF-8 files.");
  return {
    diffBytes: loaded.diff,
    diffText: decodeUTF8(loaded.diff),
    sourceLabel: loaded.source,
    isGitTarget: true,
  };
}

function filterDiffByAllowedFiles(diffBytes: Uint8Array, allowed: ReadonlySet<string>): Uint8Array {
  const sourceLines = splitSourceLines(diffBytes);
  const layout = analyzeDiff(sourceLines);
  const fidToPath = new Map<number, string>();
  for (let i = 0; i < sourceLines.length; i++) {
    const fid = layout.fileId[i] ?? -1;
    if (fid < 0) continue;
    const text = decodeUTF8(sourceLines[i]!.text);
    const gitPath = parseDiffGitHeader(text);
    if (gitPath !== null) fidToPath.set(fid, gitPath);
    else if (text.startsWith("+++ ")) {
      const plusPath = parsePlusHeader(text);
      if (plusPath !== null) fidToPath.set(fid, plusPath);
    }
  }
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < sourceLines.length; i++) {
    const fid = layout.fileId[i] ?? -1;
    const filePath = fid >= 0 ? fidToPath.get(fid) : undefined;
    if (filePath !== undefined && allowed.has(filePath)) {
      const line = sourceLines[i]!;
      chunks.push(line.text, line.eol);
    }
  }
  return chunks.length > 0 ? concat(chunks) : new Uint8Array(0);
}

function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean; returnedBytes: number; totalBytes: number } {
  const bytes = encodeUTF8(text);
  if (bytes.length <= maxBytes) {
    return { text, truncated: false, returnedBytes: bytes.length, totalBytes: bytes.length };
  }
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  const sliced = decodeUTF8(bytes.subarray(0, end));
  return {
    text: `${sliced}\n... [truncated at ${end}/${bytes.length} bytes; pass file filter or larger maxBytes]`,
    truncated: true,
    returnedBytes: end,
    totalBytes: bytes.length,
  };
}

async function runTriageTool(args: Record<string, unknown>, ctx: McpContext) {
  const cwd = ctx.cwd ?? process.cwd();
  const resolved = await resolveDiffInput(args, ctx.readSource);
  const minRisk = parseRisk(args["risk"]);
  const top = typeof args["top"] === "number" && Number.isSafeInteger(args["top"]) && args["top"] >= 1
    ? Math.min(args["top"], 500)
    : undefined;
  const format = args["format"] === "text" || args["format"] === "markdown" ? args["format"] : "json";
  const triage = await analyzeDiffTriage(resolved.diffText, resolved.sourceLabel, cwd, {
    includeLedger: resolved.isGitTarget,
    ...(minRisk !== undefined ? { minRisk } : {}),
    ...(top !== undefined ? { top } : {}),
  });
  const text = format === "markdown"
    ? formatTriageMarkdown(triage)
    : format === "text"
      ? formatTriageReport(triage)
      : JSON.stringify(triage, null, 2);
  return { text, data: triage as unknown as Record<string, unknown> };
}

async function runReadMeatTool(args: Record<string, unknown>, ctx: McpContext) {
  const resolved = await resolveDiffInput(args, ctx.readSource);
  const minRisk = parseRisk(args["risk"]);
  const fileFilter = typeof args["file"] === "string" ? args["file"].trim() : "";
  const maxBytes = typeof args["maxBytes"] === "number" && Number.isSafeInteger(args["maxBytes"])
    ? Math.max(256, Math.min(args["maxBytes"], MAX_ALLOWED_BYTES))
    : DEFAULT_MAX_BYTES;

  let workingDiff = resolved.diffBytes;
  if (minRisk !== undefined) {
    const summaries = summarizeDiffFiles(resolved.diffText);
    const minRank = RISK_RANK[minRisk];
    const allowed = new Set(summaries.filter(f => RISK_RANK[f.risk] >= minRank).map(f => f.file));
    workingDiff = filterDiffByAllowedFiles(workingDiff, allowed);
  }
  if (fileFilter !== "" && workingDiff.length > 0) {
    workingDiff = filterDiffByFile(workingDiff, fileFilter).diff;
  }

  const projected = compileMeatDiff(workingDiff);
  const fullText = projected.lines.length > 0
    ? projected.lines.join("\n") + "\n"
    : workingDiff.length === 0
      ? "(no files matched the requested filter)\n"
      : "(all changed lines were proven imports)\n";
  const bounded = truncateUtf8(fullText, maxBytes);
  const data = {
    source: resolved.sourceLabel,
    fileFilter: fileFilter || null,
    minRisk: minRisk ?? null,
    totalChangedLines: projected.totalChangedLines,
    behavioralLines: projected.behavioralLines,
    importLines: projected.importLines,
    moveLines: projected.moveLines,
    generatedLines: projected.generatedLines,
    exactMovePairs: projected.exactMovePairs,
    omittedFiles: projected.omittedFiles,
    generatedFiles: projected.generatedFiles,
    noiseReductionPct: projected.noiseReductionPct,
    compilerEligible: projected.compilerEligible,
    compilerReason: projected.compilerReason,
    truncated: bounded.truncated,
    returnedBytes: bounded.returnedBytes,
    totalBytes: bounded.totalBytes,
    diffText: bounded.text,
  };
  return { text: bounded.text, data };
}

async function runStatechartTool(args: Record<string, unknown>, ctx: McpContext) {
  const resolved = await resolveDiffInput(args, ctx.readSource);
  const chart = analyzeDiffForStatechart(resolved.diffText, resolved.sourceLabel);
  return {
    text: JSON.stringify(chart, null, 2),
    data: chart as unknown as Record<string, unknown>,
  };
}

async function runEvidenceStatusTool(args: Record<string, unknown>) {
  const cliArgs: string[] = ["--json"];
  if (args["details"] === true) cliArgs.push("--details");
  if (typeof args["task"] === "string" && args["task"].trim() !== "") {
    cliArgs.push("--task", args["task"].trim());
  }
  const status = await runState("status", cliArgs);
  return {
    text: JSON.stringify(status, null, 2),
    data: status as unknown as Record<string, unknown>,
  };
}

function estimateStoreBytes(storeMap: ReadonlyMap<string, unknown>): number {
  let bytes = 0;
  for (const [k, v] of storeMap.entries()) {
    bytes += Buffer.byteLength(k, "utf8");
    bytes += Buffer.byteLength(JSON.stringify(v) ?? "", "utf8");
  }
  return bytes;
}

async function runCodemodeExec(args: Record<string, unknown>, ctx: McpContext) {
  const code = typeof args["code"] === "string" ? args["code"] : "";
  if (code.trim() === "") {
    throw new Error("exec requires a non-empty JavaScript code string.");
  }
  const maxBytes = typeof args["maxBytes"] === "number" && Number.isSafeInteger(args["maxBytes"])
    ? Math.max(256, Math.min(args["maxBytes"], MAX_ALLOWED_BYTES))
    : DEFAULT_MAX_BYTES;
  const kv = ctx.sessionStore ?? new Map<string, unknown>();
  const outputs: string[] = [];
  let toolCalls = 0;

  const cloneForSandbox = <T>(val: T): T => structuredClone(val);

  const toolsProxy = Object.freeze(Object.assign(Object.create(null), {
    triageDiff: async (toolArgs?: unknown) => {
      toolCalls++;
      const res = await runTriageTool(asObject(toolArgs), ctx);
      return cloneForSandbox(res.data);
    },
    readMeatDiff: async (toolArgs?: unknown) => {
      toolCalls++;
      const res = await runReadMeatTool(asObject(toolArgs), ctx);
      return cloneForSandbox(res.data);
    },
    analyzeStatechart: async (toolArgs?: unknown) => {
      toolCalls++;
      const res = await runStatechartTool(asObject(toolArgs), ctx);
      return cloneForSandbox(res.data);
    },
    evidenceStatus: async (toolArgs?: unknown) => {
      toolCalls++;
      const res = await runEvidenceStatusTool(asObject(toolArgs));
      return cloneForSandbox(res.data);
    },
  }));

  const sandbox = Object.assign(Object.create(null), {
    tools: toolsProxy,
    ALL_TOOLS: Object.freeze(structuredClone(SANDBOX_TOOL_CATALOG)),
    text: (output: unknown) => {
      outputs.push(typeof output === "string" ? output : JSON.stringify(output, null, 2));
    },
    store: (key: unknown, value: unknown) => {
      if (typeof key !== "string" || key.trim() === "" || key.length > 128) {
        throw new Error("store(key, value) requires a non-empty string key up to 128 characters.");
      }
      if (!kv.has(key) && kv.size >= MAX_STORE_KEYS) {
        throw new Error(`Session store limit reached (${MAX_STORE_KEYS} keys).`);
      }
      const cloned = structuredClone(value);
      const next = new Map(kv);
      next.set(key, cloned);
      if (estimateStoreBytes(next) > MAX_STORE_BYTES) {
        throw new Error(`Session store exceeds ${MAX_STORE_BYTES} bytes.`);
      }
      kv.set(key, cloned);
    },
    load: (key: unknown) => {
      if (typeof key !== "string") return undefined;
      if (!kv.has(key)) return undefined;
      return structuredClone(kv.get(key));
    },
  });

  const vmContext = vm.createContext(sandbox, {
    name: "columbo-codemode",
    codeGeneration: { strings: false, wasm: false },
  });
  const script = new vm.Script(`(async () => {\n${code}\n})()`, {
    filename: "columbo-exec.js",
  });

  const pending = Promise.resolve(script.runInContext(vmContext, { timeout: EXEC_SYNC_TIMEOUT_MS }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Code Mode execution timed out after ${EXEC_ASYNC_TIMEOUT_MS}ms.`)), EXEC_ASYNC_TIMEOUT_MS);
  });

  let returned: unknown;
  try {
    returned = await Promise.race([pending, timeoutPromise]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  let combined: string;
  if (outputs.length > 0) {
    combined = outputs.join("\n");
  } else if (returned !== undefined) {
    combined = typeof returned === "string" ? returned : JSON.stringify(returned, null, 2);
  } else {
    combined = "";
  }

  const bounded = truncateUtf8(combined, maxBytes);
  const payload = {
    output: bounded.text,
    truncated: bounded.truncated,
    returnedBytes: bounded.returnedBytes,
    totalBytes: bounded.totalBytes,
    toolCalls,
    storedKeys: [...kv.keys()].sort(),
  };
  return {
    content: [{ type: "text" as const, text: bounded.text }],
    structuredContent: payload,
  };
}

async function callTool(name: string, rawArgs: unknown, ctx: McpContext): Promise<{
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}> {
  const args = asObject(rawArgs);

  if (ctx.codemode) {
    if (name !== "exec") {
      throw Object.assign(new Error(`Unknown tool in codemode: ${name} (only exec is exposed)`), { code: -32602 });
    }
    return await runCodemodeExec(args, ctx);
  }

  if (name === "triage_diff") {
    const res = await runTriageTool(args, ctx);
    return { content: [{ type: "text", text: res.text }], structuredContent: res.data };
  }
  if (name === "read_meat_diff") {
    const res = await runReadMeatTool(args, ctx);
    return { content: [{ type: "text", text: res.text }], structuredContent: res.data };
  }
  if (name === "analyze_statechart") {
    const res = await runStatechartTool(args, ctx);
    return { content: [{ type: "text", text: res.text }], structuredContent: res.data };
  }
  if (name === "evidence_status") {
    const res = await runEvidenceStatusTool(args);
    return { content: [{ type: "text", text: res.text }], structuredContent: res.data };
  }

  throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32602 });
}

export async function handleMcpMessage(raw: unknown, ctx: McpContext): Promise<JsonRpcResponse | null> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid JSON-RPC request" } };
  }
  const msg = raw as JsonRpcRequest;
  const hasId = Object.hasOwn(msg, "id") && msg.id !== undefined;
  const id = hasId ? (msg.id ?? null) : null;
  const method = typeof msg.method === "string" ? msg.method : "";

  if (!hasId) {
    return null;
  }

  if (method === "initialize") {
    const params = asObject(msg.params);
    const requested = typeof params["protocolVersion"] === "string" ? params["protocolVersion"] : DEFAULT_PROTOCOL;
    const protocolVersion = SUPPORTED_PROTOCOLS.has(requested) ? requested : DEFAULT_PROTOCOL;
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion,
        capabilities: {
          tools: {},
          resources: {},
        },
        serverInfo: {
          name: ctx.codemode ? "columbo-codemode" : "columbo",
          version: ctx.version,
        },
      },
    };
  }

  if (method === "ping") {
    return { jsonrpc: "2.0", id, result: {} };
  }

  if (method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: ctx.codemode ? MCP_CODEMODE_TOOLS : MCP_TOOLS } };
  }

  if (method === "tools/call") {
    const params = asObject(msg.params);
    const toolName = typeof params["name"] === "string" ? params["name"] : "";
    if (!toolName) {
      return { jsonrpc: "2.0", id, error: { code: -32602, message: "Missing tool name" } };
    }
    try {
      const result = await callTool(toolName, params["arguments"], ctx);
      return { jsonrpc: "2.0", id, result };
    } catch (err) {
      const code = typeof (err as { code?: unknown })?.code === "number" ? (err as { code: number }).code : null;
      const message = err instanceof Error ? err.message : String(err);
      if (code === -32602) {
        return { jsonrpc: "2.0", id, error: { code: -32602, message } };
      }
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: message }],
          isError: true,
        },
      };
    }
  }

  if (method === "resources/list") {
    return { jsonrpc: "2.0", id, result: { resources: MCP_RESOURCES } };
  }

  if (method === "resources/read") {
    const params = asObject(msg.params);
    const uri = typeof params["uri"] === "string" ? params["uri"] : "";
    if (uri === "columbo://guide") {
      return {
        jsonrpc: "2.0",
        id,
        result: { contents: [{ uri, mimeType: "text/plain", text: ctx.guideText }] },
      };
    }
    if (uri === "columbo://triage-schema") {
      return {
        jsonrpc: "2.0",
        id,
        result: { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(TRIAGE_SCHEMA_DOC, null, 2) }] },
      };
    }
    return { jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown resource URI: ${uri}` } };
  }

  return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
}

export async function runMcpStdioServer(ctx: McpContext): Promise<number> {
  const sessionCtx: McpContext = {
    ...ctx,
    sessionStore: ctx.sessionStore ?? new Map<string, unknown>(),
  };
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const writeLine = (resp: JsonRpcResponse) => {
    process.stdout.write(JSON.stringify(resp) + "\n");
  };

  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (line === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      writeLine({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error: invalid JSON" } });
      continue;
    }
    if (Array.isArray(parsed)) {
      const responses: JsonRpcResponse[] = [];
      for (const item of parsed) {
        const res = await handleMcpMessage(item, sessionCtx);
        if (res !== null) responses.push(res);
      }
      if (responses.length > 0) {
        process.stdout.write(JSON.stringify(responses) + "\n");
      }
      continue;
    }
    const response = await handleMcpMessage(parsed, sessionCtx);
    if (response !== null) writeLine(response);
  }
  return 0;
}
