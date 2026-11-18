import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeDiffForStatechart, formatStatechartReport, getReferenceStatecharts, renderMermaidStatechart } from "../../src/cli/statechart.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const cli = join(root, "src/cli/main.ts");
const runCli = (args: string[], input = "") => spawnSync(process.execPath, [cli, ...args], {
  cwd: root,
  input,
  encoding: "utf8",
  timeout: 10_000,
  env: { ...process.env, OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", XAI_API_KEY: "", COLUMBO_CACHE: "" },
});

const statefulDiff = [
  "diff --git a/src/job.ts b/src/job.ts",
  "--- a/src/job.ts",
  "+++ b/src/job.ts",
  "@@ -10,4 +10,12 @@ async function runJob(signal: AbortController) {",
  "+  let status = 'pending';",
  "+  if (signal.signal.aborted) {",
  "+    throw new Error('cancelled');",
  "+  }",
  "+  try {",
  "+    await retryWithBackoff(runStep);",
  "+    status = 'done';",
  "+  } catch (err) {",
  "+    status = 'failed';",
  "+  }",
].join("\n");

test("analyzeDiffForStatechart recommends a statechart when diff touches state, error, and retry paths", () => {
  const result = analyzeDiffForStatechart(statefulDiff, "job.ts");
  assert.equal(result.evidenceLabel, "Diff-traced");
  assert.equal(result.shouldGenerate, true);
  assert.ok(result.signals.errorPaths >= 2);
  assert.ok(result.signals.retryCancel >= 2);
  assert.ok(result.signals.stateMutations >= 2);
  assert.match(result.mermaid, /^stateDiagram-v2/);
  assert.match(result.mermaid, /\[\+\]/);
  assert.ok(result.invariants.length >= 2);
  assert.ok(result.failureWalkthrough.length >= 3);
  const text = formatStatechartReport(result);
  assert.match(text, /Invariants to check:/);
  assert.match(text, /```mermaid/);
});

test("analyzeDiffForStatechart marks trivial diffs as not needing a statechart", () => {
  const diff = [
    "diff --git a/README.md b/README.md",
    "--- a/README.md",
    "+++ b/README.md",
    "@@ -1,2 +1,2 @@",
    "-Hello world",
    "+Hello columbo",
  ].join("\n");

  const result = analyzeDiffForStatechart(diff, "docs");
  assert.equal(result.shouldGenerate, false);
  assert.equal(result.signals.filesChanged, 1);
  assert.match(result.triggerReason, /Optional \/ low signal/);
});

test("getReferenceStatecharts provides source-traced charts with walkthroughs and valid Mermaid", () => {
  const refs = getReferenceStatecharts();
  assert.equal(refs.length, 3);
  for (const ref of refs) {
    assert.equal(ref.evidenceLabel, "Implementation-traced");
    assert.ok(ref.invariants.length >= 2);
    assert.ok(ref.failureWalkthrough.length >= 3);
    for (const step of ref.failureWalkthrough) {
      assert.ok(ref.nodes.some(n => n.id === step.activeNodeId));
      if (step.activeEdgeId) {
        assert.ok(ref.edges.some(e => e.id === step.activeEdgeId));
      }
    }
    const rendered = renderMermaidStatechart(ref.nodes, ref.edges);
    assert.equal(ref.mermaid, rendered);
    assert.match(rendered, /\[\*\] --> /);
  }
});

test("columbo statechart CLI returns offline JSON envelope and plain-text report without TLA+", () => {
  const jsonRun = runCli(["statechart", "--stdin", "--json"], statefulDiff);
  assert.equal(jsonRun.status, 0, jsonRun.stderr);
  assert.equal(jsonRun.stderr, "");
  const parsed = JSON.parse(jsonRun.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.command, "statechart");
  assert.equal(parsed.data.kind, "columbo.statechart");
  assert.equal(parsed.data.tla_required, false);
  assert.equal(parsed.data.should_generate, true);
  assert.match(parsed.data.starter_mermaid, /^stateDiagram-v2/);

  const textRun = runCli(["statechart", "--stdin"], statefulDiff);
  assert.equal(textRun.status, 0, textRun.stderr);
  assert.match(textRun.stdout, /Diff reading view: stdin/);
  assert.match(textRun.stdout, /stateDiagram-v2/);

  const emptyRun = runCli(["statechart", "--stdin", "--json"], "   \n");
  assert.equal(emptyRun.status, 1);
  assert.equal(JSON.parse(emptyRun.stdout).error.kind, "empty_diff");

  const helpRun = runCli(["statechart", "--help"]);
  assert.equal(helpRun.status, 0);
  assert.match(helpRun.stdout, /columbo statechart/);

  const caps = JSON.parse(runCli(["capabilities", "--json"]).stdout);
  assert.ok(caps.data.offline_commands.includes("statechart"));
});

test("analyzeDiffForStatechart detects removed branch guards and C/kernel error and lock idioms", () => {
  const diff = [
    "diff --git a/DOCS.md b/DOCS.md",
    "--- a/DOCS.md",
    "+++ b/DOCS.md",
    "@@ -1 +1 @@",
    "-a",
    "+b",
    "diff --git a/drivers/serial.c b/drivers/serial.c",
    "--- a/drivers/serial.c",
    "+++ b/drivers/serial.c",
    "@@ -20,4 +20,6 @@ static int serial_write(struct port *p)",
    "-  if (!p->authorized) return -EPERM;",
    "+  spin_lock_irqsave(&p->lock, flags);",
    "+  if (IS_ERR_OR_NULL(p->gpio))",
    "+    return -EINVAL;",
    "+  spin_unlock_irqrestore(&p->lock, flags);",
  ].join("\n");

  const result = analyzeDiffForStatechart(diff, "kernel-serial");
  assert.equal(result.shouldGenerate, true);
  assert.equal(result.signals.removedGuards, 1);
  assert.ok(result.signals.errorPaths >= 2);
  assert.ok(result.signals.asyncConcurrency >= 2);
  assert.ok(result.edges.some(e => e.id === "e_removed" && e.kind === "removed"));
  assert.equal(result.nodes.find(n => n.id === "failed")?.sourceRef, "drivers/serial.c");
  assert.equal(result.nodes.find(n => n.id === "guarded")?.sourceRef, "drivers/serial.c");
});
