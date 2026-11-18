import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { handleMcpMessage, MCP_RESOURCES, MCP_TOOLS } from "../../src/cli/mcp.ts";

const mainPath = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const linuxTtyDiffPath = fileURLToPath(new URL("../../testdata/linux/linux-tty-b6793a9e2a3c.diff", import.meta.url));

function runMcpSession(messages: readonly unknown[], extraArgs: readonly string[] = []) {
  const input = messages.map(m => (typeof m === "string" ? m : JSON.stringify(m))).join("\n") + "\n";
  const env = { ...process.env };
  delete env["OPENAI_API_KEY"];
  delete env["ANTHROPIC_API_KEY"];
  delete env["XAI_API_KEY"];
  const res = spawnSync(process.execPath, [mainPath, "mcp", ...extraArgs], {
    input,
    encoding: "utf8",
    env,
  });
  const lines = res.stdout
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => JSON.parse(l));
  return { status: res.status, stderr: res.stderr, responses: lines };
}

test("columbo mcp negotiates protocol versions, lists 4 tools with outputSchema and 2 resources, and executes real Linux diff tools over stdio", () => {
  const linuxDiff = readFileSync(linuxTtyDiffPath, "utf8");
  const session = runMcpSession([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2026-07-28", capabilities: {}, clientInfo: { name: "mcporter", version: "1.0.0" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "ping" },
    { jsonrpc: "2.0", id: 3, method: "tools/list" },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "triage_diff", arguments: { diff: linuxDiff, top: 3, risk: "high" } } },
    { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "read_meat_diff", arguments: { diff: linuxDiff, file: "8250_hp300.c", maxBytes: 4096 } } },
    { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "read_meat_diff", arguments: { diff: linuxDiff, maxBytes: 300 } } },
    { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "analyze_statechart", arguments: { diff: linuxDiff } } },
    { jsonrpc: "2.0", id: 8, method: "resources/list" },
    { jsonrpc: "2.0", id: 9, method: "resources/read", params: { uri: "columbo://triage-schema" } },
  ]);

  assert.equal(session.status, 0, session.stderr);
  assert.equal(session.responses.length, 9);

  const init = session.responses[0];
  assert.equal(init.id, 1);
  assert.equal(init.result.protocolVersion, "2026-07-28");
  assert.equal(init.result.serverInfo.name, "columbo");

  const ping = session.responses[1];
  assert.equal(ping.id, 2);
  assert.deepEqual(ping.result, {});

  const list = session.responses[2];
  assert.equal(list.id, 3);
  assert.deepEqual(list.result.tools.map((t: { name: string }) => t.name), MCP_TOOLS.map(t => t.name));
  assert.ok(list.result.tools.every((t: { outputSchema?: unknown }) => typeof t.outputSchema === "object" && t.outputSchema !== null));

  const triage = session.responses[3];
  assert.equal(triage.id, 4);
  assert.equal(triage.result.structuredContent.schema, "columbo.triage.v1");
  assert.equal(triage.result.structuredContent.deterministicTruth.behavioralLines, 100);
  assert.equal(triage.result.structuredContent.deterministicTruth.exactMovePairs, 2);
  assert.equal(triage.result.structuredContent.heuristicTriage.reviewOrder.length, 3);
  assert.ok(triage.result.structuredContent.heuristicTriage.reviewOrder.every((r: { risk: string }) => r.risk === "high"));

  const meatSingle = session.responses[4];
  assert.equal(meatSingle.id, 5);
  assert.equal(meatSingle.result.structuredContent.fileFilter, "8250_hp300.c");
  assert.equal(meatSingle.result.structuredContent.exactMovePairs, 2);
  assert.equal(meatSingle.result.structuredContent.truncated, false);
  assert.match(meatSingle.result.content[0].text, /-\.\.\. \[moved 15L -> L\d+-\d+\]/);

  const meatBounded = session.responses[5];
  assert.equal(meatBounded.id, 6);
  assert.equal(meatBounded.result.structuredContent.truncated, true);
  assert.ok(meatBounded.result.structuredContent.returnedBytes <= 300);
  assert.match(meatBounded.result.content[0].text, /truncated at/);

  const statechart = session.responses[6];
  assert.equal(statechart.id, 7);
  assert.equal(statechart.result.structuredContent.evidenceLabel, "Diff-traced");
  assert.match(statechart.result.structuredContent.mermaid, /stateDiagram-v2/);

  const resList = session.responses[7];
  assert.equal(resList.id, 8);
  assert.deepEqual(resList.result.resources.map((r: { uri: string }) => r.uri), MCP_RESOURCES.map(r => r.uri));

  const resRead = session.responses[8];
  assert.equal(resRead.id, 9);
  const schemaDoc = JSON.parse(resRead.result.contents[0].text);
  assert.equal(schemaDoc.schema, "columbo.triage.v1");
  assert.equal(schemaDoc.heuristicTriage.notSafetyProof, true);
});

test("columbo mcp --codemode collapses tools into single exec(code) with Promise.all chaining, store/load memory, and sandbox isolation", () => {
  const linuxDiff = readFileSync(linuxTtyDiffPath, "utf8");
  const turn1Code = `
    const diff = ${JSON.stringify(linuxDiff)};
    const triage = await tools.triageDiff({ diff, risk: "high", top: 2 });
    store("triage", triage);
    const diffs = await Promise.all(
      triage.heuristicTriage.reviewOrder.map(f => tools.readMeatDiff({ diff, file: f.file, maxBytes: 4096 }))
    );
    text(diffs.map(d => d.fileFilter + ":" + d.behavioralLines + "m/" + d.moveLines + "mov").join(" | "));
  `;
  const turn2Code = `
    const cached = load("triage");
    return {
      filesChanged: cached.deterministicTruth.filesChanged,
      topFile: cached.heuristicTriage.reviewOrder[0].file,
      toolCount: Object.keys(ALL_TOOLS).length,
    };
  `;
  const session = runMcpSession([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2026-07-28" } },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "exec", arguments: { code: turn1Code } } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "exec", arguments: { code: turn2Code } } },
    { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "triage_diff", arguments: { diff: linuxDiff } } },
    { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "exec", arguments: { code: "return typeof process + ':' + typeof require;" } } },
    { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "exec", arguments: { code: "eval('1+1');" } } },
    { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "exec", arguments: { code: "text('x'.repeat(1000));", maxBytes: 256 } } },
  ], ["--codemode"]);

  assert.equal(session.status, 0, session.stderr);
  assert.equal(session.responses.length, 8);

  assert.equal(session.responses[0].result.serverInfo.name, "columbo-codemode");

  const listed = session.responses[1].result.tools;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].name, "exec");
  assert.match(listed[0].description, /declare namespace tools/);
  assert.match(listed[0].description, /declare function store/);
  assert.ok(listed[0].outputSchema);

  const turn1 = session.responses[2].result;
  assert.equal(turn1.structuredContent.toolCalls, 3);
  assert.deepEqual(turn1.structuredContent.storedKeys, ["triage"]);
  assert.match(turn1.content[0].text, /serial_core\.c:25m\/0mov/);
  assert.match(turn1.content[0].text, /8250_hp300\.c:12m\/50mov/);

  const turn2 = session.responses[3].result;
  assert.equal(turn2.structuredContent.toolCalls, 0);
  const turn2Parsed = JSON.parse(turn2.content[0].text);
  assert.equal(turn2Parsed.filesChanged, 13);
  assert.equal(turn2Parsed.topFile, "drivers/tty/serial/serial_core.c");
  assert.equal(turn2Parsed.toolCount, 4);

  assert.equal(session.responses[4].error.code, -32602);
  assert.equal(session.responses[5].result.content[0].text, "undefined:undefined");
  assert.equal(session.responses[6].result.isError, true);
  assert.equal(session.responses[7].result.structuredContent.truncated, true);
  assert.ok(session.responses[7].result.structuredContent.returnedBytes <= 256);
});

test("columbo mcp handles invalid JSON, unknown methods, unknown tools, and tool errors cleanly", async () => {
  const session = runMcpSession([
    "{not valid json",
    { jsonrpc: "2.0", id: 10, method: "unknown/method" },
    { jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "nonexistent_tool", arguments: {} } },
    { jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "triage_diff", arguments: { diff: "   \n" } } },
  ]);

  assert.equal(session.status, 0, session.stderr);
  assert.equal(session.responses.length, 4);
  assert.equal(session.responses[0].error.code, -32700);
  assert.equal(session.responses[1].error.code, -32601);
  assert.equal(session.responses[2].error.code, -32602);
  assert.equal(session.responses[3].result.isError, true);

  const fallbackInit = await handleMcpMessage(
    { jsonrpc: "2.0", id: 99, method: "initialize", params: { protocolVersion: "1999-01-01" } },
    { readSource: async () => ({ diff: new Uint8Array(0), source: "mock" }), version: "0.0.0", guideText: "guide" },
  );
  assert.equal((fallbackInit?.result as { protocolVersion: string }).protocolVersion, "2025-06-18");
});

test("columbo mcp --help and capabilities --json register mcp cleanly", () => {
  const help = spawnSync(process.execPath, [mainPath, "mcp", "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /columbo mcp \[--codemode\]/);

  const caps = spawnSync(process.execPath, [mainPath, "capabilities", "--json"], { encoding: "utf8" });
  assert.equal(caps.status, 0);
  const parsed = JSON.parse(caps.stdout);
  assert.ok(parsed.data.offline_commands.includes("mcp"));
});
