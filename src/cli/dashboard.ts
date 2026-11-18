import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { decodeUTF8, encodeUTF8 } from "../meat/bytes.ts";
import { fitsSingleRun, maxTotalDiffBytes, splitDiffForAbridging } from "../meat/chunk.ts";
import { analyzeDiff, isHunkSource, splitSourceLines, validateSupportedDiff } from "../meat/diff.ts";
import { mandatoryImportRemovalPlan, mandatoryRemovalMask } from "../meat/imports.ts";
import { maxDiffBytes } from "../meat/meat.ts";
import { applyMandatoryMovePrecedence, detectExactMoves } from "../meat/moves.ts";
import { newToolbox, submit } from "../meat/tools.ts";
import { collectDoctorFacts, type DoctorFacts } from "./doctor.ts";
import { isGeneratedOrLockfile, observeDiffShape } from "./shape.ts";
import { runState } from "./state.ts";
import {
  analyzeDiffForStatechart,
  asyncConcurrencyRe,
  branchGuardRe,
  errorHandlingRe,
  parseDiffGitHeader,
  parseMinusHeader,
  parsePlusHeader,
  retryCancelRe,
  stateMutationRe,
  type StatechartArtifact,
} from "./statechart.ts";

export interface FileDiffSummary {
  file: string;
  adds: number;
  deletes: number;
  hunks: number;
  stateSignals: number;
  errorSignals: number;
  retrySignals: number;
  asyncSignals: number;
  guardSignals: number;
  removedGuardSignals: number;
  importLines: number;
  moveLines: number;
  behavioralLines: number;
  risk: "high" | "medium" | "low";
  patch: string;
  meatPatch: string;
}

export interface MovePairSummary {
  removedFile: string;
  addedFile: string;
  removedRange: string;
  addedRange: string;
  lineCount: number;
  preview: string;
}

export interface XraySummary {
  totalChangedLines: number;
  importLines: number;
  moveLines: number;
  generatedLines: number;
  generatedFiles: number;
  behavioralLines: number;
  noiseReductionPct: number;
  compilerEligible: boolean;
  compilerReason: string | null;
  moves: MovePairSummary[];
  inputSha256: string;
  rawBytes: number;
  maxRunBytes: number;
  fitsSingleRun: boolean;
  partitionCount: number;
}

export interface LedgerSummary {
  available: boolean;
  tasks: { id: string; goal: string }[];
  evidence: { id: string; task: string; basis: string; freshness: string }[];
  decisions: { id: string; task: string; question: string; answer: string | null }[];
  staleCount: number;
  unresolvedCount: number;
}

export interface CommitSummary {
  sha: string;
  subject: string;
  when: string;
  files: number;
  adds: number;
  deletes: number;
}

export interface RepoStatusSummary {
  isGitRepo: boolean;
  branch: string | null;
  headSha: string | null;
  dirtyCount: number;
  stagedCount: number;
  commits: CommitSummary[];
}

export interface AgentReviewFileTarget {
  file: string;
  risk: FileDiffSummary["risk"];
  behavioralLines: number;
  noiseLines: number;
  adds: number;
  deletes: number;
  reasons: string[];
}

export interface AgentTriageSummary {
  schema: "columbo.triage.v1";
  sourceLabel: string;
  deterministicTruth: {
    inputSha256: string;
    rawBytes: number;
    filesChanged: number;
    totalChangedLines: number;
    behavioralLines: number;
    strippedImportLines: number;
    exactMoveLines: number;
    exactMovePairs: number;
    generatedLines: number;
    generatedFiles: number;
    noiseReductionPct: number;
    compilerEligible: boolean;
    compilerReason: string | null;
    fitsSingleRun: boolean;
    partitionCount: number;
    ledgerAvailable: boolean;
    staleEvidenceCount: number;
    unresolvedDecisionCount: number;
  };
  heuristicTriage: {
    notSafetyProof: true;
    guidance: string;
    statechartRecommended: boolean;
    signals: StatechartArtifact["signals"];
    reviewOrder: AgentReviewFileTarget[];
    invariantsToVerify: string[];
    recommendedCommands: string[];
  };
}

export interface DashboardOptions {
  includeLedger?: boolean;
}

export interface TriageOptions extends DashboardOptions {
  top?: number;
  minRisk?: FileDiffSummary["risk"];
}

export interface DashboardPayload {
  sourceLabel: string;
  shape: {
    adds: number;
    deletes: number;
    context: number;
    marks: string;
  };
  files: FileDiffSummary[];
  xray: XraySummary;
  nodeFileMap: Record<string, string>;
  statechart: StatechartArtifact;
  repo: RepoStatusSummary;
  ledger: LedgerSummary;
  doctor: DoctorFacts;
  agentTriage: AgentTriageSummary;
}

function splitSmartDiffByFile(smartText: string): Map<string, string> {
  const result = new Map<string, string>();
  let currentFile: string | null = null;
  let buf: string[] = [];

  const flush = () => {
    if (currentFile !== null) {
      result.set(currentFile, buf.join("\n"));
    }
  };

  for (const line of smartText.split(/\r?\n/)) {
    const gitFile = parseDiffGitHeader(line);
    if (gitFile !== null) {
      flush();
      currentFile = gitFile;
      buf = [line];
      continue;
    }
    if (line.startsWith("+++ b/") || line.startsWith('+++ "b/')) {
      const name = parsePlusHeader(line);
      if (name) {
        if (currentFile === null) {
          currentFile = name;
          buf = [line];
        } else {
          currentFile = name;
          buf.push(line);
        }
      }
      continue;
    }
    if (currentFile !== null) {
      buf.push(line);
    }
  }
  flush();
  return result;
}

export function summarizeDiffFiles(diffText: string): FileDiffSummary[] {
  const summaries: FileDiffSummary[] = [];
  let current: {
    file: string;
    adds: number;
    deletes: number;
    hunks: number;
    stateSignals: number;
    errorSignals: number;
    retrySignals: number;
    asyncSignals: number;
    guardSignals: number;
    removedGuardSignals: number;
    lines: string[];
  } | null = null;
  let inHunk = false;

  const createEntry = (file: string, initialLines: string[]) => ({
    file,
    adds: 0,
    deletes: 0,
    hunks: 0,
    stateSignals: 0,
    errorSignals: 0,
    retrySignals: 0,
    asyncSignals: 0,
    guardSignals: 0,
    removedGuardSignals: 0,
    lines: initialLines,
  });

  const flush = () => {
    if (!current) return;
    const totalRisk =
      current.stateSignals +
      current.errorSignals +
      current.retrySignals +
      current.removedGuardSignals * 2;
    const risk: FileDiffSummary["risk"] =
      totalRisk >= 3 || current.removedGuardSignals >= 1
        ? "high"
        : totalRisk >= 1 || current.guardSignals >= 2 || current.asyncSignals >= 2
          ? "medium"
          : "low";
    const changed = current.adds + current.deletes;
    const patch = current.lines.join("\n");
    summaries.push({
      file: current.file,
      adds: current.adds,
      deletes: current.deletes,
      hunks: current.hunks,
      stateSignals: current.stateSignals,
      errorSignals: current.errorSignals,
      retrySignals: current.retrySignals,
      asyncSignals: current.asyncSignals,
      guardSignals: current.guardSignals,
      removedGuardSignals: current.removedGuardSignals,
      importLines: 0,
      moveLines: 0,
      behavioralLines: changed,
      risk,
      patch,
      meatPatch: patch,
    });
  };

  for (const line of diffText.split(/\r?\n/)) {
    const gitFile = parseDiffGitHeader(line);
    if (gitFile !== null) {
      flush();
      inHunk = false;
      current = createEntry(gitFile, [line]);
      continue;
    }
    if (!inHunk && line.startsWith("--- ")) {
      const minusFile = parseMinusHeader(line);
      if (!current) {
        current = createEntry(minusFile ?? "input.diff", [line]);
      } else {
        current.lines.push(line);
      }
      continue;
    }
    if ((!inHunk && line.startsWith("+++ ")) || line.startsWith("+++ b/") || line.startsWith('+++ "b/')) {
      inHunk = false;
      const plusFile = parsePlusHeader(line);
      if (!current) {
        current = createEntry(plusFile ?? "input.diff", [line]);
      } else {
        if (plusFile) current.file = plusFile;
        current.lines.push(line);
      }
      continue;
    }
    if (line.startsWith("@@ ")) {
      inHunk = true;
      if (!current) {
        current = createEntry("input.diff", []);
      }
      current.lines.push(line);
      current.hunks++;
      continue;
    }
    if (!current) {
      continue;
    }
    current.lines.push(line);
    if (!inHunk) {
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      current.adds++;
      const code = line.slice(1);
      if (stateMutationRe.test(code)) current.stateSignals++;
      if (errorHandlingRe.test(code)) current.errorSignals++;
      if (retryCancelRe.test(code)) current.retrySignals++;
      if (asyncConcurrencyRe.test(code)) current.asyncSignals++;
      if (branchGuardRe.test(code)) current.guardSignals++;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      current.deletes++;
      const code = line.slice(1);
      if (stateMutationRe.test(code)) current.stateSignals++;
      if (errorHandlingRe.test(code)) current.errorSignals++;
      if (retryCancelRe.test(code)) current.retrySignals++;
      if (asyncConcurrencyRe.test(code)) current.asyncSignals++;
      if (branchGuardRe.test(code)) current.removedGuardSignals++;
    }
  }
  flush();
  return summaries;
}

export function analyzeDiffXray(diffText: string, files: FileDiffSummary[]): XraySummary {
  const rawBytes = encodeUTF8(diffText);
  const inputSha256 = createHash("sha256").update(rawBytes).digest("hex");
  const totalChangedLines = files.reduce((acc, f) => acc + f.adds + f.deletes, 0);

  const lines = splitSourceLines(rawBytes);
  const layout = analyzeDiff(lines);

  let compilerEligible = true;
  let compilerReason: string | null = null;
  try {
    validateSupportedDiff(rawBytes);
    if (rawBytes.length > maxTotalDiffBytes) {
      throw new Error("Input exceeds the engine aggregate diff byte limit.");
    }
  } catch (err) {
    compilerEligible = false;
    compilerReason = err instanceof Error ? err.message : String(err);
  }

  let partitionCount = 0;
  const singleRun = fitsSingleRun(rawBytes, maxDiffBytes);
  if (compilerEligible && rawBytes.length > 0) {
    try {
      partitionCount = singleRun ? 1 : splitDiffForAbridging(rawBytes, maxDiffBytes).length;
    } catch (err) {
      compilerEligible = false;
      compilerReason = err instanceof Error ? err.message : String(err);
    }
  }

  const lineFiles: (string | null)[] = new Array(lines.length).fill(null);
  let activeFile: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const text = decodeUTF8(lines[i]!.text);
    const gitFile = parseDiffGitHeader(text);
    if (gitFile !== null) {
      activeFile = gitFile;
    } else if (text.startsWith("+++ b/") || text.startsWith('+++ "b/')) {
      const plusFile = parsePlusHeader(text);
      if (plusFile) activeFile = plusFile;
    }
    lineFiles[i] = activeFile;
  }

  const isChangedAt = (idx: number): boolean => {
    const kind = layout.kinds[idx];
    if (kind === undefined || !isHunkSource(kind)) return false;
    const line = lines[idx];
    if (!line || line.text.length === 0) return false;
    const b = line.text[0];
    return b === 0x2b || b === 0x2d;
  };

  const generatedFileSet = new Set<string>();
  for (const fileSummary of files) {
    const sample = fileSummary.patch
      .split(/\r?\n/)
      .filter(l => l.startsWith("+") || l.startsWith("-") || l.startsWith(" "))
      .filter(l => !l.startsWith("+++") && !l.startsWith("---"))
      .slice(0, 8)
      .map(l => l.slice(1));
    if (isGeneratedOrLockfile(fileSummary.file, sample)) {
      generatedFileSet.add(fileSummary.file);
    }
  }

  let totalImportLines = 0;
  let totalMoveLines = 0;
  let totalGeneratedLines = 0;
  const moves: MovePairSummary[] = [];

  if (compilerEligible && lines.length > 0) {
    const mandatory = mandatoryRemovalMask(lines.length, mandatoryImportRemovalPlan(lines, layout));
    const exactMoves = detectExactMoves(lines, layout);
    applyMandatoryMovePrecedence(exactMoves, mandatory);

    const moveMask = new Uint8Array(lines.length);
    for (const mv of exactMoves) {
      const remFile = lineFiles[mv.removed.startLine - 1] ?? "diff";
      const addFile = lineFiles[mv.added.startLine - 1] ?? "diff";
      if (generatedFileSet.has(remFile) || generatedFileSet.has(addFile)) continue;
      for (let ln = mv.removed.startLine; ln <= mv.removed.endLine; ln++) {
        if (ln >= 1 && ln <= lines.length) moveMask[ln - 1] = 1;
      }
      for (let ln = mv.added.startLine; ln <= mv.added.endLine; ln++) {
        if (ln >= 1 && ln <= lines.length) moveMask[ln - 1] = 1;
      }
      const previewLines: string[] = [];
      for (let ln = mv.added.startLine; ln <= Math.min(mv.added.endLine, mv.added.startLine + 2); ln++) {
        const src = lines[ln - 1];
        if (src) previewLines.push(decodeUTF8(src.text).slice(1).trim());
      }
      moves.push({
        removedFile: remFile,
        addedFile: addFile,
        removedRange: `L${mv.removed.startLine}-${mv.removed.endLine}`,
        addedRange: `L${mv.added.startLine}-${mv.added.endLine}`,
        lineCount: mv.removed.endLine - mv.removed.startLine + 1,
        preview: previewLines.filter(Boolean).join(" / ").slice(0, 140),
      });
    }

    const fileCounts = new Map<string, { imp: number; mv: number; gen: number; beh: number }>();
    for (let i = 0; i < lines.length; i++) {
      if (!isChangedAt(i)) continue;
      const f = lineFiles[i] ?? "input.diff";
      let entry = fileCounts.get(f);
      if (!entry) {
        entry = { imp: 0, mv: 0, gen: 0, beh: 0 };
        fileCounts.set(f, entry);
      }
      if (generatedFileSet.has(f)) {
        entry.gen++;
        totalGeneratedLines++;
      } else if (mandatory[i]) {
        entry.imp++;
        totalImportLines++;
      } else if (moveMask[i]) {
        entry.mv++;
        totalMoveLines++;
      } else {
        entry.beh++;
      }
    }

    const tb = newToolbox({ rawDiff: rawBytes });
    const [feedback, failed] = submit(
      tb,
      encodeUTF8(JSON.stringify({ remove: [], replace: [], fold: [], summary: "Compiler baseline" })),
    );
    const meatByFile = !failed && feedback !== undefined
      ? splitSmartDiffByFile(decodeUTF8(tb.smartDiff))
      : new Map<string, string>();

    for (const fileSummary of files) {
      const counts = fileCounts.get(fileSummary.file);
      if (counts) {
        fileSummary.importLines = counts.imp;
        fileSummary.moveLines = counts.mv;
        fileSummary.behavioralLines = counts.beh;
      }
      if (generatedFileSet.has(fileSummary.file)) {
        fileSummary.meatPatch = `... [generated/lockfile omitted: +${fileSummary.adds} -${fileSummary.deletes} lines in ${fileSummary.file}]`;
      } else if (!failed && feedback !== undefined) {
        fileSummary.meatPatch = meatByFile.get(fileSummary.file) ?? "";
      }
    }
  } else if (generatedFileSet.size > 0) {
    for (const fileSummary of files) {
      if (generatedFileSet.has(fileSummary.file)) {
        totalGeneratedLines += fileSummary.adds + fileSummary.deletes;
        fileSummary.behavioralLines = 0;
      }
    }
  }

  const behavioralLines = Math.max(0, totalChangedLines - totalImportLines - totalMoveLines - totalGeneratedLines);
  const noiseLines = totalImportLines + totalMoveLines + totalGeneratedLines;
  const noiseReductionPct = totalChangedLines > 0 ? Math.round((noiseLines / totalChangedLines) * 100) : 0;

  return {
    totalChangedLines,
    importLines: totalImportLines,
    moveLines: totalMoveLines,
    generatedLines: totalGeneratedLines,
    generatedFiles: generatedFileSet.size,
    behavioralLines,
    noiseReductionPct,
    compilerEligible,
    compilerReason,
    moves,
    inputSha256,
    rawBytes: rawBytes.length,
    maxRunBytes: maxDiffBytes,
    fitsSingleRun: singleRun,
    partitionCount,
  };
}

function tryGit(cwd: string, args: readonly string[]): string | null {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

export function collectRepoStatus(cwd: string): RepoStatusSummary {
  const inside = tryGit(cwd, ["rev-parse", "--is-inside-work-tree"])?.trim();
  if (inside !== "true") {
    return { isGitRepo: false, branch: null, headSha: null, dirtyCount: 0, stagedCount: 0, commits: [] };
  }
  const branch = tryGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])?.trim() ?? null;
  const headSha = tryGit(cwd, ["rev-parse", "--short", "HEAD"])?.trim() ?? null;
  const porcelain = tryGit(cwd, ["status", "--porcelain"]) ?? "";
  let dirtyCount = 0;
  let stagedCount = 0;
  for (const row of porcelain.split(/\r?\n/)) {
    if (!row.trim()) continue;
    dirtyCount++;
    if (row[0] !== " " && row[0] !== "?") stagedCount++;
  }

  const logRaw = tryGit(cwd, ["log", "-n", "12", "--numstat", "--format=__COMMIT__%h\t%s\t%cr"]) ?? "";
  const commits: CommitSummary[] = [];
  let active: CommitSummary | null = null;
  for (const line of logRaw.split(/\r?\n/)) {
    if (line.startsWith("__COMMIT__")) {
      if (active) commits.push(active);
      const [sha = "", subject = "", when = ""] = line.slice(10).split("\t");
      active = { sha, subject, when, files: 0, adds: 0, deletes: 0 };
      continue;
    }
    if (!active || !line.trim()) continue;
    const [a = "0", d = "0"] = line.split("\t");
    active.files++;
    if (/^\d+$/.test(a)) active.adds += Number(a);
    if (/^\d+$/.test(d)) active.deletes += Number(d);
  }
  if (active) commits.push(active);

  return { isGitRepo: true, branch, headSha, dirtyCount, stagedCount, commits };
}

function emptyLedger(): LedgerSummary {
  return {
    available: false,
    tasks: [],
    evidence: [],
    decisions: [],
    staleCount: 0,
    unresolvedCount: 0,
  };
}

export async function collectLedgerStatus(cwd: string, isGitRepo: boolean): Promise<LedgerSummary> {
  const empty = emptyLedger();
  if (!isGitRepo || resolve(cwd) !== resolve(process.cwd())) return empty;
  try {
    const raw = await runState("status", ["--details", "--json"]);
    if (raw.kind !== "columbo.status" || !raw.tasks || !raw.evidence || !raw.decisions) return empty;
    const tasks = raw.tasks.map((t) => ({ id: t.id, goal: t.goal }));
    const evidence = raw.evidence.map((e) => ({
      id: e.id,
      task: e.task,
      basis: e.basis,
      freshness: e.freshness,
    }));
    const decisions = raw.decisions.map((d) => ({
      id: d.id,
      task: d.task,
      question: d.question,
      answer: d.answer,
    }));
    return {
      available: tasks.length > 0 || evidence.length > 0 || decisions.length > 0,
      tasks,
      evidence,
      decisions,
      staleCount: evidence.filter((e) => e.freshness === "needs_recheck").length,
      unresolvedCount: decisions.filter((d) => d.answer === null).length,
    };
  } catch {
    return empty;
  }
}

function buildNodeFileMap(files: readonly FileDiffSummary[], statechart: StatechartArtifact): Record<string, string> {
  const map: Record<string, string> = {};
  const first = files[0]?.file ?? statechart.sourceRefs[0];
  if (!first) return map;

  const pick = (score: (f: FileDiffSummary) => number, fallback: string): string => {
    if (files.length === 0) return fallback;
    const ranked = [...files].sort((a, b) => (score(b) - score(a)) || (b.behavioralLines - a.behavioralLines));
    return score(ranked[0]!) > 0 ? ranked[0]!.file : fallback;
  };

  const primary = pick(
    f => f.removedGuardSignals * 3 + f.errorSignals * 2 + f.stateSignals * 2 + f.retrySignals * 2 + f.asyncSignals + f.guardSignals,
    first,
  );
  const bestGuard = pick(f => f.removedGuardSignals * 3 + f.guardSignals, primary);
  const bestErr = pick(f => f.errorSignals * 2 + f.retrySignals * 2 + f.removedGuardSignals * 2, primary);
  const bestState = pick(f => f.stateSignals * 2 + f.asyncSignals, primary);

  map["idle"] = primary;
  map["executing"] = bestState;
  map["guarded"] = bestGuard;
  map["failed"] = bestErr;
  map["completed"] = primary;
  for (const node of statechart.nodes) {
    if (node.sourceRef && !map[node.id]) {
      map[node.id] = node.sourceRef;
    }
  }
  return map;
}

function buildAgentTriage(
  sourceLabel: string,
  files: readonly FileDiffSummary[],
  xray: XraySummary,
  statechart: StatechartArtifact,
  ledger: LedgerSummary,
  includeLedger: boolean,
): AgentTriageSummary {
  const riskRank: Record<FileDiffSummary["risk"], number> = { high: 3, medium: 2, low: 1 };
  const sorted = [...files].sort((a, b) => {
    if (riskRank[b.risk] !== riskRank[a.risk]) return riskRank[b.risk] - riskRank[a.risk];
    if (b.removedGuardSignals !== a.removedGuardSignals) return b.removedGuardSignals - a.removedGuardSignals;
    return (b.behavioralLines - a.behavioralLines) || ((b.adds + b.deletes) - (a.adds + a.deletes));
  });

  const reviewOrder: AgentReviewFileTarget[] = sorted.map((f) => {
    const reasons: string[] = [];
    if (f.removedGuardSignals > 0) reasons.push(`${f.removedGuardSignals} removed guard(s)`);
    if (f.errorSignals > 0) reasons.push(`${f.errorSignals} error/recovery cue(s)`);
    if (f.stateSignals > 0) reasons.push(`${f.stateSignals} state update(s)`);
    if (f.retrySignals > 0) reasons.push(`${f.retrySignals} retry/timeout/cancel cue(s)`);
    if (f.asyncSignals > 0) reasons.push(`${f.asyncSignals} async/lock cue(s)`);
    if (f.guardSignals > 0) reasons.push(`${f.guardSignals} added guard(s)`);
    const totalFileLines = f.adds + f.deletes;
    const noiseLines = Math.max(0, totalFileLines - f.behavioralLines);
    const genLines = Math.max(0, noiseLines - f.importLines - f.moveLines);
    if (genLines > 0) reasons.push(`${genLines}/${totalFileLines} lines generated/lockfile`);
    else if (noiseLines > 0) reasons.push(`${noiseLines}/${totalFileLines} lines proven noise (${f.importLines} imp, ${f.moveLines} mov)`);
    if (reasons.length === 0) reasons.push(`${f.behavioralLines} behavioral line(s); no control-flow keywords (still verify logic)`);
    return {
      file: f.file,
      risk: f.risk,
      behavioralLines: f.behavioralLines,
      noiseLines,
      adds: f.adds,
      deletes: f.deletes,
      reasons,
    };
  });

  const recommendedCommands: string[] = [];
  if (includeLedger) {
    recommendedCommands.push("columbo -look -meat-only HEAD");
    recommendedCommands.push("columbo -inventory -page-size 20 HEAD");
    if (statechart.shouldGenerate) recommendedCommands.push("columbo statechart HEAD --json");
    if (ledger.staleCount > 0) recommendedCommands.push("columbo status --details --json");
    if (!xray.fitsSingleRun) recommendedCommands.push("columbo -plan HEAD");
  } else {
    recommendedCommands.push("columbo -look -meat-only < diff.patch");
    recommendedCommands.push("columbo -inventory -page-size 20 < diff.patch");
    if (statechart.shouldGenerate) recommendedCommands.push("columbo statechart --stdin --json < diff.patch");
    if (!xray.fitsSingleRun) recommendedCommands.push("columbo -plan < diff.patch");
  }

  return {
    schema: "columbo.triage.v1",
    sourceLabel,
    deterministicTruth: {
      inputSha256: xray.inputSha256,
      rawBytes: xray.rawBytes,
      filesChanged: files.length,
      totalChangedLines: xray.totalChangedLines,
      behavioralLines: xray.behavioralLines,
      strippedImportLines: xray.importLines,
      exactMoveLines: xray.moveLines,
      exactMovePairs: xray.moves.length,
      generatedLines: xray.generatedLines,
      generatedFiles: xray.generatedFiles,
      noiseReductionPct: xray.noiseReductionPct,
      compilerEligible: xray.compilerEligible,
      compilerReason: xray.compilerReason,
      fitsSingleRun: xray.fitsSingleRun,
      partitionCount: xray.partitionCount,
      ledgerAvailable: ledger.available,
      staleEvidenceCount: ledger.staleCount,
      unresolvedDecisionCount: ledger.unresolvedCount,
    },
    heuristicTriage: {
      notSafetyProof: true,
      guidance: "Use deterministicTruth to skip proven imports/moves and bind snapshots. Treat risk ratings, signals, and State Flow strictly as review prioritization—never as proof that low-risk files are bug-free.",
      statechartRecommended: statechart.shouldGenerate,
      signals: statechart.signals,
      reviewOrder,
      invariantsToVerify: statechart.invariants,
      recommendedCommands,
    },
  };
}

export async function analyzeDiffTriage(
  diffText: string,
  sourceLabel: string,
  cwd: string,
  options: TriageOptions = {},
): Promise<AgentTriageSummary> {
  const includeLedger = options.includeLedger !== false;
  const files = summarizeDiffFiles(diffText);
  const xray = analyzeDiffXray(diffText, files);
  const statechart = analyzeDiffForStatechart(diffText, sourceLabel);
  const ledger = includeLedger ? await collectLedgerStatus(cwd, collectRepoStatus(cwd).isGitRepo) : emptyLedger();
  const base = buildAgentTriage(sourceLabel, files, xray, statechart, ledger, includeLedger);
  const riskOrder: Record<FileDiffSummary["risk"], number> = { high: 3, medium: 2, low: 1 };
  let reviewOrder = base.heuristicTriage.reviewOrder;
  if (options.minRisk !== undefined) {
    const min = riskOrder[options.minRisk];
    reviewOrder = reviewOrder.filter(item => riskOrder[item.risk] >= min);
  }
  if (options.top !== undefined && options.top >= 0) {
    reviewOrder = reviewOrder.slice(0, options.top);
  }
  return {
    ...base,
    heuristicTriage: {
      ...base.heuristicTriage,
      reviewOrder,
    },
  };
}

export function formatTriageReport(triage: AgentTriageSummary): string {
  const dt = triage.deterministicTruth;
  const ht = triage.heuristicTriage;
  const budgetText = dt.compilerEligible
    ? dt.fitsSingleRun
      ? "single-run eligible (1 partition)"
      : `eligible (${dt.partitionCount} partitions)`
    : `compiler skipped (${dt.compilerReason ?? "unsupported diff"})`;
  const ledgerText = dt.ledgerAvailable
    ? `available (${dt.staleEvidenceCount} stale evidence, ${dt.unresolvedDecisionCount} unresolved decisions)`
    : "none";
  const noiseParts = [
    `${dt.strippedImportLines} imp`,
    `${dt.exactMoveLines} mov`,
    ...(dt.generatedLines > 0 ? [`${dt.generatedLines} gen`] : []),
    `${dt.exactMovePairs} move pair(s)`,
  ];

  const lines: string[] = [
    `Columbo Offline Triage (${triage.schema})`,
    `Source:   ${triage.sourceLabel}`,
    `SHA-256:  ${dt.inputSha256} (${dt.rawBytes} B, ${dt.filesChanged} file(s))`,
    `X-Ray:    ${dt.behavioralLines} meat / ${dt.totalChangedLines} changed (${dt.noiseReductionPct}% proven noise: ${noiseParts.join(", ")})`,
    `Budget:   ${budgetText}`,
    `Ledger:   ${ledgerText}`,
    "",
    "Heuristic Review Order (NOT a safety proof — low risk still requires reading):",
  ];

  if (ht.reviewOrder.length === 0) {
    lines.push("  (no matching file hunks)");
  } else {
    ht.reviewOrder.forEach((item, idx) => {
      const tag = item.risk === "high" ? "HIGH" : item.risk === "medium" ? "MED " : "LOW ";
      lines.push(
        `  ${idx + 1}. [${tag}] ${item.file} (+${item.adds} -${item.deletes}, ${item.behavioralLines} meat / ${item.noiseLines} noise) — ${item.reasons.join("; ")}`,
      );
    });
  }

  if (ht.invariantsToVerify.length > 0) {
    lines.push("", "Invariants to Verify:");
    for (const inv of ht.invariantsToVerify) {
      lines.push(`  - ${inv}`);
    }
  }

  if (ht.recommendedCommands.length > 0) {
    lines.push("", "Next Commands:");
    for (const cmd of ht.recommendedCommands) {
      lines.push(`  - ${cmd}`);
    }
  }

  return lines.join("\n") + "\n";
}

export function formatTriageMarkdown(triage: AgentTriageSummary): string {
  const dt = triage.deterministicTruth;
  const ht = triage.heuristicTriage;
  const lines: string[] = [
    `## Columbo Offline Triage — \`${triage.sourceLabel}\``,
    "",
    "| Metric | Value |",
    "|---|---|",
    `| Input SHA-256 | \`${dt.inputSha256.slice(0, 16)}\` (${dt.rawBytes} B, ${dt.filesChanged} files) |`,
    `| Behavioral Meat vs. Noise | **${dt.behavioralLines} meat** / ${dt.totalChangedLines} changed (**${dt.noiseReductionPct}% noise**: ${dt.strippedImportLines} imp, ${dt.exactMoveLines} mov${dt.generatedLines > 0 ? `, ${dt.generatedLines} gen` : ""}, ${dt.exactMovePairs} move pair(s)) |`,
    `| Compiler Budget | ${dt.compilerEligible ? (dt.fitsSingleRun ? "Single-run eligible (1 partition)" : `Eligible (${dt.partitionCount} partitions)`) : `Skipped (${dt.compilerReason ?? "unsupported diff"})`} |`,
    "",
    "### Heuristic Review Order",
    "> Priority hint only (`notSafetyProof: true`) — low-risk files still require reading.",
    "",
    "| # | Risk | File | Meat / Noise | Signals |",
    "|---|---|---|---|---|",
  ];

  if (ht.reviewOrder.length === 0) {
    lines.push("| - | - | *(no matching files)* | - | - |");
  } else {
    ht.reviewOrder.forEach((item, idx) => {
      lines.push(
        `| ${idx + 1} | \`${item.risk.toUpperCase()}\` | \`${item.file}\` | ${item.behavioralLines}m / ${item.noiseLines}n (+${item.adds} -${item.deletes}) | ${item.reasons.join("; ")} |`,
      );
    });
  }

  if (ht.invariantsToVerify.length > 0) {
    lines.push("", "### Invariants to Verify");
    for (const inv of ht.invariantsToVerify) {
      lines.push(`- ${inv}`);
    }
  }

  if (ht.recommendedCommands.length > 0) {
    lines.push("", "### Next Commands");
    for (const cmd of ht.recommendedCommands) {
      lines.push(`- \`${cmd}\``);
    }
  }

  return lines.join("\n") + "\n";
}

export async function buildDashboardPayload(
  diffText: string,
  sourceLabel: string,
  cwd: string,
  options: DashboardOptions = {},
): Promise<DashboardPayload> {
  const includeLedger = options.includeLedger !== false;
  const shapeRaw = observeDiffShape(encodeUTF8(diffText));
  const marks = shapeRaw.slots
    .slice(0, 120)
    .map(slot => (slot === "add" ? "+" : slot === "delete" ? "-" : "."))
    .join("");
  const files = summarizeDiffFiles(diffText);
  const xray = analyzeDiffXray(diffText, files);
  const statechart = analyzeDiffForStatechart(diffText, sourceLabel);
  const repo = collectRepoStatus(cwd);
  const ledger = includeLedger ? await collectLedgerStatus(cwd, repo.isGitRepo) : emptyLedger();
  return {
    sourceLabel,
    shape: {
      adds: shapeRaw.adds,
      deletes: shapeRaw.deletes,
      context: shapeRaw.context,
      marks,
    },
    files,
    xray,
    nodeFileMap: buildNodeFileMap(files, statechart),
    statechart,
    repo,
    ledger,
    doctor: collectDoctorFacts(),
    agentTriage: buildAgentTriage(sourceLabel, files, xray, statechart, ledger, includeLedger),
  };
}
