// Unified-diff → shape / color / length view. No model, no cache.
// Counts use analyzeDiff hunk lines so +++ / --- file headers are not add/delete.

import { at, arrayAt, concat, decodeUTF8 } from "../meat/bytes.ts";
import { maxTotalDiffBytes } from "../meat/chunk.ts";
import { analyzeDiff, isHunkSource, splitSourceLines, validateSupportedDiff } from "../meat/diff.ts";
import { mandatoryImportRemovalPlan, mandatoryRemovalMask } from "../meat/imports.ts";
import { applyMandatoryMovePrecedence, detectExactMoves } from "../meat/moves.ts";
import { ansiReset, colorizeDiffLine, type DiffPalette } from "./render.ts";
import { parseDiffGitHeader, parsePlusHeader } from "./statechart.ts";

export type ShapeSlot = "add" | "delete" | "context";

export interface DiffShape {
  readonly adds: number;
  readonly deletes: number;
  readonly context: number;
  readonly slots: readonly ShapeSlot[];
}

export interface MeatDiffOptions {
  readonly fileFilter?: string;
}

export interface MeatDiffProjection {
  readonly totalChangedLines: number;
  readonly importLines: number;
  readonly moveLines: number;
  readonly generatedLines: number;
  readonly behavioralLines: number;
  readonly noiseReductionPct: number;
  readonly exactMovePairs: number;
  readonly omittedFiles: number;
  readonly generatedFiles: number;
  readonly matchedFiles: number;
  readonly compilerEligible: boolean;
  readonly compilerReason: string | null;
  readonly lines: readonly string[];
}

/** Columns of add/remove/context marks per `shape   ` row (8-char prefix + 72 = 80). */
export const SHAPE_WRAP = 72;

const PLUS_BYTE = 0x2b;
const MINUS_BYTE = 0x2d;

const LOCKFILE_BASENAMES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "cargo.lock",
  "go.sum",
  "poetry.lock",
  "composer.lock",
  "gemfile.lock",
  "uv.lock",
  "bun.lock",
  "bun.lockb",
  "npm-shrinkwrap.json",
  "flake.lock",
]);

const GENERATED_SUFFIXES = [
  ".min.js",
  ".min.css",
  ".min.mjs",
  ".bundle.js",
  ".pb.go",
  "_pb2.py",
  ".g.dart",
  ".generated.ts",
  ".generated.js",
];

const GENERATED_BANNER_RE = /\bCode generated\b.*\bDO NOT EDIT\b|@generated\b|\bAUTO-GENERATED FILE\b|\bAutomatically generated\b.*\bdo not edit\b/i;

export function isGeneratedOrLockfile(filePath: string, sampleLines: readonly string[] = []): boolean {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  if (LOCKFILE_BASENAMES.has(base)) return true;
  if (GENERATED_SUFFIXES.some(suffix => normalized.endsWith(suffix))) return true;
  for (let i = 0; i < Math.min(sampleLines.length, 8); i++) {
    if (GENERATED_BANNER_RE.test(sampleLines[i]!)) return true;
  }
  return false;
}

function normalizeFilter(raw: string): string {
  return raw.trim().replace(/\\/g, "/").replace(/^(?:a\/|b\/|\.\/)+/, "");
}

function matchesFileFilter(filePath: string, filter: string): boolean {
  const normFile = filePath.replace(/\\/g, "/").replace(/^(?:a\/|b\/|\.\/)+/, "");
  const normFilter = normalizeFilter(filter);
  if (normFilter === "") return true;
  return normFile === normFilter || normFile.endsWith(`/${normFilter}`) || normFile.includes(normFilter);
}

function collectFilePaths(sourceLines: readonly { readonly text: Uint8Array }[], fileIds: readonly number[]): Map<number, string> {
  const paths = new Map<number, string>();
  for (let i = 0; i < sourceLines.length; i++) {
    const fid = arrayAt(fileIds, i);
    if (fid < 0) continue;
    const text = decodeUTF8(arrayAt(sourceLines, i).text);
    const gitPath = parseDiffGitHeader(text);
    if (gitPath !== null) {
      paths.set(fid, gitPath);
    } else if (text.startsWith("+++ ")) {
      const plusPath = parsePlusHeader(text);
      if (plusPath !== null) paths.set(fid, plusPath);
    }
  }
  return paths;
}

export function filterDiffByFile(diff: Uint8Array, fileFilter: string): { readonly diff: Uint8Array; readonly matchedFiles: number } {
  const norm = normalizeFilter(fileFilter);
  if (norm === "") return { diff, matchedFiles: -1 };
  const sourceLines = splitSourceLines(diff);
  const layout = analyzeDiff(sourceLines);
  const paths = collectFilePaths(sourceLines, layout.fileId);
  const matched = new Set<number>();
  for (const [fid, path] of paths.entries()) {
    if (matchesFileFilter(path, norm)) matched.add(fid);
  }
  if (matched.size === 0) return { diff: new Uint8Array(0), matchedFiles: 0 };
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < sourceLines.length; i++) {
    const fid = arrayAt(layout.fileId, i);
    if (fid >= 0 && matched.has(fid)) {
      const line = arrayAt(sourceLines, i);
      chunks.push(line.text, line.eol);
    }
  }
  return { diff: concat(chunks), matchedFiles: matched.size };
}

/**
 * Spatial add/remove/context pattern and explicit counts for a unified diff.
 * Only `hunk_context` / `hunk_change` lines contribute; headers stay out of the shape.
 */
export function observeDiffShape(diff: Uint8Array): DiffShape {
  const lines = splitSourceLines(diff);
  const layout = analyzeDiff(lines);
  const slots: ShapeSlot[] = [];
  let adds = 0;
  let deletes = 0;
  let context = 0;

  for (let i = 0; i < lines.length; i++) {
    const kind = arrayAt(layout.kinds, i);
    if (kind === "hunk_context") {
      slots.push("context");
      context++;
      continue;
    }
    if (kind !== "hunk_change") continue;
    const text = arrayAt(lines, i).text;
    if (text.length === 0) continue;
    const first = at(text, 0);
    if (first === PLUS_BYTE) {
      slots.push("add");
      adds++;
    } else if (first === MINUS_BYTE) {
      slots.push("delete");
      deletes++;
    }
  }

  return { adds, deletes, context, slots };
}

function markFor(slot: ShapeSlot): string {
  if (slot === "add") return "+";
  if (slot === "delete") return "-";
  return ".";
}

function wrapMarks(marks: string, width: number): string[] {
  if (marks.length === 0) return [""];
  const rows: string[] = [];
  for (let i = 0; i < marks.length; i += width) {
    rows.push(marks.slice(i, i + width));
  }
  return rows;
}

/** Color add vs delete runs when the palette has slots; colorless `+`/`-`/`.` otherwise. */
export function colorizeShapeMarks(marks: string, p: DiffPalette): string {
  if (p.new === "" && p.old === "") return marks;
  let out = "";
  let i = 0;
  while (i < marks.length) {
    const ch = marks.charAt(i);
    let j = i + 1;
    while (j < marks.length && marks.charAt(j) === ch) j++;
    const run = marks.slice(i, j);
    const color = ch === "+" ? p.new : ch === "-" ? p.old : "";
    out += color !== "" ? color + run + ansiReset : run;
    i = j;
  }
  return out;
}

/**
 * Terminal view of one unified diff: explicit length, compact shape, then the
 * input's own unified-diff text (colorized with the same palette).
 */
export function formatDiffLook(diff: Uint8Array, p: DiffPalette, options: MeatDiffOptions = {}): string {
  const filter = options.fileFilter?.trim() ?? "";
  const effective = filter !== "" ? filterDiffByFile(diff, filter) : { diff, matchedFiles: -1 };
  if (filter !== "" && effective.matchedFiles === 0) {
    return `length  +0 -0 ~0\nfilter  ${filter} (0 files matched)\nshape   \n\n(no files matched filter ${JSON.stringify(filter)})\n`;
  }
  const shape = observeDiffShape(effective.diff);
  const marks = shape.slots.map(markFor).join("");
  const lines: string[] = [`length  +${shape.adds} -${shape.deletes} ~${shape.context}`];
  if (filter !== "") lines.push(`filter  ${filter} (${effective.matchedFiles} file(s) matched)`);
  for (const row of wrapMarks(marks, SHAPE_WRAP)) {
    lines.push(`shape   ${colorizeShapeMarks(row, p)}`);
  }
  lines.push("");
  for (const line of splitSourceLines(effective.diff)) {
    lines.push(colorizeDiffLine(decodeUTF8(line.text), p));
  }
  return lines.join("\n") + "\n";
}

export function compileMeatDiff(diff: Uint8Array, options: MeatDiffOptions = {}): MeatDiffProjection {
  const filter = options.fileFilter?.trim() ?? "";
  const filtered = filter !== "" ? filterDiffByFile(diff, filter) : { diff, matchedFiles: -1 };
  const targetDiff = filtered.diff;

  const sourceLines = splitSourceLines(targetDiff);
  const layout = analyzeDiff(sourceLines);
  const filePaths = collectFilePaths(sourceLines, layout.fileId);
  const matchedFiles = filtered.matchedFiles >= 0 ? filtered.matchedFiles : filePaths.size;

  const isChangedAt = (idx: number): boolean => {
    const kind = arrayAt(layout.kinds, idx);
    if (!isHunkSource(kind)) return false;
    const text = arrayAt(sourceLines, idx).text;
    if (text.length === 0) return false;
    const b = at(text, 0);
    return b === PLUS_BYTE || b === MINUS_BYTE;
  };

  let totalChangedLines = 0;
  for (let i = 0; i < sourceLines.length; i++) {
    if (isChangedAt(i)) totalChangedLines++;
  }

  let compilerEligible = true;
  let compilerReason: string | null = null;
  try {
    if (targetDiff.length > 0) validateSupportedDiff(targetDiff);
    if (targetDiff.length > maxTotalDiffBytes) {
      throw new Error("Input exceeds the engine aggregate diff byte limit.");
    }
  } catch (err) {
    compilerEligible = false;
    compilerReason = err instanceof Error ? err.message : String(err);
  }

  if (!compilerEligible || sourceLines.length === 0) {
    return {
      totalChangedLines,
      importLines: 0,
      moveLines: 0,
      generatedLines: 0,
      behavioralLines: totalChangedLines,
      noiseReductionPct: 0,
      exactMovePairs: 0,
      omittedFiles: 0,
      generatedFiles: 0,
      matchedFiles,
      compilerEligible,
      compilerReason,
      lines: sourceLines.map(line => decodeUTF8(line.text)),
    };
  }

  const fileSamples = new Map<number, string[]>();
  const fileChangeCounts = new Map<number, { adds: number; deletes: number }>();
  for (let i = 0; i < sourceLines.length; i++) {
    const fid = arrayAt(layout.fileId, i);
    if (fid < 0) continue;
    const kind = arrayAt(layout.kinds, i);
    if (isHunkSource(kind)) {
      const sample = fileSamples.get(fid) ?? [];
      if (sample.length < 8) {
        sample.push(decodeUTF8(arrayAt(sourceLines, i).text).slice(1));
        fileSamples.set(fid, sample);
      }
      const text = arrayAt(sourceLines, i).text;
      if (text.length > 0) {
        const b = at(text, 0);
        if (b === PLUS_BYTE || b === MINUS_BYTE) {
          const counts = fileChangeCounts.get(fid) ?? { adds: 0, deletes: 0 };
          if (b === PLUS_BYTE) counts.adds++;
          else counts.deletes++;
          fileChangeCounts.set(fid, counts);
        }
      }
    }
  }

  const generatedFileIds = new Set<number>();
  for (const [fid, filePath] of filePaths.entries()) {
    if (isGeneratedOrLockfile(filePath, fileSamples.get(fid) ?? [])) {
      generatedFileIds.add(fid);
    }
  }

  const mandatory = mandatoryRemovalMask(sourceLines.length, mandatoryImportRemovalPlan(sourceLines, layout));
  const exactMoves = detectExactMoves(sourceLines, layout);
  applyMandatoryMovePrecedence(exactMoves, mandatory);

  const moveMask = new Uint8Array(sourceLines.length);
  const moveMarker = new Map<number, string>();
  let exactMovePairs = 0;

  for (const mv of exactMoves) {
    const remIdx: number[] = [];
    const addIdx: number[] = [];
    for (let ln = mv.removed.startLine; ln <= mv.removed.endLine; ln++) {
      const idx = ln - 1;
      if (idx >= 0 && idx < sourceLines.length && !mandatory[idx] && !generatedFileIds.has(arrayAt(layout.fileId, idx))) {
        remIdx.push(idx);
        moveMask[idx] = 1;
      }
    }
    for (let ln = mv.added.startLine; ln <= mv.added.endLine; ln++) {
      const idx = ln - 1;
      if (idx >= 0 && idx < sourceLines.length && !mandatory[idx] && !generatedFileIds.has(arrayAt(layout.fileId, idx))) {
        addIdx.push(idx);
        moveMask[idx] = 1;
      }
    }
    if (remIdx.length > 0 && addIdx.length > 0) {
      const remStart = remIdx[0]! + 1;
      const remEnd = remIdx[remIdx.length - 1]! + 1;
      const addStart = addIdx[0]! + 1;
      const addEnd = addIdx[addIdx.length - 1]! + 1;
      moveMarker.set(remIdx[0]!, `-... [moved ${remIdx.length}L -> L${addStart}-${addEnd}]`);
      moveMarker.set(addIdx[0]!, `+... [moved ${addIdx.length}L <- L${remStart}-${remEnd}]`);
      exactMovePairs++;
    }
  }

  let importLines = 0;
  let moveLines = 0;
  let generatedLines = 0;
  let behavioralLines = 0;
  const hunkHasVisibleChange = new Set<number>();
  const fileHasHunks = new Set<number>();
  const fileHasKeptHunk = new Set<number>();

  for (let i = 0; i < sourceLines.length; i++) {
    const fid = arrayAt(layout.fileId, i);
    const hid = arrayAt(layout.hunkId, i);
    if (fid >= 0 && generatedFileIds.has(fid)) {
      if (isChangedAt(i)) generatedLines++;
      continue;
    }
    if (fid >= 0 && hid >= 0) fileHasHunks.add(fid);
    if (isChangedAt(i)) {
      if (mandatory[i]) {
        importLines++;
      } else if (moveMask[i] === 1) {
        moveLines++;
      } else {
        behavioralLines++;
        if (hid >= 0) {
          hunkHasVisibleChange.add(hid);
          if (fid >= 0) fileHasKeptHunk.add(fid);
        }
      }
    }
    if (hid >= 0 && moveMarker.has(i)) {
      hunkHasVisibleChange.add(hid);
      if (fid >= 0) fileHasKeptHunk.add(fid);
    }
  }

  const outLines: string[] = [];
  const emittedGenerated = new Set<number>();
  for (let i = 0; i < sourceLines.length; i++) {
    const fid = arrayAt(layout.fileId, i);
    const hid = arrayAt(layout.hunkId, i);
    if (fid >= 0 && generatedFileIds.has(fid)) {
      if (!emittedGenerated.has(fid)) {
        emittedGenerated.add(fid);
        const filePath = filePaths.get(fid) ?? "generated";
        const counts = fileChangeCounts.get(fid) ?? { adds: 0, deletes: 0 };
        outLines.push(`diff --git a/${filePath} b/${filePath}`);
        outLines.push(`... [generated/lockfile omitted: +${counts.adds} -${counts.deletes} lines in ${filePath}]`);
      }
      continue;
    }
    if (fid >= 0 && fileHasHunks.has(fid) && !fileHasKeptHunk.has(fid)) continue;
    if (hid >= 0 && !hunkHasVisibleChange.has(hid)) continue;
    if (arrayAt(layout.kinds, i) === "no_newline") {
      const owner = arrayAt(layout.markerOwner, i);
      if (owner >= 0 && (mandatory[owner] || moveMask[owner] === 1)) continue;
    }
    if (mandatory[i]) continue;
    if (moveMask[i] === 1) {
      const marker = moveMarker.get(i);
      if (marker !== undefined) outLines.push(marker);
      continue;
    }
    outLines.push(decodeUTF8(arrayAt(sourceLines, i).text));
  }

  const noiseLines = importLines + moveLines + generatedLines;
  const noiseReductionPct = totalChangedLines > 0 ? Math.round((noiseLines / totalChangedLines) * 100) : 0;

  return {
    totalChangedLines,
    importLines,
    moveLines,
    generatedLines,
    behavioralLines,
    noiseReductionPct,
    exactMovePairs,
    omittedFiles: fileHasHunks.size - fileHasKeptHunk.size,
    generatedFiles: generatedFileIds.size,
    matchedFiles,
    compilerEligible: true,
    compilerReason: null,
    lines: outLines,
  };
}

export function formatDiffLookMeat(diff: Uint8Array, p: DiffPalette, options: MeatDiffOptions = {}): string {
  const filter = options.fileFilter?.trim() ?? "";
  const effective = filter !== "" ? filterDiffByFile(diff, filter) : { diff, matchedFiles: -1 };
  if (filter !== "" && effective.matchedFiles === 0) {
    return `length  +0 -0 ~0\nfilter  ${filter} (0 files matched)\nmeat    0 meat / 0 changed (0% noise: 0 imp, 0 mov)\nshape   \n\n(no files matched filter ${JSON.stringify(filter)})\n`;
  }
  const shape = observeDiffShape(effective.diff);
  const projected = compileMeatDiff(effective.diff);
  const marks = shape.slots.map(markFor).join("");
  const lines: string[] = [`length  +${shape.adds} -${shape.deletes} ~${shape.context}`];
  if (filter !== "") lines.push(`filter  ${filter} (${effective.matchedFiles} file(s) matched)`);
  if (projected.compilerEligible) {
    const extras: string[] = [
      `${projected.importLines} imp`,
      `${projected.moveLines} mov`,
    ];
    if (projected.generatedLines > 0) extras.push(`${projected.generatedLines} gen`);
    if (projected.exactMovePairs > 0) extras.push(`${projected.exactMovePairs} move pair(s)`);
    if (projected.omittedFiles > 0) extras.push(`${projected.omittedFiles} import-only file(s) omitted`);
    if (projected.generatedFiles > 0) extras.push(`${projected.generatedFiles} generated/lockfile(s) folded`);
    lines.push(
      `meat    ${projected.behavioralLines} meat / ${projected.totalChangedLines} changed (${projected.noiseReductionPct}% noise: ${extras.join(", ")})`,
    );
  } else {
    lines.push(`meat    compiler skipped (${projected.compilerReason ?? "unsupported diff"}); showing raw diff`);
  }
  for (const row of wrapMarks(marks, SHAPE_WRAP)) {
    lines.push(`shape   ${colorizeShapeMarks(row, p)}`);
  }
  lines.push("");
  if (projected.lines.length === 0) {
    lines.push("(all changed lines were proven imports)");
  } else {
    for (const line of projected.lines) {
      lines.push(colorizeDiffLine(line, p));
    }
  }
  return lines.join("\n") + "\n";
}
