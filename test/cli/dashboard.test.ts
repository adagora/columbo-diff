import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeDiffXray, buildDashboardPayload, collectRepoStatus, summarizeDiffFiles } from "../../src/cli/dashboard.ts";

test("summarizeDiffFiles computes per-file add/delete counts and risk classification", () => {
  const diff = [
    "diff --git a/src/retry.ts b/src/retry.ts",
    "--- a/src/retry.ts",
    "+++ b/src/retry.ts",
    "@@ -1,2 +1,7 @@",
    "+let state = 'retrying';",
    "+try {",
    "+  await retryAttempt();",
    "+  throw new Error('boom');",
    "+}",
    "diff --git a/README.md b/README.md",
    "--- a/README.md",
    "+++ b/README.md",
    "@@ -1,2 +1,2 @@",
    "-old",
    "+new",
  ].join("\n");

  const files = summarizeDiffFiles(diff);
  assert.equal(files.length, 2);
  assert.equal(files[0]?.file, "src/retry.ts");
  assert.equal(files[0]?.adds, 5);
  assert.equal(files[0]?.risk, "high");
  assert.equal(files[1]?.file, "README.md");
  assert.equal(files[1]?.deletes, 1);
  assert.equal(files[1]?.risk, "low");
});

test("analyzeDiffXray classifies imports, exact moves, behavioral lines, and compiler-stripped meatPatch", () => {
  const diff = [
    "diff --git a/old.ts b/old.ts",
    "--- a/old.ts",
    "+++ b/old.ts",
    "@@ -1,5 +1,1 @@",
    "-import { alpha } from './a.ts';",
    "+import { beta } from './b.ts';",
    "-function relocatedHelper(input: string): string {",
    "-  const trimmed = input.trim();",
    "-  return trimmed.toUpperCase();",
    "-}",
    "diff --git a/new.ts b/new.ts",
    "--- a/new.ts",
    "+++ b/new.ts",
    "@@ -1 +1,6 @@",
    " const ready = true;",
    "+function relocatedHelper(input: string): string {",
    "+  const trimmed = input.trim();",
    "+  return trimmed.toUpperCase();",
    "+}",
    "+const behavioralChange = beta();",
  ].join("\n");

  const files = summarizeDiffFiles(diff);
  const xray = analyzeDiffXray(diff, files);

  assert.equal(xray.compilerEligible, true);
  assert.equal(xray.importLines, 2);
  assert.ok(xray.moves.length >= 1);
  assert.ok(xray.moveLines >= 6);
  assert.equal(xray.behavioralLines, 1);
  assert.ok(xray.noiseReductionPct > 50);
  assert.ok(files[0]?.meatPatch.includes("import") === false);
  assert.equal(xray.fitsSingleRun, true);
  assert.equal(xray.partitionCount, 1);
});

test("collectRepoStatus and buildDashboardPayload handle non-git directories gracefully", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "columbo-dash-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const repo = collectRepoStatus(dir);
  assert.equal(repo.isGitRepo, false);
  assert.deepEqual(repo.commits, []);

  const payload = await buildDashboardPayload(
    "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n",
    "test",
    dir,
  );
  assert.equal(payload.shape.adds, 1);
  assert.equal(payload.shape.deletes, 1);
  assert.equal(payload.files.length, 1);
  assert.equal(payload.repo.isGitRepo, false);
  assert.equal(payload.ledger.available, false);
  assert.ok(payload.xray.inputSha256.length === 64);
  assert.ok(payload.nodeFileMap["executing"] === "a.ts");
  assert.ok(payload.doctor.node.length > 0);
  assert.equal(payload.agentTriage.schema, "columbo.triage.v1");
  assert.equal(payload.agentTriage.heuristicTriage.notSafetyProof, true);
  assert.equal(payload.agentTriage.deterministicTruth.inputSha256, payload.xray.inputSha256);
});

test("summarizeDiffFiles elevates removed branch guards to high risk and ignores pre-hunk preamble", () => {
  const diff = [
    "From: Author <author@example.com>",
    "Subject: [PATCH] auth tweak",
    "+not a diff line",
    "-also not a diff line",
    "diff --git \"a/src/auth guard.ts\" \"b/src/auth guard.ts\"",
    "--- \"a/src/auth guard.ts\"",
    "+++ \"b/src/auth guard.ts\"",
    "@@ -1,4 +1,2 @@ function allow(user) {",
    "-  if (!user.isAdmin) return false;",
    "   return true;",
  ].join("\n");

  const files = summarizeDiffFiles(diff);
  assert.equal(files.length, 1);
  assert.equal(files[0]?.file, "src/auth guard.ts");
  assert.equal(files[0]?.adds, 0);
  assert.equal(files[0]?.deletes, 1);
  assert.equal(files[0]?.removedGuardSignals, 1);
  assert.equal(files[0]?.risk, "high");
});

test("analyzeDiffXray clears meatPatch when all changed lines are compiler-stripped imports", () => {
  const diff = [
    "diff --git a/src/only_imports.ts b/src/only_imports.ts",
    "--- a/src/only_imports.ts",
    "+++ b/src/only_imports.ts",
    "@@ -1,1 +1,1 @@",
    "-import { alpha } from './a.ts';",
    "+import { beta } from './b.ts';",
  ].join("\n");

  const files = summarizeDiffFiles(diff);
  const xray = analyzeDiffXray(diff, files);
  assert.equal(xray.compilerEligible, true);
  assert.equal(xray.importLines, 2);
  assert.equal(xray.behavioralLines, 0);
  assert.equal(files[0]?.meatPatch, "");
});

test("buildDashboardPayload maps statechart nodes to highest-signal files and honors includeLedger: false", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "columbo-dash-map-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const diff = [
    "diff --git a/MAINTAINERS b/MAINTAINERS",
    "--- a/MAINTAINERS",
    "+++ b/MAINTAINERS",
    "@@ -1,2 +1,2 @@",
    "-M: Old Maintainer",
    "+M: New Maintainer",
    "diff --git a/drivers/usb/xhci-ring.c b/drivers/usb/xhci-ring.c",
    "--- a/drivers/usb/xhci-ring.c",
    "+++ b/drivers/usb/xhci-ring.c",
    "@@ -10,2 +10,8 @@ static int xhci_handle_tx(void)",
    "+  spin_lock_irqsave(&xhci->lock, flags);",
    "+  if (IS_ERR_OR_NULL(ring)) {",
    "+    WARN_ON_ONCE(1);",
    "+    return -EINVAL;",
    "+  }",
    "+  spin_unlock_irqrestore(&xhci->lock, flags);",
  ].join("\n");

  const payload = await buildDashboardPayload(diff, "linux-usb-mini", dir, { includeLedger: false });
  assert.equal(payload.ledger.available, false);
  assert.equal(payload.nodeFileMap["failed"], "drivers/usb/xhci-ring.c");
  assert.equal(payload.nodeFileMap["guarded"], "drivers/usb/xhci-ring.c");
  assert.equal(payload.nodeFileMap["executing"], "drivers/usb/xhci-ring.c");
  assert.equal(payload.statechart.nodes.find(n => n.id === "failed")?.sourceRef, "drivers/usb/xhci-ring.c");
  assert.equal(payload.agentTriage.heuristicTriage.reviewOrder[0]?.file, "drivers/usb/xhci-ring.c");
  assert.equal(payload.agentTriage.heuristicTriage.reviewOrder[0]?.risk, "high");
  assert.ok(payload.agentTriage.heuristicTriage.reviewOrder[0]?.reasons.some(r => r.includes("error/recovery")));
});
