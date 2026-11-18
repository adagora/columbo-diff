export type EvidenceLabel = "Proposed" | "Implementation-traced" | "Diff-traced" | "Model-checked";

export type EdgeKind = "normal" | "added" | "removed" | "failure" | "unknown";

export interface StateNode {
  id: string;
  label: string;
  kind: "start" | "state" | "error" | "end";
  sourceRef?: string;
}

export interface StateEdge {
  id: string;
  from: string;
  to: string;
  label: string;
  kind: EdgeKind;
  sourceRef?: string;
}

export interface FailureStep {
  step: number;
  title: string;
  detail: string;
  activeNodeId: string;
  activeEdgeId?: string;
}

export interface TransitionDeltaItem {
  change: "added" | "removed" | "guard" | "unknown";
  summary: string;
  file: string;
}

export interface StatechartArtifact {
  id: string;
  title: string;
  question: string;
  evidenceLabel: EvidenceLabel;
  tlaNote: string;
  shouldGenerate: boolean;
  triggerReason: string;
  signals: {
    filesChanged: number;
    stateMutations: number;
    errorPaths: number;
    asyncConcurrency: number;
    retryCancel: number;
    branchGuards: number;
    removedGuards: number;
  };
  sourceRefs: string[];
  invariants: string[];
  nodes: StateNode[];
  edges: StateEdge[];
  transitionDelta: TransitionDeltaItem[];
  failureWalkthrough: FailureStep[];
  omissions: string[];
  mermaid: string;
}

interface ParsedFileSignals {
  file: string;
  addedLines: string[];
  removedLines: string[];
  hunks: string[];
}

function unquoteGitPath(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed
      .slice(1, -1)
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
  return trimmed;
}

function stripGitPrefix(raw: string): string {
  const unquoted = unquoteGitPath(raw);
  if (unquoted.startsWith("a/") || unquoted.startsWith("b/")) {
    return unquoted.slice(2);
  }
  return unquoted;
}

export function parseDiffGitHeader(line: string): string | null {
  if (!line.startsWith("diff --git ")) return null;
  const rest = line.slice(11).trim();
  const quoted = /^"(?:\\.|[^"])+"\s+"((?:\\.|[^"])+)"$/.exec(rest);
  if (quoted?.[1]) return stripGitPrefix(`"${quoted[1]}"`);
  const plain = /^a\/(.+?)\s+b\/(.+)$/.exec(rest);
  if (plain?.[2]) return plain[2].trim();
  return stripGitPrefix(rest);
}

export function parsePlusHeader(line: string): string | null {
  if (!line.startsWith("+++ ")) return null;
  const target = line.slice(4).split("\t")[0]?.trim() ?? "";
  if (!target || target === "/dev/null") return null;
  return stripGitPrefix(target);
}

export function parseMinusHeader(line: string): string | null {
  if (!line.startsWith("--- ")) return null;
  const target = line.slice(4).split("\t")[0]?.trim() ?? "";
  if (!target || target === "/dev/null") return null;
  return stripGitPrefix(target);
}

function sanitizeMermaidId(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_]/g, "_");
  if (!cleaned || /^[0-9]/.test(cleaned)) return `s_${cleaned}`;
  return cleaned;
}

function escapeMermaidLabel(text: string): string {
  return text.replace(/"/g, "'").replace(/\r?\n/g, " ").trim();
}

export function renderMermaidStatechart(nodes: readonly StateNode[], edges: readonly StateEdge[]): string {
  const lines: string[] = ["stateDiagram-v2"];
  for (const node of nodes) {
    if (node.kind === "start") continue;
    lines.push(`    ${sanitizeMermaidId(node.id)} : ${escapeMermaidLabel(node.label)}`);
  }
  for (const edge of edges) {
    const fromNode = nodes.find(n => n.id === edge.from);
    const toNode = nodes.find(n => n.id === edge.to);
    const fromId = fromNode?.kind === "start" ? "[*]" : sanitizeMermaidId(edge.from);
    const toId = toNode?.kind === "end" ? "[*]" : sanitizeMermaidId(edge.to);
    const prefix =
      edge.kind === "added" ? "[+] " :
      edge.kind === "removed" ? "[-] " :
      edge.kind === "failure" ? "[!] " :
      edge.kind === "unknown" ? "[?] " : "";
    lines.push(`    ${fromId} --> ${toId} : ${prefix}${escapeMermaidLabel(edge.label)}`);
  }
  return lines.join("\n");
}

function parseDiffFiles(diffText: string): ParsedFileSignals[] {
  const files: ParsedFileSignals[] = [];
  let current: ParsedFileSignals | null = null;
  let inHunk = false;
  for (const rawLine of diffText.split(/\r?\n/)) {
    const gitFile = parseDiffGitHeader(rawLine);
    if (gitFile !== null) {
      inHunk = false;
      current = { file: gitFile, addedLines: [], removedLines: [], hunks: [] };
      files.push(current);
      continue;
    }
    if (!inHunk && rawLine.startsWith("--- ")) {
      const minusFile = parseMinusHeader(rawLine);
      if (minusFile && !current) {
        current = { file: minusFile, addedLines: [], removedLines: [], hunks: [] };
        files.push(current);
      }
      continue;
    }
    if ((!inHunk && rawLine.startsWith("+++ ")) || rawLine.startsWith("+++ b/") || rawLine.startsWith('+++ "b/')) {
      inHunk = false;
      const plusFile = parsePlusHeader(rawLine);
      if (plusFile) {
        if (!current) {
          current = { file: plusFile, addedLines: [], removedLines: [], hunks: [] };
          files.push(current);
        } else {
          current.file = plusFile;
        }
      }
      continue;
    }
    if (!inHunk && (rawLine.startsWith("index ") || rawLine.startsWith("new file ") || rawLine.startsWith("deleted file ") || rawLine.startsWith("old mode ") || rawLine.startsWith("new mode ") || rawLine.startsWith("rename ") || rawLine.startsWith("similarity "))) {
      continue;
    }
    if (rawLine.startsWith("@@ ")) {
      inHunk = true;
      if (!current) {
        current = { file: "input.diff", addedLines: [], removedLines: [], hunks: [] };
        files.push(current);
      }
      const header = /^@@[^@]*@@\s*(.*)$/.exec(rawLine)?.[1]?.trim() ?? "";
      if (header) current.hunks.push(header);
      continue;
    }
    if (!inHunk || !current) continue;
    if (rawLine.startsWith("+") && !rawLine.startsWith("+++")) {
      current.addedLines.push(rawLine.slice(1));
    } else if (rawLine.startsWith("-") && !rawLine.startsWith("---")) {
      current.removedLines.push(rawLine.slice(1));
    }
  }
  return files;
}

export const stateMutationRe = /\b(state|status|phase|stage|mode|step|ready|closed|pending|active|done|failed)\b\s*[:=]/i;
export const errorHandlingRe = /\b(try|catch|except|finally|throw|raise|panic|recover|reject|Err|Error|SnapshotError|CLIError|IS_ERR|IS_ERR_OR_NULL|ERR_PTR|PTR_ERR|WARN_ON|WARN_ON_ONCE|BUG_ON)\b|\bgoto\s+(?:err|out|fail|unlock|cleanup)\w*\b|-E(?:INVAL|NOMEM|BUSY|TIMEDOUT|IO|AGAIN|NOENT|FAULT|PERM|ACCES|NODEV|PROTO|PIPE|NOSPC|EXIST|RANGE|NOTSUPP|OPNOTSUPP)\b/;
export const asyncConcurrencyRe = /\b(async|await|Promise|lock|mutex|atomic|race|spawn|channel|select|go\s+func|tokio|spin_lock\w*|spin_unlock\w*|mutex_lock\w*|mutex_unlock\w*|rwlock\w*|rcu_read_lock|rcu_assign_pointer|smp_mb|smp_wmb|smp_rmb)\b/;
export const retryCancelRe = /(retry|retries|attempt|backoff|timeout|deadline|cancel|abort|signal)/i;
export const branchGuardRe = /^\s*(if|else if|elif|switch|match|case)\b/;

function summarizeSnippet(line: string, fallback: string): string {
  const compact = line.trim().replace(/\s+/g, " ");
  if (!compact) return fallback;
  return compact.length > 56 ? `${compact.slice(0, 53)}...` : compact;
}

export function analyzeDiffForStatechart(diffText: string, label = "Uploaded diff"): StatechartArtifact {
  const files = parseDiffFiles(diffText);
  let stateMutations = 0;
  let errorPaths = 0;
  let asyncConcurrency = 0;
  let retryCancel = 0;
  let branchGuards = 0;
  let removedGuards = 0;

  const transitionDelta: TransitionDeltaItem[] = [];
  const primaryFunctions: string[] = [];
  const perFileStats: {
    file: string;
    state: number;
    error: number;
    async: number;
    retry: number;
    guard: number;
    removedGuard: number;
    churn: number;
    firstHunk: string | null;
  }[] = [];

  for (const file of files) {
    let fState = 0;
    let fError = 0;
    let fAsync = 0;
    let fRetry = 0;
    let fGuard = 0;
    let fRemovedGuard = 0;

    for (const h of file.hunks) {
      if (!primaryFunctions.includes(h) && primaryFunctions.length < 4) primaryFunctions.push(h);
    }
    for (const line of file.addedLines) {
      if (stateMutationRe.test(line)) {
        stateMutations++;
        fState++;
        if (transitionDelta.length < 6) {
          transitionDelta.push({ change: "added", summary: `State assignment: ${summarizeSnippet(line, "state update")}`, file: file.file });
        }
      }
      if (errorHandlingRe.test(line)) {
        errorPaths++;
        fError++;
        if (transitionDelta.length < 6) {
          transitionDelta.push({ change: "added", summary: `Error / recovery path: ${summarizeSnippet(line, "error check")}`, file: file.file });
        }
      }
      if (asyncConcurrencyRe.test(line)) {
        asyncConcurrency++;
        fAsync++;
      }
      if (retryCancelRe.test(line)) {
        retryCancel++;
        fRetry++;
        if (transitionDelta.length < 6) {
          transitionDelta.push({ change: "guard", summary: `Retry / timeout / cancel guard: ${summarizeSnippet(line, "retry/cancel")}`, file: file.file });
        }
      }
      if (branchGuardRe.test(line)) {
        branchGuards++;
        fGuard++;
        if (transitionDelta.length < 6 && !errorHandlingRe.test(line) && !stateMutationRe.test(line)) {
          transitionDelta.push({ change: "guard", summary: `Branch guard: ${summarizeSnippet(line, "condition")}`, file: file.file });
        }
      }
    }
    for (const line of file.removedLines) {
      const removedBranch = branchGuardRe.test(line);
      if (removedBranch) {
        removedGuards++;
        fRemovedGuard++;
      }
      if (removedBranch || stateMutationRe.test(line) || errorHandlingRe.test(line) || retryCancelRe.test(line)) {
        if (transitionDelta.length < 8) {
          const prefix = removedBranch ? "Removed branch guard" : "Removed check/transition";
          transitionDelta.push({ change: "removed", summary: `${prefix}: ${summarizeSnippet(line, "removed branch")}`, file: file.file });
        }
      }
    }
    perFileStats.push({
      file: file.file,
      state: fState,
      error: fError,
      async: fAsync,
      retry: fRetry,
      guard: fGuard,
      removedGuard: fRemovedGuard,
      churn: file.addedLines.length + file.removedLines.length,
      firstHunk: file.hunks[0] ?? null,
    });
  }

  const totalSignals = stateMutations + errorPaths + asyncConcurrency + retryCancel + removedGuards;
  const shouldGenerate = totalSignals >= 2 || removedGuards >= 1 || (errorPaths >= 1 && branchGuards >= 2);
  const triggerReason = shouldGenerate
    ? `Recommended: detected ${errorPaths} error/recovery lines, ${branchGuards} branch guards, ${removedGuards} removed guard(s), ${stateMutations} state updates, ${retryCancel} retry/cancel cues, and ${asyncConcurrency} async/concurrency cues across ${files.length} file(s).`
    : files.length === 0
      ? "Skipped by default: input has no unified diff hunks. Paste a unified git diff or pick a sample diff."
      : `Optional / low signal: only ${totalSignals} state or failure signals across ${files.length} file(s); prose or the raw diff is usually enough.`;

  const pickBest = (score: (s: (typeof perFileStats)[number]) => number, fallback: string): (typeof perFileStats)[number] | null => {
    if (perFileStats.length === 0) return null;
    const sorted = [...perFileStats].sort((a, b) => (score(b) - score(a)) || (b.churn - a.churn));
    return score(sorted[0]!) > 0 ? sorted[0]! : perFileStats.find(s => s.file === fallback) ?? sorted[0]!;
  };

  const primaryStat = pickBest(
    s => s.removedGuard * 3 + s.error * 2 + s.state * 2 + s.retry * 2 + s.async + s.guard,
    files[0]?.file ?? label,
  );
  const primaryFile = primaryStat?.file ?? files[0]?.file ?? label;
  const bestStateStat = pickBest(s => s.state * 2 + s.async, primaryFile);
  const bestGuardStat = pickBest(s => s.removedGuard * 3 + s.guard, primaryFile);
  const bestErrorStat = pickBest(s => s.error * 2 + s.retry * 2 + s.removedGuard * 2, primaryFile);

  const execFile = bestStateStat?.file ?? primaryFile;
  const guardFile = bestGuardStat?.file ?? primaryFile;
  const errorFile = bestErrorStat?.file ?? primaryFile;
  const entryHunk = bestStateStat?.firstHunk ?? primaryStat?.firstHunk ?? primaryFunctions[0] ?? null;
  const entryLabel = entryHunk ? summarizeSnippet(entryHunk, "Entry") : `Invoke ${execFile}`;

  const hasAddedError = files.some(f => f.addedLines.some(l => errorHandlingRe.test(l)));
  const hasRemovedGuard = removedGuards > 0 || transitionDelta.some(d => d.change === "removed");
  const hasRetry = retryCancel > 0;
  const hasAsync = asyncConcurrency > 0;

  const nodes: StateNode[] = [
    { id: "start", label: "Start", kind: "start" },
    { id: "idle", label: "Caller / Initial State", kind: "state" },
    { id: "executing", label: entryLabel, kind: "state", sourceRef: execFile },
    { id: "guarded", label: branchGuards > 0 || removedGuards > 0 ? "Guard / Validation Check" : "Execute Path", kind: "state", sourceRef: guardFile },
    { id: "completed", label: "Updated Result Returned", kind: "state", sourceRef: primaryFile },
    { id: "failed", label: hasAddedError ? "Handled Error / Recovery" : "Error / Rejection Path", kind: "error", sourceRef: errorFile },
  ];

  const edges: StateEdge[] = [
    { id: "e_enter", from: "start", to: "idle", label: "request / call", kind: "normal" },
    { id: "e_dispatch", from: "idle", to: "executing", label: `enter ${execFile}`, kind: "normal", sourceRef: execFile },
    { id: "e_guard", from: "executing", to: "guarded", label: branchGuards > 0 ? `${branchGuards} branch guard(s)` : "run step", kind: branchGuards > 0 ? "added" : "normal", sourceRef: guardFile },
    { id: "e_ok", from: "guarded", to: "completed", label: stateMutations > 0 ? "commit state update" : "return result", kind: stateMutations > 0 ? "added" : "normal", sourceRef: primaryFile },
    {
      id: "e_fail",
      from: "guarded",
      to: "failed",
      label: hasAddedError ? "new error / recovery edge" : "exception or failure",
      kind: hasAddedError ? "added" : "failure",
      sourceRef: errorFile,
    },
  ];

  if (hasRetry) {
    edges.push({
      id: "e_retry",
      from: "failed",
      to: "executing",
      label: "retry / backoff / reset",
      kind: "failure",
      sourceRef: errorFile,
    });
  }

  if (hasRemovedGuard) {
    edges.push({
      id: "e_removed",
      from: "executing",
      to: "failed",
      label: removedGuards > 0 ? `removed ${removedGuards} guard(s) (verify caller)` : "removed old guard (verify caller)",
      kind: "removed",
      sourceRef: guardFile,
    });
  }

  edges.push({
    id: "e_unknown",
    from: "completed",
    to: "idle",
    label: hasAsync ? "concurrent callers / next event (uninspected)" : "caller handling outside diff (unknown)",
    kind: "unknown",
  });

  if (transitionDelta.length === 0 && files.length > 0) {
    transitionDelta.push({
      change: "unknown",
      summary: "Diff contains few explicit state/error keywords; inspect surrounding callers before assuming invariants.",
      file: primaryFile,
    });
  }

  const invariants = [
    "Every error or rejection edge leaves shared state consistent (no half-applied mutation).",
    hasRetry
      ? "Retries or timeouts are bounded and cannot duplicate side effects."
      : "Removed or modified branch guards still reject invalid caller inputs.",
    hasAsync
      ? "Concurrent or awaited operations respect cancellation and ordering."
      : "Callers outside this diff handle the updated return/error contract.",
  ];

  const failureWalkthrough: FailureStep[] = [
    {
      step: 1,
      title: "Enter changed path",
      detail: `Caller invokes ${execFile} (${entryLabel}).`,
      activeNodeId: "executing",
      activeEdgeId: "e_dispatch",
    },
    {
      step: 2,
      title: "Hit changed guard / condition",
      detail: branchGuards > 0 || removedGuards > 0
        ? `Execution evaluates ${branchGuards} added and ${removedGuards} removed conditional branch(es) inside ${guardFile}.`
        : `Execution reaches the modified logic block in ${guardFile}.`,
      activeNodeId: "guarded",
      activeEdgeId: "e_guard",
    },
    {
      step: 3,
      title: hasRemovedGuard ? "Check removed guard vs new error path" : "Trigger failure / recovery path",
      detail: hasRemovedGuard
        ? `Because the diff removed an older check or error path (${guardFile}), verify whether invalid inputs now reach the failure handler or fall through.`
        : hasAddedError
          ? `The diff introduces an explicit error/recovery edge in ${errorFile}; verify cleanup and caller expectations.`
          : `Verify what happens in ${errorFile} if a dependency fails or times out before returning.`,
      activeNodeId: "failed",
      activeEdgeId: hasRemovedGuard ? "e_removed" : "e_fail",
    },
    {
      step: 4,
      title: "Inspect boundary outside diff",
      detail: "A diff-traced chart cannot see uninspected callers or runtime races; confirm surrounding context before approving.",
      activeNodeId: "idle",
      activeEdgeId: "e_unknown",
    },
  ];

  const omissions = [
    "Extracted mechanically from unified diff hunks without full-repository call-graph analysis.",
    "TLA+ / TLC was not run; invariants and caller-side behavior remain unverified.",
    ...files.slice(0, 3).map(f => `${f.file}: +${f.addedLines.length} / -${f.removedLines.length} lines inspected`),
  ];

  return {
    id: "diff-analysis",
    title: `Diff reading view: ${label}`,
    question: "Which state/error paths changed in this diff, and what failure scenario should a reviewer check?",
    evidenceLabel: "Diff-traced",
    tlaNote: "TLA+ / TLC is not installed or run. This chart is generated deterministically from the diff text to speed up human review, not to claim formal proof.",
    shouldGenerate,
    triggerReason,
    signals: {
      filesChanged: files.length,
      stateMutations,
      errorPaths,
      asyncConcurrency,
      retryCancel,
      branchGuards,
      removedGuards,
    },
    sourceRefs: files.map(f => f.file),
    invariants,
    nodes,
    edges,
    transitionDelta,
    failureWalkthrough,
    omissions,
    mermaid: renderMermaidStatechart(nodes, edges),
  };
}

export function getReferenceStatecharts(): StatechartArtifact[] {
  const snapshotNodes: StateNode[] = [
    { id: "start", label: "Start", kind: "start" },
    { id: "ready", label: "Collect Mutable Snapshot", kind: "state", sourceRef: "src/cli/snapshot.ts:collectSnapshot" },
    { id: "attempt1", label: "Attempt 1: Read HEAD, Index, Diff x2", kind: "state", sourceRef: "src/cli/snapshot.ts:134-147" },
    { id: "retry", label: "Mismatch Detected -> Retry Once", kind: "state", sourceRef: "src/cli/snapshot.ts:134" },
    { id: "attempt2", label: "Attempt 2: Read HEAD, Index, Diff x2", kind: "state", sourceRef: "src/cli/snapshot.ts:134-147" },
    { id: "captured", label: "Snapshot Retained (context: unavailable)", kind: "state", sourceRef: "src/cli/snapshot.ts:143-146" },
    { id: "aborted", label: "SnapshotError(source_changed)", kind: "error", sourceRef: "src/cli/snapshot.ts:149" },
  ];

  const snapshotEdges: StateEdge[] = [
    { id: "s_start", from: "start", to: "ready", label: "-staged or -worktree", kind: "normal" },
    { id: "s_a1", from: "ready", to: "attempt1", label: "capture before/after", kind: "normal", sourceRef: "src/cli/snapshot.ts:135-142" },
    { id: "s_ok1", from: "attempt1", to: "captured", label: "HEAD, index & diff x2 match", kind: "added", sourceRef: "src/cli/snapshot.ts:143" },
    { id: "s_race1", from: "attempt1", to: "retry", label: "race detected (mismatch)", kind: "failure", sourceRef: "src/cli/snapshot.ts:143" },
    { id: "s_a2", from: "retry", to: "attempt2", label: "attempt = 1 (final try)", kind: "normal", sourceRef: "src/cli/snapshot.ts:134" },
    { id: "s_ok2", from: "attempt2", to: "captured", label: "second capture consistent", kind: "normal", sourceRef: "src/cli/snapshot.ts:143" },
    { id: "s_fail", from: "attempt2", to: "aborted", label: "persistent mismatch", kind: "failure", sourceRef: "src/cli/snapshot.ts:149" },
    { id: "s_fs", from: "captured", to: "ready", label: "worktree file edits outside capture (unknown)", kind: "unknown" },
  ];

  const stateNodes: StateNode[] = [
    { id: "start", label: "Start", kind: "start" },
    { id: "validate", label: "Validate Schema & Task Ref", kind: "state", sourceRef: "src/cli/state.ts:parseRecord" },
    { id: "checkDup", label: "Check Existing ID", kind: "state", sourceRef: "src/cli/state.ts:232-236" },
    { id: "verifyHash", label: "Verify File SHA-256 Fingerprints", kind: "state", sourceRef: "src/cli/state.ts:238-243" },
    { id: "stageTmp", label: "Write Exclusive Temp File (wx)", kind: "state", sourceRef: "src/cli/state.ts:249-250" },
    { id: "linkTarget", label: "Atomic Hardlink to <id>.json", kind: "state", sourceRef: "src/cli/state.ts:link" },
    { id: "stored", label: "Immutable Record Stored", kind: "state", sourceRef: "src/cli/state.ts:runState" },
    { id: "conflict", label: "Rejected: conflict or stale hash", kind: "error", sourceRef: "src/cli/state.ts:234,241" },
  ];

  const stateEdges: StateEdge[] = [
    { id: "r_in", from: "start", to: "validate", label: "columbo record --file", kind: "normal" },
    { id: "r_dup", from: "validate", to: "checkDup", label: "schema & task valid", kind: "normal" },
    { id: "r_idem", from: "checkDup", to: "stored", label: "identical JSON (idempotent)", kind: "added", sourceRef: "src/cli/state.ts:235" },
    { id: "r_conf1", from: "checkDup", to: "conflict", label: "same ID, different body", kind: "failure", sourceRef: "src/cli/state.ts:234" },
    { id: "r_hash", from: "checkDup", to: "verifyHash", label: "new ID", kind: "normal" },
    { id: "r_stale", from: "verifyHash", to: "conflict", label: "file changed since snapshot", kind: "failure", sourceRef: "src/cli/state.ts:241" },
    { id: "r_tmp", from: "verifyHash", to: "stageTmp", label: "hashes match", kind: "normal" },
    { id: "r_link", from: "stageTmp", to: "linkTarget", label: "fs.link exclusive publish", kind: "added" },
    { id: "r_win", from: "linkTarget", to: "stored", label: "publish succeeds", kind: "normal" },
    { id: "r_race", from: "linkTarget", to: "conflict", label: "EEXIST from concurrent writer", kind: "failure" },
  ];

  const editPlanNodes: StateNode[] = [
    { id: "start", label: "Start", kind: "start" },
    { id: "ingest", label: "Ingest Diff Bytes & Plan", kind: "state", sourceRef: "src/meat/editplan.ts:compileSubmissionMoves" },
    { id: "validate", label: "Validate Coordinates, Moves & Python Rules", kind: "state", sourceRef: "src/meat/editplan.ts:compileEditPlanMoves" },
    { id: "compiled", label: "Compiled Reading Diff", kind: "state", sourceRef: "src/meat/editplan.ts:116" },
    { id: "rejected", label: "EditPlanErrors (Feedback to Model)", kind: "error", sourceRef: "src/meat/editplan.ts:159" },
    { id: "fallback", label: "Fallback: Original Diff Retained", kind: "state", sourceRef: "src/meat/meat.ts" },
  ];

  const editPlanEdges: StateEdge[] = [
    { id: "p_in", from: "start", to: "ingest", label: "model submits JSON plan", kind: "normal" },
    { id: "p_val", from: "ingest", to: "validate", label: "encode UTF-8 replacements", kind: "normal" },
    { id: "p_ok", from: "validate", to: "compiled", label: "all gates pass", kind: "added" },
    { id: "p_bad", from: "validate", to: "rejected", label: "overlap / broken move / syntax", kind: "failure" },
    { id: "p_retry", from: "rejected", to: "ingest", label: "model retries within chunk limit", kind: "normal" },
    { id: "p_fall", from: "rejected", to: "fallback", label: "budget exhausted", kind: "removed" },
    { id: "p_cross", from: "compiled", to: "fallback", label: "cross-chunk move symmetry (unchecked)", kind: "unknown" },
  ];

  return [
    {
      id: "snapshot-mutable-capture",
      title: "Mutable Snapshot Race Guard (src/cli/snapshot.ts)",
      question: "How does Columbo avoid silently capturing a torn staged/worktree diff when files change mid-command?",
      evidenceLabel: "Implementation-traced",
      tlaNote: "TLA+ / TLC not installed. Even without TLC, tracing the 2-attempt capture loop immediately shows both the retry boundary and the unverified filesystem window.",
      shouldGenerate: true,
      triggerReason: "High value: involves a retry loop, consistency invariants across 4 git probes, and a race-rejection boundary.",
      signals: { filesChanged: 1, stateMutations: 2, errorPaths: 2, asyncConcurrency: 1, retryCancel: 2, branchGuards: 3, removedGuards: 0 },
      sourceRefs: ["src/cli/snapshot.ts:93-150", "test/cli/snapshot.test.ts"],
      invariants: [
        "A retained mutable snapshot never pairs a mismatched HEAD, index digest, or repeated diff output.",
        "Captured context is always labelled unavailable/unverified (never advertised as an atomic filesystem snapshot).",
        "At most 2 capture attempts run; no unbounded retry loop can hang the CLI.",
      ],
      nodes: snapshotNodes,
      edges: snapshotEdges,
      transitionDelta: [
        { change: "added", summary: "Compare HEAD + ls-files --stage + two diff invocations per attempt", file: "src/cli/snapshot.ts" },
        { change: "guard", summary: "Retry at most once (attempt < 2) before failing with source_changed", file: "src/cli/snapshot.ts" },
        { change: "unknown", summary: "Untracked files and live checkout reads in engine tools remain outside snapshot", file: "src/cli/snapshot.ts" },
      ],
      failureWalkthrough: [
        {
          step: 1,
          title: "First capture starts",
          detail: "collectSnapshot reads HEAD, index digest, and runs git diff twice.",
          activeNodeId: "attempt1",
          activeEdgeId: "s_a1",
        },
        {
          step: 2,
          title: "User or watcher edits index mid-read",
          detail: "diff !== repeated or indexBefore !== indexAfter triggers retry path.",
          activeNodeId: "retry",
          activeEdgeId: "s_race1",
        },
        {
          step: 3,
          title: "Second attempt also observes mutation",
          detail: "Attempt 2 runs the same checks; a second mismatch prevents returning a torn diff.",
          activeNodeId: "attempt2",
          activeEdgeId: "s_a2",
        },
        {
          step: 4,
          title: "Fail closed with SnapshotError",
          detail: "Throws SnapshotError('source_changed') instead of silently serving stale or mixed bytes.",
          activeNodeId: "aborted",
          activeEdgeId: "s_fail",
        },
      ],
      omissions: [
        "Git object locks and OS filesystem atomicity are not modelled.",
        "If TLA+ were run, it could explore arbitrary interleavings between git ls-files and git diff processes.",
      ],
      mermaid: renderMermaidStatechart(snapshotNodes, snapshotEdges),
    },
    {
      id: "state-record-publish",
      title: "Atomic Local State Publication (src/cli/state.ts)",
      question: "What prevents concurrent agents from silently overwriting each other's columbo-state-v1 records?",
      evidenceLabel: "Implementation-traced",
      tlaNote: "TLA+ / TLC not installed. Traced from source; concurrent link races are checked here without formal model checking.",
      shouldGenerate: true,
      triggerReason: "High value: concurrent writers, fingerprint freshness validation, and immutable append-only invariants.",
      signals: { filesChanged: 1, stateMutations: 2, errorPaths: 3, asyncConcurrency: 2, retryCancel: 0, branchGuards: 4, removedGuards: 0 },
      sourceRefs: ["src/cli/state.ts:208-265", "test/cli/state.test.ts"],
      invariants: [
        "Existing record IDs are immutable: writing different content under an existing ID fails.",
        "Evidence cannot be recorded if supporting file bytes changed since columbo snapshot.",
        "Concurrent writers racing on the same new ID cannot silently overwrite each other (fs.link EEXIST).",
      ],
      nodes: stateNodes,
      edges: stateEdges,
      transitionDelta: [
        { change: "added", summary: "Exclusive temp file (wx) + fs.link publish preserves first writer", file: "src/cli/state.ts" },
        { change: "guard", summary: "Re-hashes every source file before committing an evidence record", file: "src/cli/state.ts" },
      ],
      failureWalkthrough: [
        {
          step: 1,
          title: "Agent B passes initial ID check",
          detail: "Both Agent A and Agent B inspect directory before either writes <id>.json.",
          activeNodeId: "verifyHash",
          activeEdgeId: "r_hash",
        },
        {
          step: 2,
          title: "Agent B writes private temp file",
          detail: "writeFile(..., { flag: 'wx' }) succeeds in its own UUID temp path.",
          activeNodeId: "stageTmp",
          activeEdgeId: "r_tmp",
        },
        {
          step: 3,
          title: "Agent A links <id>.json first; Agent B hits EEXIST",
          detail: "Atomic hardlink fails for the second writer instead of clobbering Agent A's record.",
          activeNodeId: "conflict",
          activeEdgeId: "r_race",
        },
      ],
      omissions: [
        "Does not model cross-worktree synchronization or manual edits inside .git/columbo-state-v1.",
      ],
      mermaid: renderMermaidStatechart(stateNodes, stateEdges),
    },
    {
      id: "editplan-compiler",
      title: "Edit-Plan Compiler & Fallback (src/meat/editplan.ts)",
      question: "What guarantees does the compiler actually enforce before emitting a reading diff?",
      evidenceLabel: "Implementation-traced",
      tlaNote: "TLA+ / TLC not installed. Byte invariants are covered by conformance vectors in test/conformance.test.ts.",
      shouldGenerate: true,
      triggerReason: "High value: multi-gate validation, model retry loop, and fallback vs compiled distinction.",
      signals: { filesChanged: 1, stateMutations: 1, errorPaths: 2, asyncConcurrency: 0, retryCancel: 1, branchGuards: 4, removedGuards: 0 },
      sourceRefs: ["src/meat/editplan.ts:141-180", "src/meat/meat.ts"],
      invariants: [
        "Model never writes raw diff text directly; every output byte derives from original diff or validated replacements.",
        "Failed plans never emit partial/corrupted smartDiff bytes; chunk either retries or falls back to original diff.",
      ],
      nodes: editPlanNodes,
      edges: editPlanEdges,
      transitionDelta: [
        { change: "guard", summary: "Aggregates summary errors and plan coordinate/syntax errors together", file: "src/meat/editplan.ts" },
        { change: "unknown", summary: "Cross-chunk move symmetry is not enforced globally across chunks", file: "src/meat/chunk.ts" },
      ],
      failureWalkthrough: [
        {
          step: 1,
          title: "Model submits edit plan",
          detail: "Coordinates reference original diff lines; replacements arrive as strings and become Uint8Array.",
          activeNodeId: "ingest",
          activeEdgeId: "p_in",
        },
        {
          step: 2,
          title: "Validation rejects broken move or overlap",
          detail: "Compiler collects deterministic diagnostics and returns them as model feedback.",
          activeNodeId: "rejected",
          activeEdgeId: "p_bad",
        },
        {
          step: 3,
          title: "Chunk budget exhausted -> safe fallback",
          detail: "Original chunk diff is preserved rather than emitting an unvalidated abridgment.",
          activeNodeId: "fallback",
          activeEdgeId: "p_fall",
        },
      ],
      omissions: [
        "Semantic summary accuracy and whether tests pass after edits are outside compiler scope.",
      ],
      mermaid: renderMermaidStatechart(editPlanNodes, editPlanEdges),
    },
  ];
}

export function formatStatechartReport(artifact: StatechartArtifact): string {
  const lines: string[] = [
    artifact.title,
    `Evidence: ${artifact.evidenceLabel} (${artifact.tlaNote})`,
    `Verdict: ${artifact.triggerReason}`,
    `Signals: files=${artifact.signals.filesChanged}, state=${artifact.signals.stateMutations}, errors=${artifact.signals.errorPaths}, async=${artifact.signals.asyncConcurrency}, retry_cancel=${artifact.signals.retryCancel}, guards=${artifact.signals.branchGuards}, removed_guards=${artifact.signals.removedGuards}`,
    "",
    "Invariants to check:",
    ...artifact.invariants.map(item => `- ${item}`),
    "",
    "Transition delta:",
    ...artifact.transitionDelta.map(item => `- [${item.change}] ${item.file}: ${item.summary}`),
    "",
    "Failure walkthrough:",
    ...artifact.failureWalkthrough.map(step => `${step.step}. ${step.title} — ${step.detail}`),
    "",
    "Starter Mermaid (replace generic node names with real domain states when tracing source):",
    "```mermaid",
    artifact.mermaid,
    "```",
  ];
  return lines.join("\n") + "\n";
}

