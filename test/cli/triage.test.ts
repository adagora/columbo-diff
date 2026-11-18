import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeUTF8 } from "../../src/meat/bytes.ts";
import { parseFlags } from "../../src/cli/main.ts";
import { compileMeatDiff, formatDiffLookMeat } from "../../src/cli/shape.ts";

const mainPath = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const linuxTtyDiffPath = fileURLToPath(new URL("../../testdata/linux/linux-tty-b6793a9e2a3c.diff", import.meta.url));
const plainPalette = { meta: "", frag: "", old: "", new: "" };

function runCli(args: readonly string[], input?: string) {
  const env = { ...process.env };
  delete env["OPENAI_API_KEY"];
  delete env["ANTHROPIC_API_KEY"];
  delete env["XAI_API_KEY"];
  return spawnSync(process.execPath, [mainPath, ...args], {
    input,
    encoding: "utf8",
    env,
  });
}

const mixedNoiseAndGuardDiff = [
  "diff --git a/imports_only.ts b/imports_only.ts",
  "--- a/imports_only.ts",
  "+++ b/imports_only.ts",
  "@@ -1,2 +1,2 @@",
  "-import { oldA } from './a.ts';",
  "+import { newA } from './a.ts';",
  " export const keep = 1;",
  "diff --git a/src/relocate.ts b/src/relocate.ts",
  "--- a/src/relocate.ts",
  "+++ b/src/relocate.ts",
  "@@ -1,6 +1,2 @@",
  "-import { x } from './x.ts';",
  "+import { y } from './y.ts';",
  "-function relocatedHelper(input: string): string {",
  "-  const trimmed = input.trim();",
  "-  return trimmed.toUpperCase();",
  "-}",
  " export const anchor = true;",
  "diff --git a/src/auth.ts b/src/auth.ts",
  "--- a/src/auth.ts",
  "+++ b/src/auth.ts",
  "@@ -1,5 +1,7 @@",
  " const ready = true;",
  "+function relocatedHelper(input: string): string {",
  "+  const trimmed = input.trim();",
  "+  return trimmed.toUpperCase();",
  "+}",
  "-if (!user.isAdmin) {",
  "-  return false;",
  "-}",
  "+const allowed = checkPolicy(user);",
  " return allowed;",
  "",
].join("\n");

test("columbo triage --stdin --json emits columbo.triage.v1 with deterministic truth and heuristic order", () => {
  const res = runCli(["triage", "--stdin", "--json"], mixedNoiseAndGuardDiff);
  assert.equal(res.status, 0, res.stderr);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.command, "triage");
  assert.equal(parsed.data.kind, "columbo.triage");
  assert.equal(parsed.data.schema, "columbo.triage.v1");
  assert.equal(parsed.data.source, "stdin");
  assert.equal(parsed.data.deterministicTruth.filesChanged, 3);
  assert.equal(parsed.data.deterministicTruth.strippedImportLines, 4);
  assert.equal(parsed.data.deterministicTruth.exactMovePairs, 1);
  assert.equal(parsed.data.deterministicTruth.exactMoveLines, 8);
  assert.equal(parsed.data.deterministicTruth.behavioralLines, 4);
  assert.equal(parsed.data.deterministicTruth.ledgerAvailable, false);
  assert.equal(parsed.data.heuristicTriage.notSafetyProof, true);
  assert.equal(parsed.data.heuristicTriage.reviewOrder[0].file, "src/auth.ts");
  assert.equal(parsed.data.heuristicTriage.reviewOrder[0].risk, "high");
  assert.ok(parsed.data.heuristicTriage.recommendedCommands.some((c: string) => c.includes("-look -meat-only")));
});

test("columbo triage supports plain-text output, help, empty_diff error, and capabilities registration", () => {
  const textRes = runCli(["triage", "--stdin"], mixedNoiseAndGuardDiff);
  assert.equal(textRes.status, 0, textRes.stderr);
  assert.match(textRes.stdout, /Columbo Offline Triage \(columbo\.triage\.v1\)/);
  assert.match(textRes.stdout, /NOT a safety proof/);
  assert.match(textRes.stdout, /\[HIGH\] src\/auth\.ts/);
  assert.match(textRes.stdout, /4 meat \/ 16 changed/);

  const emptyRes = runCli(["triage", "--stdin", "--json"], "   \n");
  assert.equal(emptyRes.status, 1);
  const emptyErr = JSON.parse(emptyRes.stdout);
  assert.equal(emptyErr.ok, false);
  assert.equal(emptyErr.error.kind, "empty_diff");

  const helpRes = runCli(["triage", "--help"]);
  assert.equal(helpRes.status, 0);
  assert.match(helpRes.stdout, /columbo triage/);

  const helpTopicRes = runCli(["help", "triage"]);
  assert.equal(helpTopicRes.status, 0);
  assert.match(helpTopicRes.stdout, /columbo\.triage\.v1/);

  const capsRes = runCli(["capabilities", "--json"]);
  assert.equal(capsRes.status, 0);
  const caps = JSON.parse(capsRes.stdout);
  assert.ok(caps.data.offline_commands.includes("triage"));
});

test("compileMeatDiff and -look -meat-only strip imports, omit import-only files, and collapse exact moves", (t) => {
  const projected = compileMeatDiff(encodeUTF8(mixedNoiseAndGuardDiff));
  assert.equal(projected.compilerEligible, true);
  assert.equal(projected.importLines, 4);
  assert.equal(projected.moveLines, 8);
  assert.equal(projected.behavioralLines, 4);
  assert.equal(projected.exactMovePairs, 1);
  assert.equal(projected.omittedFiles, 1);
  const joined = projected.lines.join("\n");
  assert.ok(!joined.includes("imports_only.ts"));
  assert.ok(!joined.includes("import { oldA }"));
  assert.ok(!joined.includes("import { x }"));
  assert.ok(!joined.includes("const trimmed = input.trim();"));
  assert.match(joined, /-\.\.\. \[moved 4L -> L\d+-\d+\]/);
  assert.match(joined, /\+\.\.\. \[moved 4L <- L\d+-\d+\]/);
  assert.ok(joined.includes("-if (!user.isAdmin) {"));
  assert.ok(joined.includes("+const allowed = checkPolicy(user);"));

  const dir = mkdtempSync(join(tmpdir(), "columbo-look-meat-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const outPath = join(dir, "meat.diff");

  const cliRes = runCli(["-look", "--meat-only", "-o", outPath], mixedNoiseAndGuardDiff);
  assert.equal(cliRes.status, 0, cliRes.stderr);
  const out = readFileSync(outPath, "utf8");
  assert.match(out, /meat\s+4 meat \/ 16 changed \(75% noise: 4 imp, 8 mov, 1 move pair\(s\), 1 import-only file\(s\) omitted\)/);
  assert.ok(out.includes("+const allowed = checkPolicy(user);"));
  assert.ok(!out.includes("imports_only.ts"));
});

test("formatDiffLookMeat handles pure-import diffs and binary fallback gracefully", () => {
  const pureImports = [
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1 +1 @@",
    "-import { a } from './a.ts';",
    "+import { b } from './b.ts';",
    "",
  ].join("\n");
  const pureOut = formatDiffLookMeat(encodeUTF8(pureImports), plainPalette);
  assert.match(pureOut, /0 meat \/ 2 changed \(100% noise: 2 imp, 0 mov, 1 import-only file\(s\) omitted\)/);
  assert.ok(pureOut.includes("(all changed lines were proven imports)"));

  const combinedDiff = [
    "diff --cc src/merge.ts",
    "index 1111111,2222222..3333333",
    "--- a/src/merge.ts",
    "+++ b/src/merge.ts",
    "@@@ -1,1 -1,1 +1,2 @@@",
    "  keep",
    "++merged",
    "",
  ].join("\n");
  const combinedOut = formatDiffLookMeat(encodeUTF8(combinedDiff), plainPalette);
  assert.match(combinedOut, /compiler skipped/);
  assert.ok(combinedOut.includes("diff --cc src/merge.ts"));
});

test("parseFlags and CLI reject -meat-only without -look or alongside -doctor", () => {
  assert.equal(parseFlags(["-meat-only"]).kind, "error");
  assert.equal(parseFlags(["-doctor", "-meat-only"]).kind, "error");
  const ok = parseFlags(["-look", "-meat-only", "HEAD"]);
  assert.equal(ok.kind, "ok");
  if (ok.kind === "ok") {
    assert.equal(ok.flags.look, true);
    assert.equal(ok.flags.meatOnly, true);
  }
  const badCli = runCli(["-meat-only"], mixedNoiseAndGuardDiff);
  assert.equal(badCli.status, 2);
  assert.match(badCli.stderr, /-meat-only applies only to -look/);
});

test("columbo -look -meat-only and columbo triage work on real torvalds/linux tty-7.4-rc4 diff", () => {
  const linuxDiff = readFileSync(linuxTtyDiffPath, "utf8");
  const meatRes = runCli(["-look", "-meat-only"], linuxDiff);
  assert.equal(meatRes.status, 0, meatRes.stderr);
  assert.match(meatRes.stdout, /100 meat \/ 150 changed \(33% noise: 0 imp, 50 mov, 2 move pair\(s\)\)/);
  assert.match(meatRes.stdout, /-\.\.\. \[moved 15L -> L\d+-\d+\]/);
  assert.match(meatRes.stdout, /\+\.\.\. \[moved 15L <- L\d+-\d+\]/);
  assert.match(meatRes.stdout, /-\.\.\. \[moved 10L -> L\d+-\d+\]/);
  assert.match(meatRes.stdout, /\+\.\.\. \[moved 10L <- L\d+-\d+\]/);

  const triageRes = runCli(["triage", "--stdin", "--json"], linuxDiff);
  assert.equal(triageRes.status, 0, triageRes.stderr);
  const parsed = JSON.parse(triageRes.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.data.deterministicTruth.filesChanged, 13);
  assert.equal(parsed.data.deterministicTruth.behavioralLines, 100);
  assert.equal(parsed.data.deterministicTruth.exactMoveLines, 50);
  assert.equal(parsed.data.deterministicTruth.exactMovePairs, 2);
});

test("compileMeatDiff and triage fold lockfiles and generated files and support -file, --top, --risk, and --markdown", () => {
  const lockAndLogicDiff = [
    "diff --git a/package-lock.json b/package-lock.json",
    "--- a/package-lock.json",
    "+++ b/package-lock.json",
    "@@ -1,3 +1,5 @@",
    " {",
    "-  \"version\": \"1.0.0\"",
    "+  \"version\": \"1.0.1\",",
    "+  \"lockfileVersion\": 3,",
    "+  \"integrity\": \"sha512-abc\"",
    " }",
    "diff --git a/src/service.ts b/src/service.ts",
    "--- a/src/service.ts",
    "+++ b/src/service.ts",
    "@@ -1,3 +1,3 @@",
    " export function check(ok: boolean) {",
    "-  if (!ok) throw new Error('denied');",
    "+  if (!ok) return false;",
    " }",
    "",
  ].join("\n");

  const projected = compileMeatDiff(encodeUTF8(lockAndLogicDiff));
  assert.equal(projected.generatedFiles, 1);
  assert.equal(projected.generatedLines, 4);
  assert.equal(projected.behavioralLines, 2);
  assert.ok(projected.lines.some(l => l.includes("[generated/lockfile omitted: +3 -1 lines in package-lock.json]")));
  assert.ok(!projected.lines.some(l => l.includes("sha512-abc")));

  const fileFiltered = runCli(["-look", "-meat-only", "-file", "service.ts"], lockAndLogicDiff);
  assert.equal(fileFiltered.status, 0, fileFiltered.stderr);
  assert.match(fileFiltered.stdout, /filter\s+service\.ts \(1 file\(s\) matched\)/);
  assert.ok(fileFiltered.stdout.includes("src/service.ts"));
  assert.ok(!fileFiltered.stdout.includes("package-lock.json"));

  const noMatch = runCli(["-look", "-meat-only", "-file", "nonexistent.rs"], lockAndLogicDiff);
  assert.equal(noMatch.status, 0);
  assert.match(noMatch.stdout, /no files matched filter/);

  assert.equal(parseFlags(["-file", "a.ts"]).kind, "error");
  assert.equal(parseFlags(["-doctor", "-file", "a.ts"]).kind, "error");

  const md = runCli(["triage", "--stdin", "--markdown", "--top", "1", "--risk", "high"], lockAndLogicDiff);
  assert.equal(md.status, 0, md.stderr);
  assert.match(md.stdout, /^## Columbo Offline Triage/);
  assert.match(md.stdout, /4 gen/);
  assert.match(md.stdout, /`HIGH` \| `src\/service\.ts`/);
  assert.ok(!md.stdout.includes("| `package-lock.json` |"));

  const conflict = runCli(["triage", "--stdin", "--json", "--markdown"], lockAndLogicDiff);
  assert.equal(conflict.status, 2);
});

