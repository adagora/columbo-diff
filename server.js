import http from 'node:http';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const HOST = '0.0.0.0';

function resolveCliModule(relDist, relSrc) {
  const distPath = path.join(__dirname, relDist);
  return pathToFileURL(existsSync(distPath) ? distPath : path.join(__dirname, relSrc)).href;
}

const { buildDashboardPayload, collectRepoStatus } = await import(
  resolveCliModule('dist/cli/dashboard.js', 'src/cli/dashboard.ts')
);
const { analyzeDiffForStatechart, getReferenceStatecharts } = await import(
  resolveCliModule('dist/cli/statechart.js', 'src/cli/statechart.ts')
);

const SAMPLES = [
  { id: 'linux-tty', label: 'Linux tty-7.4-rc4 (b6793a9e)', file: 'testdata/linux/linux-tty-b6793a9e2a3c.diff' },
  { id: 'linux-usb', label: 'Linux usb-7.3-rc4 (f11fe760)', file: 'testdata/linux/linux-usb-f11fe7603df0.diff' },
  { id: 'flask', label: 'Flask session fix (c17f3793)', file: 'testdata/python/flask-c17f37939073.diff' },
  { id: 'django', label: 'Django ORM (526b1b41)', file: 'testdata/python/django-526b1b414d8e.diff' },
  { id: 'pytest', label: 'Pytest fixture (b4e84661)', file: 'testdata/python/pytest-b4e846616cbb.diff' },
  { id: 'go', label: 'Go net/dns (std)', file: 'analysis/site-demo-commits-2026-08-02/go.original.diff' },
  { id: 'rust', label: 'Helix LSP (Rust)', file: 'analysis/site-demo-commits-2026-08-02/rust.original.diff' },
];

function parseGitHubDiffRef(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  let m = /^https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(commit)\/([0-9a-fA-F]{6,40})(?:[/?#].*)?$/.exec(raw);
  if (m) {
    return { owner: m[1], repo: m[2], kind: 'commits', ref: m[4], label: `${m[1]}/${m[2]}@${m[4].slice(0, 10)}` };
  }
  m = /^https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(pull)\/([0-9]+)(?:\/(?:files|commits))?(?:[/?#].*)?$/.exec(raw);
  if (m) {
    return { owner: m[1], repo: m[2], kind: 'pulls', ref: m[4], label: `${m[1]}/${m[2]}#${m[4]}` };
  }
  m = /^https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/compare\/([A-Za-z0-9_./~^+-]+\.\.\.?[A-Za-z0-9_./~^+-]+)(?:[?#].*)?$/.exec(raw);
  if (m) {
    return { owner: m[1], repo: m[2], kind: 'compare', ref: m[3], label: `${m[1]}/${m[2]}@${m[3].slice(0, 28)}` };
  }
  m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)@([0-9a-fA-F]{6,40})$/.exec(raw);
  if (m) {
    return { owner: m[1], repo: m[2], kind: 'commits', ref: m[3], label: `${m[1]}/${m[2]}@${m[3].slice(0, 10)}` };
  }
  return null;
}

const MAX_DIFF_BYTES = 5 * 1024 * 1024;

async function readResponseWithLimit(res, maxBytes) {
  const contentLen = Number(res.headers.get('content-length') || 0);
  if (contentLen > maxBytes) {
    throw new Error('Fetched diff exceeds the 5 MB workbench limit.');
  }
  if (!res.body || typeof res.body.getReader !== 'function') {
    const text = await res.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new Error('Fetched diff exceeds the 5 MB workbench limit.');
    }
    return text;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error('Fetched diff exceeds the 5 MB workbench limit.');
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function fetchGitHubDiff(input) {
  const parsed = parseGitHubDiffRef(input);
  if (!parsed) {
    throw new Error('Enter a GitHub URL (/commit/sha, /pull/123, /compare/base...head) or owner/repo@sha.');
  }
  const apiUrl = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/${parsed.kind}/${parsed.ref}`;
  const res = await fetch(apiUrl, {
    headers: {
      'Accept': 'application/vnd.github.v3.diff',
      'User-Agent': 'columbo-review',
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    if (res.status === 403) {
      throw new Error(`GitHub API rate limit (HTTP 403) for ${parsed.label}. Retry shortly or paste the diff directly.`);
    }
    if (res.status === 404) {
      throw new Error(`Not found or private repo (HTTP 404) for ${parsed.label}.`);
    }
    throw new Error(`GitHub returned HTTP ${res.status} for ${parsed.label}.`);
  }
  const text = await readResponseWithLimit(res, MAX_DIFF_BYTES);
  if (!text.trim()) {
    throw new Error(`Empty diff returned for ${parsed.label}.`);
  }
  return { diffText: text, sourceLabel: parsed.label };
}

const ALLOWED_MODES = {
  look: ['-look'],
  prompt: ['-prompt'],
  statechart: ['statechart', '--stdin', '--json'],
  inventory: ['-inventory'],
  plan: ['-plan'],
  capabilities: ['-capabilities'],
  doctor: ['-doctor'],
  'prime-understand': ['prime', 'understand'],
  'prime-work': ['prime', 'work'],
  'prime-review': ['prime', 'review'],
};

function hasBinary(cmd) {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function getToolchainStatus() {
  const tlc = hasBinary('tlc');
  const quint = hasBinary('quint');
  return {
    tlc,
    quint,
    anyFormalChecker: tlc || quint,
    summary: tlc || quint
      ? 'Formal checker available (TLC / Quint)'
      : 'No TLC / Quint binary — using deterministic Diff-traced & Implementation-traced views',
  };
}

function readGitDiff(target) {
  let args;
  let label;
  if (target === '--staged') {
    args = ['diff', '--cached'];
    label = 'Git Staged (--cached)';
  } else if (target === '--worktree') {
    args = ['diff'];
    label = 'Git Working Tree';
  } else if (target === 'HEAD') {
    args = ['show', '--format=', 'HEAD'];
    label = 'Git HEAD';
  } else if (/^[0-9a-f]{4,40}$/i.test(target)) {
    args = ['show', '--format=', target];
    label = `Commit ${target}`;
  } else {
    return null;
  }
  try {
    const out = execFileSync('git', ['-C', __dirname, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 5 * 1024 * 1024,
    });
    return { diffText: out, sourceLabel: label };
  } catch {
    return null;
  }
}

function runColumbo(args, stdinText) {
  return new Promise((resolve) => {
    const distEntry = path.join(__dirname, 'dist', 'cli', 'main.js');
    const entry = existsSync(distEntry) ? distEntry : path.join(__dirname, 'src', 'cli', 'main.ts');
    const child = spawn(process.execPath, [entry, ...args], {
      cwd: __dirname,
      env: process.env,
    });
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) => {
      resolve({ code: 1, stdout: '', stderr: String(e) });
    });
    child.on('close', (code) => {
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      });
    });
    if (stdinText !== undefined && stdinText !== null) {
      child.stdin.write(stdinText);
    }
    child.stdin.end();
  });
}

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_DIFF_BYTES) {
        settled = true;
        reject(new HttpError(413, 'Request body exceeds 5 MB limit.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

async function readJsonBody(req) {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    throw new HttpError(400, 'Invalid JSON request body.');
  }
}

const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>columbo — AI Change Verification Dashboard</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />
  <style>
    :root {
      color-scheme: dark;
      --bg-canvas: #111217;
      --bg-panel: #181b1f;
      --bg-hover: #20242a;
      --bg-well: #0d0f13;
      --border: #2b303a;
      --border-strong: #3a4150;
      --gridline: #22252b;
      --text: #d8d9da;
      --text-strong: #f0f2f5;
      --text-muted: #8e939e;
      --blue: #5794f2;
      --blue-fill: #3274d9;
      --blue-tint: rgba(87, 148, 242, 0.14);
      --green: #73bf69;
      --green-tint: rgba(115, 191, 105, 0.12);
      --amber: #ff9830;
      --amber-tint: rgba(255, 152, 48, 0.13);
      --red: #f2495c;
      --red-tint: rgba(242, 73, 92, 0.12);
      --slate: #526075;
      --font-sans: "Plus Jakarta Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      background: var(--bg-canvas);
      color: var(--text);
      font-family: var(--font-sans);
      font-size: 13px;
      line-height: 1.45;
      -webkit-font-smoothing: antialiased;
    }
    .mono {
      font-family: var(--font-mono);
      font-variant-numeric: tabular-nums;
    }
    .hidden { display: none !important; }

    .topbar {
      position: sticky;
      top: 0;
      z-index: 20;
      height: 48px;
      background: var(--bg-panel);
      border-bottom: 1px solid var(--border);
      padding: 0 18px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
    }
    .topbar-left {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
    }
    .brand-mark {
      width: 22px;
      height: 22px;
      border-radius: 3px;
      background: var(--blue-fill);
      color: #ffffff;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      font-size: 12px;
      flex-shrink: 0;
    }
    .breadcrumb {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      font-weight: 600;
      color: var(--text-strong);
      white-space: nowrap;
    }
    .breadcrumb-sep {
      color: var(--text-muted);
      font-weight: 400;
    }
    .breadcrumb-view {
      color: var(--text-muted);
      font-weight: 500;
    }

    .topbar-nav {
      display: flex;
      align-items: center;
      gap: 2px;
      height: 48px;
      overflow-x: auto;
    }
    .nav-tab {
      background: transparent;
      border: none;
      border-bottom: 2px solid transparent;
      color: var(--text-muted);
      font-family: var(--font-sans);
      font-size: 13px;
      font-weight: 500;
      height: 48px;
      padding: 0 12px;
      cursor: pointer;
      white-space: nowrap;
      flex-shrink: 0;
      transition: color 0.12s, border-color 0.12s;
    }
    .nav-tab:hover { color: var(--text-strong); }
    .nav-tab.active {
      color: var(--text-strong);
      border-bottom-color: var(--blue);
      font-weight: 600;
    }
    .topbar-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
    }
    @media (max-width: 760px) {
      .topbar {
        height: auto;
        flex-wrap: wrap;
        padding: 8px 12px 0;
        gap: 6px;
      }
      .topbar-left { order: 1; flex: 1; }
      .topbar-actions { order: 2; }
      .topbar-nav {
        order: 3;
        width: 100%;
        height: 38px;
        border-top: 1px solid var(--gridline);
      }
      .nav-tab { height: 38px; padding: 0 7px; font-size: 11.5px; }
    }

    .btn {
      font-family: var(--font-sans);
      font-size: 12.5px;
      font-weight: 500;
      color: var(--text);
      background: var(--bg-panel);
      border: 1px solid var(--border);
      border-radius: 3px;
      height: 30px;
      padding: 0 10px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      white-space: nowrap;
      flex-shrink: 0;
    }
    .btn:hover { background: var(--bg-hover); border-color: var(--border-strong); }
    .btn.primary {
      background: var(--blue-fill);
      border-color: var(--blue-fill);
      color: #ffffff;
      font-weight: 600;
    }
    .btn.primary:hover { background: #3d80e6; }
    .btn.active {
      background: var(--blue-tint);
      border-color: var(--blue);
      color: var(--blue);
      font-weight: 600;
    }
    .btn-xs {
      height: 24px;
      padding: 0 8px;
      font-size: 11.5px;
    }
    select, input[type="text"] {
      font-family: var(--font-sans);
      font-size: 12.5px;
      color: var(--text-strong);
      background: var(--bg-well);
      border: 1px solid var(--border);
      border-radius: 3px;
      height: 30px;
      padding: 0 8px;
      outline: none;
    }
    select:focus, input[type="text"]:focus, textarea:focus {
      border-color: var(--blue);
    }

    .toolbar {
      background: var(--bg-panel);
      border-bottom: 1px solid var(--border);
      padding: 8px 18px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 10px;
    }
    .toolbar-group {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
    }
    .field-label {
      color: var(--text-muted);
      font-size: 12px;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      white-space: nowrap;
    }
    .toolbar-meta {
      font-size: 12px;
      color: var(--text-muted);
      display: flex;
      align-items: center;
      gap: 10px;
      white-space: nowrap;
      overflow-x: auto;
    }

    .workspace {
      max-width: 1480px;
      margin: 0 auto;
      padding: 12px 18px 28px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
    }
    .grid-2 {
      display: grid;
      grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr);
      gap: 12px;
      align-items: stretch;
    }
    .grid-files {
      display: grid;
      grid-template-columns: minmax(300px, 0.9fr) minmax(0, 1.4fr);
      gap: 12px;
      align-items: start;
    }

    .panel {
      background: var(--bg-panel);
      border: 1px solid var(--border);
      border-radius: 3px;
      display: flex;
      flex-direction: column;
      min-width: 0;
    }
    .panel-head {
      height: 36px;
      padding: 0 12px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      flex-shrink: 0;
    }
    .panel-title {
      margin: 0;
      font-size: 12.5px;
      font-weight: 600;
      color: var(--text-strong);
      letter-spacing: 0.01em;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .panel-sub {
      font-size: 11.5px;
      color: var(--text-muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 55%;
      flex-shrink: 1;
    }
    .panel-body {
      padding: 12px;
      min-width: 0;
    }
    .panel-body.flush {
      padding: 0;
    }

    .stat-panel {
      padding: 11px 13px;
      justify-content: space-between;
      gap: 6px;
    }
    .stat-label {
      font-size: 11.5px;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.04em;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
    }
    .stat-label-meta {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      flex-shrink: 0;
    }
    .kind-tag {
      display: inline-flex;
      align-items: center;
      padding: 1px 5px;
      border-radius: 2px;
      border: 1px solid var(--border);
      font-family: var(--mono);
      font-size: 9.5px;
      font-weight: 600;
      letter-spacing: 0.06em;
      line-height: 1.35;
      text-transform: uppercase;
    }
    .kind-tag.exact {
      color: var(--green);
      border-color: rgba(115, 191, 105, 0.35);
      background: rgba(115, 191, 105, 0.08);
    }
    .kind-tag.guide {
      color: var(--amber);
      border-color: rgba(255, 152, 48, 0.4);
      background: rgba(255, 152, 48, 0.1);
    }
    .stat-value {
      font-size: 20px;
      font-weight: 700;
      color: var(--text-strong);
      line-height: 1.2;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .stat-foot {
      font-size: 11.5px;
      color: var(--text-muted);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .c-green { color: var(--green); }
    .c-red { color: var(--red); }
    .c-amber { color: var(--amber); }
    .c-blue { color: var(--blue); }
    .c-muted { color: var(--text-muted); }

    .status-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      display: inline-block;
      flex-shrink: 0;
    }
    .dot-high { background: var(--red); }
    .dot-medium { background: var(--amber); }
    .dot-low { background: var(--green); }
    .dot-muted { background: var(--text-muted); }

    .xray-inline {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 156px;
    }
    .xray-inline svg {
      flex: 1;
      min-width: 56px;
    }
    .xray-inline .bar-num {
      width: 68px;
      text-align: right;
      font-size: 11.5px;
      white-space: nowrap;
      flex-shrink: 0;
    }

    .svg-box {
      background: var(--bg-well);
      border: 1px solid var(--border);
      border-radius: 2px;
      overflow-x: auto;
      padding: 8px;
      display: flex;
      justify-content: center;
    }
    .svg-box svg {
      display: block;
      max-width: 100%;
      width: auto;
      height: auto;
      max-height: 310px;
    }
    .svg-box.svg-tall svg {
      max-height: 440px;
    }
    .sc-node { cursor: pointer; }
    .sc-node:hover rect { stroke: var(--blue); }
    .step-strip {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      flex-wrap: wrap;
      margin-top: 8px;
    }
    .step-buttons {
      display: flex;
      align-items: center;
      gap: 4px;
      flex-wrap: wrap;
    }
    .step-caption {
      margin-top: 6px;
      padding: 7px 9px;
      background: var(--bg-well);
      border: 1px solid var(--border);
      border-radius: 2px;
      font-size: 12px;
      color: var(--text);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }

    table.grid-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12.5px;
    }
    table.grid-table th {
      height: 32px;
      padding: 0 12px;
      text-align: left;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--text-muted);
      background: var(--bg-hover);
      border-bottom: 1px solid var(--border);
      white-space: nowrap;
    }
    table.grid-table td {
      height: 36px;
      padding: 0 12px;
      border-bottom: 1px solid var(--gridline);
      color: var(--text);
      vertical-align: middle;
    }
    table.grid-table tr:last-child td { border-bottom: none; }
    table.grid-table tbody tr.clickable { cursor: pointer; }
    table.grid-table tbody tr.clickable:hover { background: var(--bg-hover); }
    table.grid-table tbody tr.selected { background: var(--blue-tint); }
    .num { text-align: right !important; white-space: nowrap; }
    .truncate {
      max-width: 260px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .diff-viewer {
      background: var(--bg-well);
      border: 1px solid var(--border);
      border-radius: 2px;
      font-family: var(--font-mono);
      font-size: 12px;
      line-height: 1.5;
      max-height: 460px;
      overflow: auto;
    }
    .diff-line {
      padding: 1px 10px;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .diff-add { background: var(--green-tint); color: #b7ebaf; }
    .diff-del { background: var(--red-tint); color: #ffb3bc; }
    .diff-hunk { background: var(--blue-tint); color: #9ac2ff; font-weight: 600; }
    .diff-fold { background: rgba(255, 152, 48, 0.08); color: var(--amber); }
    .diff-meta { color: var(--text-muted); }

    textarea {
      width: 100%;
      min-height: 140px;
      background: var(--bg-well);
      border: 1px solid var(--border);
      border-radius: 2px;
      padding: 10px;
      color: var(--text-strong);
      font-family: var(--font-mono);
      font-size: 12px;
      resize: vertical;
    }
    pre.console {
      margin: 0;
      padding: 12px;
      background: var(--bg-well);
      border: 1px solid var(--border);
      border-radius: 2px;
      font-family: var(--font-mono);
      font-size: 12px;
      line-height: 1.5;
      color: var(--text);
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 480px;
      overflow: auto;
    }

    .tip-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 17px;
      height: 17px;
      padding: 0;
      margin-left: 5px;
      border-radius: 50%;
      border: 1px solid var(--border-strong);
      background: transparent;
      color: var(--text-muted);
      font-family: var(--font-sans);
      font-size: 10.5px;
      font-weight: 600;
      line-height: 1;
      cursor: pointer;
      vertical-align: middle;
      flex-shrink: 0;
      text-transform: none;
      letter-spacing: 0;
      transition: color 0.12s, border-color 0.12s, background 0.12s;
    }
    .tip-btn:hover,
    .tip-btn:focus-visible,
    .tip-btn[aria-expanded="true"] {
      color: var(--text-strong);
      border-color: var(--blue);
      background: var(--blue-tint);
      outline: none;
    }
    .error-banner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 8px 12px;
      background: var(--red-tint);
      border: 1px solid var(--red);
      border-radius: 3px;
      color: #ffb3bc;
      font-size: 12px;
    }
    [data-tip] {
      cursor: help;
    }
    tr.clickable [data-tip] {
      cursor: pointer;
    }
    .th-inner {
      display: inline-flex;
      align-items: center;
      gap: 3px;
    }
    .grid-table th .tip-btn {
      width: 14px;
      height: 14px;
      margin-left: 2px;
      font-size: 9.5px;
    }
    .floating-tooltip {
      position: fixed;
      top: 0;
      left: 0;
      z-index: 90;
      width: max-content;
      max-width: min(290px, calc(100vw - 16px));
      padding: 8px 10px;
      background: #111217;
      border: 1px solid var(--border-strong);
      border-radius: 3px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.6);
      pointer-events: none;
      opacity: 0;
      transform: translateY(2px);
      transition: opacity 0.1s ease, transform 0.1s ease;
    }
    .floating-tooltip.visible {
      opacity: 1;
      transform: translateY(0);
    }
    .floating-tooltip-title {
      font-size: 12px;
      font-weight: 600;
      color: var(--text-strong);
      margin-bottom: 3px;
    }
    .floating-tooltip-body {
      font-size: 11.5px;
      line-height: 1.45;
      color: var(--text);
    }
    @media (max-width: 1080px) {
      .kpi-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .grid-2, .grid-files { grid-template-columns: 1fr; }
    }
    @media (max-width: 640px) {
      .kpi-grid { grid-template-columns: 1fr; }
      .workspace { padding: 12px; }
      .panel-sub { display: none; }
      .col-delta, .xray-inline svg { display: none; }
      .xray-inline { min-width: 0; justify-content: flex-end; }
      .xray-inline .bar-num { width: auto; }
      table.grid-table { font-size: 12px; }
      table.grid-table th, table.grid-table td { padding: 0 8px; }
      table.files-overview-table { table-layout: fixed; }
      table.files-overview-table td.truncate { max-width: none; }
      table.files-overview-table th.col-xray,
      table.files-overview-table td.col-xray { width: 86px; }
      table.files-overview-table th.col-risk,
      table.files-overview-table td.col-risk { width: 82px; white-space: nowrap; }
    }
  </style>
</head>
<body>
  <header class="topbar">
    <div class="topbar-left">
      <div class="brand-mark">C</div>
      <div class="breadcrumb">
        <span>columbo</span>
        <span class="breadcrumb-sep">/</span>
        <span id="breadcrumbView" class="breadcrumb-view">Overview</span>
      </div>
    </div>

    <nav class="topbar-nav" aria-label="Dashboard Views">
      <button class="nav-tab active" data-view="overview" type="button">Overview</button>
      <button class="nav-tab" data-view="stateflow" type="button">State Flow</button>
      <button class="nav-tab" data-view="files" type="button">Diff &amp; Files</button>
    </nav>

    <div class="topbar-actions">
      <button id="refreshBtn" class="btn primary" type="button">Refresh</button>
    </div>
  </header>

  <div class="toolbar">
    <div class="toolbar-group">
      <label class="field-label">Target
        <select id="sourceSelect"></select>
      </label>
      <label id="sampleWrap" class="field-label">Commit
        <select id="sampleSelect"></select>
      </label>
      <button id="togglePasteBtn" class="btn" type="button">Load Diff / URL</button>
      <button id="copyTriageBtn" class="btn" type="button" data-tip-title="Copy Agent Triage JSON" data-tip="Copies compact columbo.triage.v1 JSON separating deterministic facts (SHA-256, stripped imports, exact moves) from heuristic review order and invariants for AI agents.">Copy Triage</button>
      <button id="copyPacketBtn" class="btn" type="button" data-tip-title="Copy Review Packet" data-tip="Runs columbo -prompt on the active diff and copies the full offline agent review packet to clipboard.">Copy Packet</button>
    </div>
    <div id="repoMeta" class="toolbar-meta mono">Loading environment...</div>
  </div>

  <div class="workspace">
    <div id="globalError" class="error-banner hidden" role="alert">
      <span id="globalErrorText" class="mono"></span>
      <button id="dismissErrorBtn" class="btn btn-xs" type="button">Dismiss</button>
    </div>

    <section id="pasteDrawer" class="panel hidden">
      <div class="panel-head">
        <h2 class="panel-title">Load GitHub Commit / PR / Compare or Custom Unified Diff</h2>
        <div style="display:flex;gap:6px;">
          <button id="analyzePasteBtn" class="btn primary btn-xs" type="button">Analyze Diff</button>
          <button id="closePasteBtn" class="btn btn-xs" type="button">Close</button>
        </div>
      </div>
      <div class="panel-body">
        <div style="display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap;align-items:center;">
          <input id="githubUrlInput" type="text" style="flex:1;min-width:260px;" aria-label="GitHub commit, pull request, or compare URL" placeholder="https://github.com/owner/repo/commit/sha, /pull/123, /compare/a...b, or owner/repo@sha" />
          <button id="fetchGithubBtn" class="btn" type="button">Fetch GitHub Diff</button>
        </div>
        <div id="pasteError" class="c-red mono hidden" style="font-size:11.5px;margin-bottom:8px;"></div>
        <textarea id="pasteInput" aria-label="Custom unified diff input" placeholder="Or paste any unified git diff here to verify X-ray signal, compiler stripping, and state transitions..."></textarea>
      </div>
    </section>

    <main id="viewOverview" class="workspace" style="padding:0;max-width:none;margin:0;">
      <section class="kpi-grid" aria-label="Key verification metrics">
        <div class="panel stat-panel">
          <div class="stat-label">
            <span>Target &amp; Churn</span>
            <span class="stat-label-meta">
              <span class="kind-tag exact" data-tip-title="Exact Fact" data-tip="Exact counts directly from the raw unified diff. No guessing or AI.">EXACT</span>
              <button class="tip-btn" type="button" aria-label="Explain Target and Churn metric" aria-expanded="false" data-tip-title="Target &amp; Churn (Exact Fact)" data-tip="Shows what diff you selected and its raw size before filtering: changed files, edit blocks (hunks), and total added (+) vs. deleted (-) lines.">?</button>
            </span>
          </div>
          <div id="kpiTarget" class="stat-value">-</div>
          <div id="kpiScope" class="stat-foot mono" data-tip-title="Raw Scope (Exact Fact)" data-tip="Exact count of changed files, diff hunks, and raw + / - lines before noise filtering.">-</div>
        </div>
        <div class="panel stat-panel">
          <div class="stat-label">
            <span>Meat vs. Noise X-Ray</span>
            <span class="stat-label-meta">
              <span class="kind-tag exact" data-tip-title="Exact Fact" data-tip="Byte-level checks only. Strips pure imports, lockfiles, and byte-identical moved lines without AI.">EXACT</span>
              <button class="tip-btn" type="button" aria-label="Explain Meat vs. Noise X-Ray metric" aria-expanded="false" data-tip-title="Meat vs. Noise X-Ray (Exact Fact)" data-tip="Meat = changed lines that can change program behavior. Noise = pure imports (imp), byte-identical moved lines (mov), and generated/lockfiles. Note: moving identical code into a new if-block or lock can still change behavior, so move coordinates stay visible.">?</button>
            </span>
          </div>
          <div id="kpiXray" class="stat-value mono" data-tip-title="Behavioral Meat (Exact Fact)" data-tip="Changed lines left after removing pure imports, lockfiles, and byte-exact moves. Read these lines first.">-</div>
          <div id="kpiXraySub" class="stat-foot mono" data-tip-title="Filtered Noise Breakdown" data-tip="Percent of raw changed lines proven to be pure imports (imp) or byte-exact moves (mov).">-</div>
        </div>
        <div class="panel stat-panel">
          <div class="stat-label">
            <span>State &amp; Risk</span>
            <span class="stat-label-meta">
              <span class="kind-tag guide" data-tip-title="Heuristic Guide (Not Proof)" data-tip="Fast text-pattern scan for reading order only. Low risk does NOT prove a file has no bugs (it can miss off-by-one math, swapped arguments, or bad config).">GUIDE</span>
              <button class="tip-btn" type="button" aria-label="Explain State and Risk metric" aria-expanded="false" data-tip-title="State &amp; Risk (Heuristic Guide — Not Proof)" data-tip="Scans changed lines for control-flow patterns (state writes, error paths, retries, locks, added/removed safety checks) to rank which files to read first. Use for reading order only — NEVER skip Low Risk files or treat this as proof of safety.">?</button>
            </span>
          </div>
          <div id="kpiStateLabel" class="stat-value">-</div>
          <div id="kpiSignals" class="stat-foot mono" data-tip-title="Signal Counts (Heuristic)" data-tip="state = state writes · err = error paths · retry = retry/timeout/cancel · async = locks/await · guard = added checks · rm-guard = removed checks (highest warning).">-</div>
        </div>
        <div class="panel stat-panel">
          <div class="stat-label">
            <span>Integrity &amp; Budget</span>
            <span class="stat-label-meta">
              <span class="kind-tag exact" data-tip-title="Exact Fact" data-tip="Exact SHA-256 fingerprint and byte size of this diff. If 1 character changes, the hash changes.">EXACT</span>
              <button class="tip-btn" type="button" aria-label="Explain Integrity and Budget metric" aria-expanded="false" data-tip-title="Integrity &amp; Budget (Exact Fact)" data-tip="Shows if the diff fits in 1 AI pass or needs multiple chunks, plus its exact SHA-256 hash and raw byte size. Saved review claims turn stale automatically when the hash changes.">?</button>
            </span>
          </div>
          <div id="kpiEnvTitle" class="stat-value">-</div>
          <div id="kpiEnvDetail" class="stat-foot mono" data-tip-title="Input Digest &amp; Size (Exact Fact)" data-tip="Exact SHA-256 fingerprint and byte size for this diff.">-</div>
        </div>
      </section>

      <section class="grid-2">
        <div class="panel">
          <div class="panel-head">
            <h2 class="panel-title">Changed Files &amp; Behavioral Meat <button class="tip-btn" type="button" aria-label="Explain Changed Files and Behavioral Meat" aria-expanded="false" data-tip-title="Changed Files &amp; Behavioral Meat" data-tip="Ranked by churn. Bar colors: Green = behavioral meat lines (m), Amber = byte-exact moved lines, Slate = stripped imports. Parentheses (n) = combined noise. Click any row to inspect its patch.">?</button></h2>
            <span id="filesCountSub" class="panel-sub mono">0 files · click row</span>
          </div>
          <div class="panel-body flush" style="overflow-x:auto;">
            <table class="grid-table files-overview-table">
              <thead>
                <tr>
                  <th>File</th>
                  <th class="col-xray"><span class="th-inner">X-Ray <button class="tip-btn" type="button" aria-label="Explain X-Ray column" aria-expanded="false" data-tip-title="Meat vs. Noise X-Ray (Exact Fact)" data-tip="m = behavioral meat lines to read; (n) = stripped imports + byte-exact moved lines.">?</button></span></th>
                  <th class="num col-delta"><span class="th-inner">+ / - <button class="tip-btn" type="button" aria-label="Explain Added and Deleted lines column" aria-expanded="false" data-tip-title="Raw Line Delta (Exact Fact)" data-tip="Exact count of added (+) and deleted (-) lines in this file before filtering.">?</button></span></th>
                  <th class="col-risk"><span class="th-inner">Risk <button class="tip-btn" type="button" aria-label="Explain Risk column" aria-expanded="false" data-tip-title="Risk Tier (Heuristic Guide — Not Safety Proof)" data-tip="Reading-order hint from regex patterns only: high = removed check or >=3 state/error/retry cues; medium = 1-2 cues or >=2 guards/locks; low = no control-flow patterns matched. Low risk does NOT prove the file is bug-free (can miss math, config, or argument-order bugs).">?</button></span></th>
                </tr>
              </thead>
              <tbody id="overviewFilesBody"></tbody>
            </table>
          </div>
        </div>

        <div class="panel">
          <div class="panel-head">
            <h2 class="panel-title">State &amp; Failure Flow <button class="tip-btn" type="button" aria-label="Explain State and Failure Flow diagram" aria-expanded="false" data-tip-title="State &amp; Failure Flow" data-tip="Diff-traced behavioral diagram inferred from guards, state mutations, retries, and error edges. Amber edges/nodes highlight failure paths; dashed edge returns control outside the diff.">?</button></h2>
            <span id="overviewEvidence" class="panel-sub mono">Click node to jump to file</span>
          </div>
          <div class="panel-body">
            <div id="overviewSvgWrap" class="svg-box"></div>
            <div class="step-strip">
              <div id="overviewStepBtns" class="step-buttons"></div>
              <span id="overviewStepCounter" class="panel-sub mono">Step 0 / 0</span>
            </div>
            <div class="step-caption">
              <span id="overviewStepCaption">Select a step or click any diagram node to jump to its code.</span>
              <button id="stepJumpBtn" class="btn btn-xs hidden" type="button">Inspect File</button>
            </div>
          </div>
        </div>
      </section>

      <section class="panel">
        <div class="panel-head">
          <h2 class="panel-title">Claims, Invariants &amp; Readiness <button class="tip-btn" type="button" aria-label="Explain Claims and Invariants table" aria-expanded="false" data-tip-title="Claims, Invariants &amp; Readiness" data-tip="Aggregates Columbo ledger claims (FRESH/RECHECK/DECISION), detected exact moves (MOVE), transition deltas (GUARD/ADDED/REMOVED), safety invariants (CHECK), and compiler partitioning.">?</button></h2>
          <span id="ledgerBadge" class="panel-sub mono">Grounded checks</span>
        </div>
        <div class="panel-body flush" style="overflow-x:auto;">
          <table class="grid-table">
            <thead>
              <tr>
                <th style="width:104px;">Kind</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody id="checksTableBody"></tbody>
          </table>
        </div>
      </section>

      <section id="selectedPatchPanel" class="panel hidden">
        <div class="panel-head">
          <h2 id="selectedPatchTitle" class="panel-title mono">Patch</h2>
          <div style="display:flex;gap:6px;">
            <button id="openMeatInFilesBtn" class="btn primary btn-xs" type="button">Meat Only in Diff &amp; Files</button>
            <button id="closePatchBtn" class="btn btn-xs" type="button">Hide</button>
          </div>
        </div>
        <div class="panel-body">
          <div id="selectedPatchView" class="diff-viewer"></div>
        </div>
      </section>
    </main>

    <main id="viewStateflow" class="workspace hidden" style="padding:0;max-width:none;margin:0;">
      <div class="panel">
        <div class="panel-head">
          <div style="display:flex;align-items:center;gap:12px;">
            <h2 id="sfTitle" class="panel-title">Statechart</h2>
            <span id="sfEvidence" class="panel-sub mono">-</span>
          </div>
          <div style="display:flex;align-items:center;gap:8px;">
            <button id="copyMermaidBtn" class="btn btn-xs" type="button">Copy Mermaid</button>
          </div>
        </div>
        <div class="panel-body">
          <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:8px;">
            <span id="sfTrigger" class="panel-sub"></span>
            <span class="panel-sub mono">Click any node to open source · Normal: slate · Added: green · Failure/Retry: amber · Removed guard: red</span>
          </div>
          <div id="sfSvgWrap" class="svg-box svg-tall"></div>
        </div>
      </div>

      <section class="grid-2">
        <div class="panel">
          <div class="panel-head">
            <h2 class="panel-title">Failure Walkthrough</h2>
            <div style="display:flex;gap:6px;align-items:center;">
              <button id="sfPrevBtn" class="btn btn-xs" type="button">Prev</button>
              <button id="sfNextBtn" class="btn primary btn-xs" type="button">Next</button>
              <button id="sfClearBtn" class="btn btn-xs" type="button">Clear</button>
            </div>
          </div>
          <div class="panel-body flush">
            <table class="grid-table">
              <thead>
                <tr>
                  <th style="width:52px;">Step</th>
                  <th>Transition</th>
                  <th>Outcome</th>
                </tr>
              </thead>
              <tbody id="sfStepsBody"></tbody>
            </table>
          </div>
        </div>

        <div class="panel">
          <div class="panel-head">
            <h2 class="panel-title">Invariants, Omissions &amp; Mermaid</h2>
            <span id="sfRefs" class="panel-sub mono"></span>
          </div>
          <div class="panel-body" style="display:flex;flex-direction:column;gap:10px;">
            <table class="grid-table">
              <tbody id="sfMetaBody"></tbody>
            </table>
            <pre id="sfMermaid" class="console" style="max-height:180px;"></pre>
          </div>
        </div>
      </section>
    </main>

    <main id="viewFiles" class="workspace hidden" style="padding:0;max-width:none;margin:0;">
      <div class="panel">
        <div class="panel-head">
          <h2 class="panel-title">Signal X-Ray &amp; Partition Forecast <button class="tip-btn" type="button" aria-label="Explain Signal X-Ray and Partition Forecast" aria-expanded="false" data-tip-title="Signal X-Ray &amp; Partition Forecast" data-tip="Visual ratio across all changed lines: Green = behavioral logic, Amber = verbatim cross-hunk moves, Slate = stripped imports. Chunk count shows how many model runs are needed within byte budget.">?</button></h2>
          <span id="shapeSummary" class="panel-sub mono"></span>
        </div>
        <div class="panel-body" style="display:flex;flex-direction:column;gap:10px;">
          <div id="xrayBarWrap" style="height:10px;width:100%;background:var(--bg-well);border:1px solid var(--border);border-radius:2px;overflow:hidden;" data-tip-title="X-Ray Composition Bar" data-tip="Proportion of behavioral logic (green), relocated moves (amber), and stripped imports (slate)."></div>
          <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
              <input id="fileFilterInput" type="text" placeholder="Filter file path..." style="min-width:220px;" />
              <div style="display:flex;gap:4px;">
                <button class="btn btn-xs active" data-risk="all" type="button">All</button>
                <button class="btn btn-xs" data-risk="high" type="button">High</button>
                <button class="btn btn-xs" data-risk="medium" type="button">Medium</button>
                <button class="btn btn-xs" data-risk="low" type="button">Low</button>
              </div>
            </div>
            <div id="xrayLegend" class="panel-sub mono">Green: behavioral · Amber: moved · Slate: stripped imports</div>
          </div>
        </div>
      </div>

      <section class="grid-files">
        <div class="panel">
          <div class="panel-head">
            <h2 class="panel-title">Files</h2>
            <span id="filteredFilesCount" class="panel-sub mono">0</span>
          </div>
          <div class="panel-body flush" style="max-height:480px;overflow:auto;">
            <table class="grid-table">
              <thead>
                <tr>
                  <th>Path</th>
                  <th class="num"><span class="th-inner">Meat / Noise <button class="tip-btn" type="button" aria-label="Explain Meat and Noise ratio" aria-expanded="false" data-tip-title="Behavioral Meat / Proven Noise" data-tip="Left (green): behavioral lines requiring review. Right (muted): combined stripped imports + exact moved lines proven noise by Columbo.">?</button></span></th>
                  <th>Risk</th>
                </tr>
              </thead>
              <tbody id="filesTabBody"></tbody>
            </table>
          </div>
        </div>

        <div class="panel">
          <div class="panel-head">
            <h2 id="filesPatchTitle" class="panel-title mono">Select a file</h2>
            <div style="display:flex;align-items:center;gap:6px;">
              <button id="modeRawBtn" class="btn btn-xs active" data-patch-mode="raw" type="button" data-tip-title="Raw Diff" data-tip="Unmodified git unified diff including all imports and relocated blocks.">Raw Diff</button>
              <button id="modeMeatBtn" class="btn btn-xs" data-patch-mode="meat" type="button" data-tip-title="Meat Only" data-tip="Deterministic abridging output with pure import churn stripped so you review only behavioral changes.">Meat Only</button>
              <button id="modeMovesBtn" class="btn btn-xs" data-patch-mode="moves" type="button" data-tip-title="Exact Moves" data-tip="Multi-line blocks detected removed from one hunk and re-added byte-for-byte elsewhere (modulo indentation).">Moves (0)</button>
            </div>
          </div>
          <div class="panel-body" style="display:flex;flex-direction:column;gap:8px;">
            <div id="filesPatchMeta" class="panel-sub mono"></div>
            <div id="filesPatchViewer" class="diff-viewer"></div>
          </div>
        </div>
      </section>
    </main>
  </div>

  <div id="metricTooltip" class="floating-tooltip" role="tooltip" aria-hidden="true">
    <div id="metricTooltipTitle" class="floating-tooltip-title"></div>
    <div id="metricTooltipBody" class="floating-tooltip-body"></div>
  </div>

  <script>
    const state = {
      view: 'overview',
      mode: 'auto',
      sampleId: 'linux-tty',
      gitTarget: 'HEAD',
      githubUrl: '',
      rawDiff: '',
      dashboard: null,
      toolchain: null,
      samples: [],
      selectedFile: null,
      activeStepIndex: 0,
      riskFilter: 'all',
      fileQuery: '',
      patchMode: 'raw',
    };

    const viewNames = {
      overview: 'Overview',
      stateflow: 'State Flow',
      files: 'Diff & Files',
    };

    function escapeHtml(str) {
      return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function riskClass(risk) {
      if (risk === 'high') return 'c-red';
      if (risk === 'medium') return 'c-amber';
      return 'c-green';
    }

    function riskDot(risk) {
      if (risk === 'high') return 'dot-high';
      if (risk === 'medium') return 'dot-medium';
      return 'dot-low';
    }

    function showGlobalError(message) {
      const box = document.getElementById('globalError');
      const txt = document.getElementById('globalErrorText');
      if (box && txt) {
        txt.textContent = message;
        box.classList.remove('hidden');
      }
    }

    function clearGlobalError() {
      const box = document.getElementById('globalError');
      const txt = document.getElementById('globalErrorText');
      if (box && txt) {
        txt.textContent = '';
        box.classList.add('hidden');
      }
    }

    function resetFileFiltersIfHidden(fileName) {
      const dash = state.dashboard;
      if (!dash || !fileName) return;
      const target = dash.files.find((f) => f.file === fileName);
      if (!target) return;
      const q = state.fileQuery.trim().toLowerCase();
      const hiddenByRisk = state.riskFilter !== 'all' && target.risk !== state.riskFilter;
      const hiddenByQuery = q && !target.file.toLowerCase().includes(q);
      if (hiddenByRisk) {
        state.riskFilter = 'all';
        document.querySelectorAll('[data-risk]').forEach((b) => {
          b.classList.toggle('active', b.dataset.risk === 'all');
        });
      }
      if (hiddenByQuery) {
        state.fileQuery = '';
        const input = document.getElementById('fileFilterInput');
        if (input) input.value = '';
      }
    }

    function switchView(view) {
      state.view = view;
      document.getElementById('breadcrumbView').textContent = viewNames[view] || 'Overview';
      document.querySelectorAll('.nav-tab').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.view === view);
      });
      document.getElementById('viewOverview').classList.toggle('hidden', view !== 'overview');
      document.getElementById('viewStateflow').classList.toggle('hidden', view !== 'stateflow');
      document.getElementById('viewFiles').classList.toggle('hidden', view !== 'files');
      if (view === 'stateflow') renderStateflowView();
      if (view === 'files') renderFilesView();
    }

    document.querySelectorAll('.nav-tab').forEach((btn) => {
      btn.addEventListener('click', () => switchView(btn.dataset.view));
    });

    function activeChartObject() {
      return state.dashboard?.statechart || null;
    }

    function jumpToNodeSource(nodeId, openFilesTab) {
      const dash = state.dashboard;
      if (!dash) return;
      const chart = activeChartObject();
      const node = chart?.nodes?.find((n) => n.id === nodeId);
      const fromMap = dash.nodeFileMap?.[nodeId];
      const mapped = (fromMap && dash.files.some((f) => f.file === fromMap))
        ? fromMap
        : (node && node.sourceRef && dash.files.some((f) => f.file === node.sourceRef))
          ? node.sourceRef
          : dash.files[0]?.file;
      if (!mapped) return;
      state.selectedFile = mapped;
      if (openFilesTab) {
        resetFileFiltersIfHidden(mapped);
        state.patchMode = 'meat';
        switchView('files');
      } else {
        selectFile(mapped);
      }
    }

    function wrapLines(text, maxChars) {
      const rawWords = String(text || '').trim().split(/\\s+/).filter(Boolean);
      const tokens = [];
      for (const w of rawWords) {
        if (w.length <= maxChars) {
          tokens.push(w);
        } else {
          for (let i = 0; i < w.length; i += maxChars) {
            tokens.push(w.slice(i, i + maxChars));
          }
        }
      }
      const lines = [];
      let cur = '';
      for (const t of tokens) {
        if (!cur) cur = t;
        else if (cur.length + 1 + t.length <= maxChars) cur += ' ' + t;
        else {
          lines.push(cur);
          cur = t;
          if (lines.length === 2) break;
        }
      }
      if (cur && lines.length < 2) lines.push(cur);
      const joinedOriginal = rawWords.join(' ');
      const joinedLines = lines.join(' ');
      if (lines.length === 2 && joinedLines.length < joinedOriginal.length) {
        const last = lines[1];
        lines[1] = last.length > maxChars - 3 ? last.slice(0, maxChars - 3) + '...' : last + '...';
      }
      return lines.slice(0, 2);
    }

    function edgeStroke(kind) {
      if (kind === 'added') return '#73bf69';
      if (kind === 'removed') return '#f2495c';
      if (kind === 'failure') return '#ff9830';
      if (kind === 'unknown') return '#8e939e';
      return '#526075';
    }

    function renderSvgInto(containerId, chart, stepIndex) {
      const container = document.getElementById(containerId);
      if (!chart || !chart.nodes || !chart.nodes.length) {
        container.innerHTML = '<div style="padding:18px;color:#8e939e;">No statechart nodes for this diff.</div>';
        return;
      }

      const adj = new Map();
      for (const n of chart.nodes) adj.set(n.id, []);
      for (const e of chart.edges) {
        if (adj.has(e.from)) adj.get(e.from).push(e.to);
      }

      const levels = new Map();
      const startNode = chart.nodes.find((n) => n.kind === 'start') || chart.nodes[0];
      const queue = [{ id: startNode.id, lvl: 0 }];
      levels.set(startNode.id, 0);
      while (queue.length) {
        const cur = queue.shift();
        for (const nxt of adj.get(cur.id) || []) {
          if (!levels.has(nxt)) {
            levels.set(nxt, cur.lvl + 1);
            queue.push({ id: nxt, lvl: cur.lvl + 1 });
          }
        }
      }
      let maxLvl = 0;
      for (const n of chart.nodes) {
        if (!levels.has(n.id)) levels.set(n.id, maxLvl + 1);
        maxLvl = Math.max(maxLvl, levels.get(n.id));
      }

      const byLevel = new Map();
      for (const n of chart.nodes) {
        const l = levels.get(n.id);
        if (!byLevel.has(l)) byLevel.set(l, []);
        byLevel.get(l).push(n);
      }

      const nodeW = 200;
      const nodeH = 42;
      const colGap = 290;
      const rowGap = 96;
      const padY = 20;

      let maxCols = 1;
      for (const arr of byLevel.values()) maxCols = Math.max(maxCols, arr.length);

      const tempPos = new Map();
      for (const [lvl, list] of byLevel.entries()) {
        list.sort((a, b) => (a.kind === 'error' ? 1 : 0) - (b.kind === 'error' ? 1 : 0));
        list.forEach((n, idx) => tempPos.set(n.id, { lvl, col: idx, count: list.length }));
      }
      const hasLeftBackEdge = chart.edges.some((e) => {
        const a = tempPos.get(e.from);
        const b = tempPos.get(e.to);
        return a && b && b.lvl < a.lvl && (a.col === 0 && a.count > 1);
      });
      const hasRightBackEdge = chart.edges.some((e) => {
        const a = tempPos.get(e.from);
        const b = tempPos.get(e.to);
        return a && b && b.lvl <= a.lvl && !(a.col === 0 && a.count > 1);
      });

      const padX = hasLeftBackEdge ? 195 : 36;
      const rightReserve = hasRightBackEdge ? 225 : 36;
      const contentW = Math.max(380, (maxCols - 1) * colGap + nodeW);
      const svgW = padX + contentW + rightReserve;
      const svgH = padY * 2 + maxLvl * rowGap + nodeH + 18;

      const pos = new Map();
      for (const [lvl, list] of byLevel.entries()) {
        const totalWidth = (list.length - 1) * colGap + nodeW;
        const startX = padX + (contentW - totalWidth) / 2;
        list.forEach((n, idx) => {
          pos.set(n.id, {
            cx: startX + idx * colGap + nodeW / 2,
            cy: padY + lvl * rowGap + nodeH / 2,
            lvl,
            col: idx,
            count: list.length,
            kind: n.kind,
          });
        });
      }

      const step = stepIndex >= 0 && chart.failureWalkthrough ? chart.failureWalkthrough[stepIndex] : null;
      const activeNodeId = step ? step.activeNodeId : null;
      const activeEdgeId = step ? step.activeEdgeId : null;

      let defs = '<defs>';
      for (const kind of ['normal', 'added', 'removed', 'failure', 'unknown', 'active']) {
        const color = kind === 'active' ? '#ff9830' : edgeStroke(kind);
        defs += '<marker id="' + containerId + '-arr-' + kind + '" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">' +
          '<path d="M 0 1 L 10 5 L 0 9 z" fill="' + color + '"/></marker>';
      }
      defs += '</defs>';

      let edgesSvg = '';
      chart.edges.forEach((e, idx) => {
        const p1 = pos.get(e.from);
        const p2 = pos.get(e.to);
        if (!p1 || !p2) return;

        const isActive = activeEdgeId === e.id;
        const color = isActive ? '#ff9830' : edgeStroke(e.kind);
        const marker = isActive ? 'active' : e.kind;
        const dash = e.kind === 'removed' ? 'stroke-dasharray="5 4"' : e.kind === 'unknown' ? 'stroke-dasharray="3 4"' : '';

        const y1 = p1.kind === 'start' ? p1.cy + 10 : p1.cy + (p2.lvl > p1.lvl ? nodeH / 2 : 0);
        const y2 = p2.kind === 'start' ? p2.cy - 10 : p2.cy - (p2.lvl > p1.lvl ? nodeH / 2 : 0);

        let x1 = p1.cx;
        let x2 = p2.cx;
        let cx = (x1 + x2) / 2;
        let cy = (y1 + y2) / 2;
        let d;

        if (p2.lvl === p1.lvl - 1 && p2.col !== p1.col) {
          const dir = p2.cx > p1.cx ? 1 : -1;
          x1 = p1.cx + dir * (nodeW / 2);
          x2 = p2.cx;
          const sy1 = p1.cy;
          const sy2 = p2.cy + nodeH / 2;
          const ctrlX = x1 + dir * 72;
          const ctrlY = sy1 - 24;
          d = 'M ' + x1 + ' ' + sy1 + ' Q ' + ctrlX + ' ' + ctrlY + ' ' + x2 + ' ' + sy2;
          cx = 0.25 * x1 + 0.5 * ctrlX + 0.25 * x2;
          cy = 0.25 * sy1 + 0.5 * ctrlY + 0.25 * sy2;
        } else if (p2.lvl < p1.lvl && p1.col === 0 && p1.count > 1) {
          const offset = 126 + (idx % 2) * 26;
          x1 = p1.cx - nodeW / 2;
          x2 = p2.cx - nodeW / 2;
          const ctrlX = Math.min(x1, x2) - offset;
          const ctrlY = (p1.cy + p2.cy) / 2;
          d = 'M ' + x1 + ' ' + p1.cy + ' Q ' + ctrlX + ' ' + ctrlY + ' ' + x2 + ' ' + p2.cy;
          cx = 0.25 * x1 + 0.5 * ctrlX + 0.25 * x2;
          cy = 0.25 * p1.cy + 0.5 * ctrlY + 0.25 * p2.cy;
        } else if (p2.lvl < p1.lvl) {
          const offset = 160 + (idx % 2) * 32;
          x1 = p1.cx + nodeW / 2;
          x2 = p2.cx + nodeW / 2;
          const ctrlX = Math.max(x1, x2) + offset;
          const ctrlY = (p1.cy + p2.cy) / 2;
          d = 'M ' + x1 + ' ' + p1.cy + ' Q ' + ctrlX + ' ' + ctrlY + ' ' + x2 + ' ' + p2.cy;
          cx = 0.25 * x1 + 0.5 * ctrlX + 0.25 * x2;
          cy = 0.25 * p1.cy + 0.5 * ctrlY + 0.25 * p2.cy;
        } else if (p2.lvl === p1.lvl) {
          const dir = p2.cx >= p1.cx ? 1 : -1;
          x1 = p1.cx + dir * (nodeW / 2);
          x2 = p2.cx - dir * (nodeW / 2);
          cx = (x1 + x2) / 2;
          cy = p1.cy + 34;
          d = 'M ' + x1 + ' ' + p1.cy + ' Q ' + cx + ' ' + cy + ' ' + x2 + ' ' + p2.cy;
          cy = p1.cy + 20;
        } else {
          const isRemovedRight = e.kind === 'removed' && p2.cx > p1.cx;
          const bend = isRemovedRight ? 54 : (idx % 2 === 0 ? -1 : 1) * (Math.abs(x1 - x2) < 10 ? 18 : 16);
          cx = (x1 + x2) / 2 + bend;
          cy = (y1 + y2) / 2 + (isRemovedRight ? -12 : 0);
          d = 'M ' + x1 + ' ' + y1 + ' Q ' + cx + ' ' + cy + ' ' + x2 + ' ' + y2;
          const t = isRemovedRight ? 0.42 : p1.col !== p2.col ? (idx % 2 === 0 ? 0.36 : 0.66) : (idx % 2 === 0 ? 0.44 : 0.56);
          const mt = 1 - t;
          cx = mt * mt * x1 + 2 * mt * t * cx + t * t * x2;
          cy = mt * mt * y1 + 2 * mt * t * cy + t * t * y2;
        }

        const labelText = e.label.length > 30 ? e.label.slice(0, 27) + '...' : e.label;
        const boxW = Math.max(58, labelText.length * 6.1 + 12);

        edgesSvg += '<g>' +
          '<path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="' + (isActive ? 2.6 : 1.5) + '" ' + dash + ' marker-end="url(#' + containerId + '-arr-' + marker + ')" />' +
          '<rect x="' + (cx - boxW / 2) + '" y="' + (cy - 9) + '" width="' + boxW + '" height="18" rx="2" fill="#111217" stroke="' + (isActive ? '#ff9830' : '#2b303a') + '" stroke-width="1" />' +
          '<text x="' + cx + '" y="' + (cy + 3.2) + '" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="10.5" fill="' + (isActive ? '#ff9830' : '#b8bdc7') + '">' + escapeHtml(labelText) + '</text>' +
          '</g>';
      });

      let nodesSvg = '';
      for (const n of chart.nodes) {
        const p = pos.get(n.id);
        if (!p) continue;
        const isActive = activeNodeId === n.id;

        if (n.kind === 'start') {
          nodesSvg += '<circle cx="' + p.cx + '" cy="' + p.cy + '" r="9" fill="#d8d9da" stroke="#5794f2" stroke-width="2.5" />';
          continue;
        }

        const fill = n.kind === 'error' ? '#241418' : '#181b1f';
        const stroke = isActive ? '#ff9830' : n.kind === 'error' ? '#f2495c' : '#3a4150';
        const sw = isActive ? 2.4 : 1.3;
        const lines = wrapLines(n.label, 25);
        const textY = lines.length === 1 ? p.cy + 4 : p.cy - 3;

        nodesSvg += '<g class="sc-node" data-node="' + escapeHtml(n.id) + '">' +
          '<rect x="' + (p.cx - nodeW / 2) + '" y="' + (p.cy - nodeH / 2) + '" width="' + nodeW + '" height="' + nodeH + '" rx="3" fill="' + fill + '" stroke="' + stroke + '" stroke-width="' + sw + '" />' +
          '<text x="' + p.cx + '" y="' + textY + '" text-anchor="middle" font-size="11.5" font-weight="600" fill="#f0f2f5">' +
          lines.map((line, i) => '<tspan x="' + p.cx + '" dy="' + (i === 0 ? 0 : 14) + '">' + escapeHtml(line) + '</tspan>').join('') +
          '</text></g>';
      }

      container.innerHTML = '<svg width="' + svgW + '" height="' + svgH + '" viewBox="0 0 ' + svgW + ' ' + svgH + '">' + defs + edgesSvg + nodesSvg + '</svg>';
      container.querySelectorAll('.sc-node').forEach((g) => {
        g.addEventListener('click', () => {
          jumpToNodeSource(g.dataset.node, containerId === 'sfSvgWrap');
        });
      });
    }

    function renderPatchLines(patchText, emptyNote) {
      if (!patchText || !patchText.trim()) {
        return '<div class="diff-line diff-meta">' + escapeHtml(emptyNote || '(empty patch)') + '</div>';
      }
      return patchText.split(/\\r?\\n/).map((line) => {
        let cls = 'diff-line';
        if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff --git')) cls += ' diff-meta';
        else if (line.startsWith('+') || line.startsWith('-')) {
          if (line.slice(1).trim() === '...') cls += ' diff-fold';
          else cls += line.startsWith('+') ? ' diff-add' : ' diff-del';
        }
        else if (line.startsWith('@@')) cls += ' diff-hunk';
        return '<div class="' + cls + '">' + escapeHtml(line) + '</div>';
      }).join('');
    }

    function selectFile(fileName) {
      state.selectedFile = fileName;
      renderOverview();
      if (state.view === 'overview') {
        const panel = document.getElementById('selectedPatchPanel');
        if (panel && !panel.classList.contains('hidden')) {
          panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      }
      if (state.view === 'files') renderFilesView();
    }

    function renderOverview() {
      const dash = state.dashboard;
      if (!dash) return;
      const xray = dash.xray;

      const totalHunks = dash.files.reduce((acc, f) => acc + f.hunks, 0);
      document.getElementById('kpiTarget').textContent = dash.sourceLabel;
      document.getElementById('kpiScope').innerHTML =
        '<span>' + dash.files.length + ' files · ' + totalHunks + ' hunks</span>' +
        '<span><span class="c-green">+' + dash.shape.adds + '</span> / <span class="c-red">-' + dash.shape.deletes + '</span></span>';

      document.getElementById('kpiXray').innerHTML =
        '<span class="c-blue">' + xray.behavioralLines + ' meat</span>' +
        '<span class="c-muted" style="font-size:13px;font-weight:500;"> / ' + xray.totalChangedLines + ' lines</span>';
      document.getElementById('kpiXraySub').textContent =
        xray.noiseReductionPct + '% noise (' + xray.importLines + ' imp · ' + xray.moveLines + ' mov)';

      const sc = dash.statechart;
      const sig = sc.signals;
      const stateLabelEl = document.getElementById('kpiStateLabel');
      stateLabelEl.textContent = sc.shouldGenerate ? 'Statechart Recommended' : 'Low Signal';
      stateLabelEl.className = 'stat-value ' + (sc.shouldGenerate ? 'c-amber' : 'c-green');
      const sigParts = [];
      if (sig.stateMutations > 0) sigParts.push('state ' + sig.stateMutations);
      if (sig.errorPaths > 0) sigParts.push('err ' + sig.errorPaths);
      if (sig.retryCancel > 0) sigParts.push('retry ' + sig.retryCancel);
      if (sig.asyncConcurrency > 0) sigParts.push('async ' + sig.asyncConcurrency);
      if (sig.branchGuards > 0) sigParts.push('guard ' + sig.branchGuards);
      if (sig.removedGuards > 0) sigParts.push('-guard ' + sig.removedGuards);
      document.getElementById('kpiSignals').textContent = sigParts.length ? sigParts.join(' · ') : '0 control-flow cues';

      const envEl = document.getElementById('kpiEnvTitle');
      const envDetailEl = document.getElementById('kpiEnvDetail');
      const ledger = dash.ledger;
      if (ledger && ledger.available) {
        if (ledger.staleCount > 0) {
          envEl.textContent = ledger.staleCount + ' Needs Recheck';
          envEl.className = 'stat-value c-amber';
        } else {
          envEl.textContent = ledger.evidence.length + ' Verified Claims';
          envEl.className = 'stat-value c-green';
        }
        envEl.dataset.tipTitle = 'Columbo Ledger Status';
        envEl.dataset.tip = ledger.staleCount > 0
          ? ledger.staleCount + ' recorded evidence claim(s) no longer match HEAD and should be re-verified.'
          : 'All ' + ledger.evidence.length + ' recorded evidence claim(s) match current repo state.';
        envDetailEl.textContent =
          ledger.unresolvedCount + ' open decisions · ' + xray.partitionCount + ' chunk(s)';
      } else {
        envEl.textContent = xray.fitsSingleRun ? '1 Run Ready' : xray.partitionCount + ' Partitions';
        envEl.className = 'stat-value';
        envEl.dataset.tipTitle = 'Model Budget Fit';
        envEl.dataset.tip = xray.fitsSingleRun
          ? xray.rawBytes + ' B raw diff fits inside Columbo single-run limit (' + xray.maxRunBytes + ' B).'
          : xray.rawBytes + ' B raw diff exceeds ' + xray.maxRunBytes + ' B limit and splits into ' + xray.partitionCount + ' semantic chunks.';
        envDetailEl.textContent =
          'sha ' + xray.inputSha256.slice(0, 8) + ' · ' + xray.rawBytes + ' B' + (state.toolchain?.anyFormalChecker ? ' · TLC ready' : '');
      }

      const repoMetaEl = document.getElementById('repoMeta');
      const tlaMeta = state.toolchain?.anyFormalChecker ? ' · TLC ready' : '';
      if (dash.repo.isGitRepo) {
        repoMetaEl.textContent = dash.repo.branch + ' · ' + dash.repo.headSha + ' · ' + dash.repo.dirtyCount + ' dirty · sha ' + xray.inputSha256.slice(0, 8) + tlaMeta;
      } else {
        repoMetaEl.textContent = 'non-git container · sha ' + xray.inputSha256.slice(0, 8) + tlaMeta;
      }

      const maxChurn = Math.max(1, ...dash.files.map((f) => f.adds + f.deletes));
      const rankedFiles = [...dash.files].sort((a, b) => (b.adds + b.deletes) - (a.adds + a.deletes));

      document.getElementById('filesCountSub').textContent = dash.files.length + ' files · click row';
      const filesBody = document.getElementById('overviewFilesBody');
      filesBody.innerHTML = rankedFiles.map((f) => {
        const noise = f.importLines + f.moveLines;
        const wBeh = Math.max(f.behavioralLines ? 2 : 0, Math.round((f.behavioralLines / maxChurn) * 100));
        const wMov = Math.max(f.moveLines ? 2 : 0, Math.round((f.moveLines / maxChurn) * 100));
        const wImp = Math.max(f.importLines ? 2 : 0, Math.round((f.importLines / maxChurn) * 100));
        const sel = state.selectedFile === f.file ? ' selected' : '';
        const tipText = f.file + ': ' + f.behavioralLines + ' behavioral (meat) lines, ' + f.importLines + ' stripped imports, ' + f.moveLines + ' moved lines (+' + f.adds + ' / -' + f.deletes + ' raw).';
        return '<tr class="clickable' + sel + '" data-file="' + escapeHtml(f.file) + '">' +
          '<td class="truncate mono">' + escapeHtml(f.file) + '</td>' +
          '<td class="num col-xray"><div class="xray-inline" data-tip-title="Meat vs. Noise" data-tip="' + escapeHtml(tipText) + '">' +
            '<svg height="8" viewBox="0 0 100 8" preserveAspectRatio="none">' +
            '<rect x="0" y="1" width="100" height="6" fill="#111217" />' +
            '<rect x="0" y="1" width="' + wBeh + '" height="6" fill="#73bf69" />' +
            '<rect x="' + wBeh + '" y="1" width="' + Math.min(100 - wBeh, wMov) + '" height="6" fill="#ff9830" />' +
            '<rect x="' + Math.min(100, wBeh + wMov) + '" y="1" width="' + Math.min(100 - wBeh - wMov, wImp) + '" height="6" fill="#526075" />' +
            '</svg>' +
            '<span class="bar-num mono"><span class="c-green">' + f.behavioralLines + 'm</span> <span class="c-muted">(' + noise + 'n)</span></span>' +
          '</div></td>' +
          '<td class="num mono col-delta"><span class="c-green">+' + f.adds + '</span> <span class="c-muted">/</span> <span class="c-red">-' + f.deletes + '</span></td>' +
          '<td class="col-risk ' + riskClass(f.risk) + '" title="' + f.risk + ' risk"><span class="status-dot ' + riskDot(f.risk) + '" style="margin-right:6px;"></span><span class="risk-label">' + f.risk + '</span></td>' +
          '</tr>';
      }).join('') || '<tr><td colspan="4" class="c-muted">No files in diff.</td></tr>';

      filesBody.querySelectorAll('tr.clickable').forEach((row) => {
        row.addEventListener('click', () => selectFile(row.dataset.file));
      });

      const steps = sc.failureWalkthrough || [];
      if (state.activeStepIndex >= steps.length) state.activeStepIndex = steps.length ? 0 : -1;
      renderSvgInto('overviewSvgWrap', sc, state.activeStepIndex);

      const stepBtnsEl = document.getElementById('overviewStepBtns');
      let btnsHtml = steps.map((st, idx) =>
        '<button class="btn btn-xs' + (idx === state.activeStepIndex ? ' active' : '') + '" data-step="' + idx + '" type="button">' + st.step + '</button>'
      ).join('');
      btnsHtml += '<button class="btn btn-xs" data-step="-1" type="button">Clear</button>';
      stepBtnsEl.innerHTML = btnsHtml;
      stepBtnsEl.querySelectorAll('button').forEach((b) => {
        b.addEventListener('click', () => {
          state.activeStepIndex = Number(b.dataset.step);
          renderOverview();
        });
      });

      document.getElementById('overviewStepCounter').textContent =
        steps.length ? 'Step ' + (state.activeStepIndex >= 0 ? state.activeStepIndex + 1 : 0) + ' / ' + steps.length : '0 steps';
      const activeStep = state.activeStepIndex >= 0 ? steps[state.activeStepIndex] : null;
      document.getElementById('overviewStepCaption').textContent = activeStep
        ? activeStep.title + ' — ' + activeStep.detail
        : 'All failure highlight steps cleared.';
      const jumpBtn = document.getElementById('stepJumpBtn');
      if (activeStep && dash.nodeFileMap?.[activeStep.activeNodeId]) {
        jumpBtn.classList.remove('hidden');
        jumpBtn.onclick = () => jumpToNodeSource(activeStep.activeNodeId, true);
      } else {
        jumpBtn.classList.add('hidden');
      }

      const kindTips = {
        FRESH: 'Columbo ledger claim whose recorded evidence still matches the current commit.',
        RECHECK: 'Recorded claim is stale after later edits and should be re-verified.',
        DECISION: 'Open design or risk question recorded in columbo-state-v1 awaiting resolution.',
        MOVE: 'Identical multi-line block relocated across hunks (verified modulo indentation).',
        GUARD: 'Branch or validation guard detected in the diff that filters or rejects caller inputs.',
        ADDED: 'New state transition or behavioral branch introduced by this change.',
        REMOVED: 'Existing state transition or branch guard removed by this change.',
        CHECK: 'Safety invariant synthesized from error, retry, or guard edges.',
        COMPILER: 'Deterministic pre-pass summary: stripped import noise and LLM byte-budget chunks.',
      };

      const checksRows = [];
      if (ledger && ledger.available) {
        for (const ev of ledger.evidence.slice(0, 3)) {
          const isStale = ev.freshness === 'needs_recheck';
          const lbl = isStale ? 'RECHECK' : 'FRESH';
          checksRows.push('<tr><td class="mono ' + (isStale ? 'c-amber' : 'c-green') + '" style="font-weight:600;" data-tip-title="' + lbl + '" data-tip="' + escapeHtml(kindTips[lbl]) + '">' + lbl + '</td><td class="mono">' + escapeHtml(ev.id + ' (' + ev.basis + ')') + '</td></tr>');
        }
        for (const dec of ledger.decisions.filter((d) => d.answer === null).slice(0, 2)) {
          checksRows.push('<tr><td class="mono c-amber" style="font-weight:600;" data-tip-title="DECISION" data-tip="' + escapeHtml(kindTips.DECISION) + '">DECISION</td><td>' + escapeHtml(dec.question) + '</td></tr>');
        }
      }
      for (const mv of xray.moves.slice(0, 2)) {
        checksRows.push('<tr><td class="mono c-amber" style="font-weight:600;" data-tip-title="MOVE" data-tip="' + escapeHtml(kindTips.MOVE) + '">MOVE</td><td class="mono">' + escapeHtml(mv.removedFile + ' ' + mv.removedRange + ' <-> ' + mv.addedFile + ' ' + mv.addedRange + ' (' + mv.lineCount + 'L)') + '</td></tr>');
      }
      for (const d of sc.transitionDelta.slice(0, 3)) {
        const cls = d.change === 'added' ? 'c-green' : d.change === 'removed' ? 'c-red' : d.change === 'guard' ? 'c-amber' : 'c-muted';
        const up = String(d.change || '').toUpperCase();
        const tipAttr = kindTips[up] ? ' data-tip-title="' + escapeHtml(up) + '" data-tip="' + escapeHtml(kindTips[up]) + '"' : '';
        checksRows.push('<tr><td class="mono ' + cls + '" style="font-weight:600;text-transform:uppercase;"' + tipAttr + '>' + escapeHtml(d.change) + '</td><td>' + escapeHtml(d.summary) + '</td></tr>');
      }
      for (const inv of sc.invariants.slice(0, 2)) {
        checksRows.push('<tr><td class="mono c-blue" style="font-weight:600;" data-tip-title="CHECK" data-tip="' + escapeHtml(kindTips.CHECK) + '">CHECK</td><td>' + escapeHtml(inv) + '</td></tr>');
      }
      checksRows.push('<tr><td class="mono c-muted" style="font-weight:600;" data-tip-title="COMPILER" data-tip="' + escapeHtml(kindTips.COMPILER) + '">COMPILER</td><td class="mono">' + (xray.compilerEligible ? xray.importLines + ' imports stripped · ' + xray.partitionCount + ' chunk(s)' : escapeHtml(xray.compilerReason || 'ineligible')) + '</td></tr>');
      document.getElementById('checksTableBody').innerHTML = checksRows.join('');

      const patchPanel = document.getElementById('selectedPatchPanel');
      const selectedObj = dash.files.find((f) => f.file === state.selectedFile);
      if (selectedObj) {
        patchPanel.classList.remove('hidden');
        document.getElementById('selectedPatchTitle').textContent =
          selectedObj.file + ' · ' + selectedObj.behavioralLines + ' meat / ' + selectedObj.importLines + ' imports / ' + selectedObj.moveLines + ' moved';
        document.getElementById('selectedPatchView').innerHTML = renderPatchLines(selectedObj.patch);
      } else {
        patchPanel.classList.add('hidden');
      }
    }

    function renderStateflowView() {
      const chart = activeChartObject();
      if (!chart) return;
      document.getElementById('sfTitle').textContent = chart.title;
      document.getElementById('sfEvidence').textContent = chart.evidenceLabel;
      document.getElementById('sfTrigger').textContent = chart.triggerReason;
      document.getElementById('sfMermaid').textContent = chart.mermaid;
      const refs = chart.sourceRefs || [];
      document.getElementById('sfRefs').textContent = refs.length <= 2 ? refs.join(', ') : refs.length + ' files';

      const steps = chart.failureWalkthrough || [];
      if (state.activeStepIndex >= steps.length) state.activeStepIndex = steps.length ? 0 : -1;
      renderSvgInto('sfSvgWrap', chart, state.activeStepIndex);

      const stepsBody = document.getElementById('sfStepsBody');
      stepsBody.innerHTML = steps.map((st, idx) => {
        const cls = idx === state.activeStepIndex ? ' selected' : '';
        return '<tr class="clickable' + cls + '" data-step="' + idx + '">' +
          '<td class="mono">' + st.step + '</td>' +
          '<td style="font-weight:600;">' + escapeHtml(st.title) + '</td>' +
          '<td class="c-muted">' + escapeHtml(st.detail) + '</td>' +
          '</tr>';
      }).join('') || '<tr><td colspan="3" class="c-muted">No failure steps extracted.</td></tr>';

      stepsBody.querySelectorAll('tr.clickable').forEach((r) => {
        r.addEventListener('click', () => {
          state.activeStepIndex = Number(r.dataset.step);
          renderStateflowView();
        });
      });

      const metaRows = [
        ...chart.invariants.map((i) => '<tr><td class="mono c-blue" style="width:96px;font-weight:600;">INVARIANT</td><td>' + escapeHtml(i) + '</td></tr>'),
        ...chart.omissions.map((o) => '<tr><td class="mono c-amber" style="width:96px;font-weight:600;">OMISSION</td><td>' + escapeHtml(o) + '</td></tr>'),
      ];
      document.getElementById('sfMetaBody').innerHTML = metaRows.join('');
    }

    function renderFilesView() {
      const dash = state.dashboard;
      if (!dash) return;
      const xray = dash.xray;
      const tot = Math.max(1, xray.totalChangedLines);
      const bPct = ((xray.behavioralLines / tot) * 100).toFixed(1);
      const mPct = ((xray.moveLines / tot) * 100).toFixed(1);
      const iPct = ((xray.importLines / tot) * 100).toFixed(1);

      document.getElementById('shapeSummary').textContent =
        xray.behavioralLines + ' behavioral · ' + xray.moveLines + ' moved · ' + xray.importLines + ' imports (' + xray.noiseReductionPct + '% noise) · ' + xray.partitionCount + ' chunk(s)';
      document.getElementById('xrayBarWrap').innerHTML =
        '<div style="display:flex;height:100%;width:100%;">' +
        '<div style="width:' + bPct + '%;background:#73bf69;"></div>' +
        '<div style="width:' + mPct + '%;background:#ff9830;"></div>' +
        '<div style="width:' + iPct + '%;background:#526075;"></div>' +
        '</div>';

      document.getElementById('modeMovesBtn').textContent = 'Moves (' + xray.moves.length + ')';
      document.querySelectorAll('[data-patch-mode]').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.patchMode === state.patchMode);
      });

      const q = state.fileQuery.trim().toLowerCase();
      const filtered = dash.files.filter((f) => {
        if (state.riskFilter !== 'all' && f.risk !== state.riskFilter) return false;
        if (q && !f.file.toLowerCase().includes(q)) return false;
        return true;
      });
      document.getElementById('filteredFilesCount').textContent = filtered.length + ' / ' + dash.files.length;

      const listBody = document.getElementById('filesTabBody');
      listBody.innerHTML = filtered.map((f) => {
        const sel = state.selectedFile === f.file ? ' selected' : '';
        const noise = f.importLines + f.moveLines;
        return '<tr class="clickable' + sel + '" data-file="' + escapeHtml(f.file) + '">' +
          '<td class="truncate mono">' + escapeHtml(f.file) + '</td>' +
          '<td class="num mono"><span class="c-green">' + f.behavioralLines + '</span> / <span class="c-muted">' + noise + '</span></td>' +
          '<td class="' + riskClass(f.risk) + '">' + f.risk + '</td>' +
          '</tr>';
      }).join('') || '<tr><td colspan="3" class="c-muted">No matching files.</td></tr>';

      listBody.querySelectorAll('tr.clickable').forEach((r) => {
        r.addEventListener('click', () => {
          state.selectedFile = r.dataset.file;
          if (state.patchMode === 'moves') state.patchMode = 'raw';
          renderFilesView();
        });
      });

      const activeFile = filtered.find((f) => f.file === state.selectedFile) || filtered[0] || null;
      const viewerEl = document.getElementById('filesPatchViewer');
      if (state.patchMode === 'moves') {
        document.getElementById('filesPatchTitle').textContent = 'Exact Relocated Blocks';
        document.getElementById('filesPatchMeta').textContent = xray.moves.length + ' symmetric move pair(s) verified byte-for-byte modulo indentation';
        if (!xray.moves.length) {
          viewerEl.innerHTML = '<div class="diff-line diff-meta">(No cross-hunk exact move pairs detected in this diff.)</div>';
        } else {
          viewerEl.innerHTML = '<table class="grid-table"><thead><tr><th>From</th><th>To</th><th class="num">Lines</th><th>Preview</th></tr></thead><tbody>' +
            xray.moves.map((m) =>
              '<tr class="clickable" data-jump="' + escapeHtml(m.addedFile) + '">' +
              '<td class="mono">' + escapeHtml(m.removedFile + ' ' + m.removedRange) + '</td>' +
              '<td class="mono c-amber">' + escapeHtml(m.addedFile + ' ' + m.addedRange) + '</td>' +
              '<td class="num mono">' + m.lineCount + '</td>' +
              '<td class="mono truncate">' + escapeHtml(m.preview) + '</td>' +
              '</tr>'
            ).join('') + '</tbody></table>';
          viewerEl.querySelectorAll('[data-jump]').forEach((row) => {
            row.addEventListener('click', () => {
              const targetFile = row.dataset.jump;
              resetFileFiltersIfHidden(targetFile);
              state.selectedFile = targetFile;
              state.patchMode = 'meat';
              renderFilesView();
            });
          });
        }
        return;
      }

      if (activeFile) {
        state.selectedFile = activeFile.file;
        document.getElementById('filesPatchTitle').textContent = activeFile.file;
        document.getElementById('filesPatchMeta').textContent =
          state.patchMode === 'meat'
            ? activeFile.behavioralLines + ' behavioral · ' + activeFile.importLines + ' imports stripped · ' + activeFile.moveLines + ' moved'
            : '+' + activeFile.adds + ' / -' + activeFile.deletes + ' · ' + activeFile.hunks + ' hunks · ' + activeFile.risk + ' risk';
        const text = state.patchMode === 'meat' ? activeFile.meatPatch : activeFile.patch;
        viewerEl.innerHTML = renderPatchLines(
          text,
          state.patchMode === 'meat'
            ? '(All changed lines in this file were compiler-stripped imports. Switch to Raw Diff to view.)'
            : '(Empty patch)',
        );
      } else {
        document.getElementById('filesPatchTitle').textContent = 'No file selected';
        document.getElementById('filesPatchMeta').textContent = '';
        viewerEl.innerHTML = '';
      }
    }

    async function fetchDashboard(body) {
      const pasteErrEl = document.getElementById('pasteError');
      const drawer = document.getElementById('pasteDrawer');
      const drawerOpen = drawer && !drawer.classList.contains('hidden');
      if (pasteErrEl) {
        pasteErrEl.classList.add('hidden');
        pasteErrEl.textContent = '';
      }
      clearGlobalError();
      try {
        const res = await fetch('/api/dashboard', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        let data = {};
        try {
          data = await res.json();
        } catch {
          data = { error: 'Server returned non-JSON response (' + res.status + ').' };
        }
        if (!res.ok || data.error) {
          const msg = data.error || ('Request failed (' + res.status + ')');
          if (drawerOpen && pasteErrEl) {
            pasteErrEl.textContent = msg;
            pasteErrEl.classList.remove('hidden');
          } else {
            showGlobalError(msg);
          }
          return false;
        }
        state.dashboard = data.dashboard;
        state.toolchain = data.toolchain;
        state.samples = data.samples || [];
        state.rawDiff = data.rawDiff || '';
        if (data.activeSource) {
          state.mode = data.activeSource.mode || state.mode;
          if (data.activeSource.gitTarget) state.gitTarget = data.activeSource.gitTarget;
          if (data.activeSource.sampleId) state.sampleId = data.activeSource.sampleId;
        }
        if (state.selectedFile && !state.dashboard.files.some((f) => f.file === state.selectedFile)) {
          state.selectedFile = null;
        }
        state.activeStepIndex = state.dashboard.statechart.failureWalkthrough.length ? 0 : -1;

        populateSelectors();
        renderOverview();
        if (state.view === 'stateflow') renderStateflowView();
        if (state.view === 'files') renderFilesView();
        return true;
      } catch (err) {
        const msg = 'Network error contacting columbo server: ' + (err?.message || String(err));
        if (drawerOpen && pasteErrEl) {
          pasteErrEl.textContent = msg;
          pasteErrEl.classList.remove('hidden');
        } else {
          showGlobalError(msg);
        }
        return false;
      }
    }

    function populateSelectors() {
      const srcEl = document.getElementById('sourceSelect');
      const smpEl = document.getElementById('sampleSelect');
      const sampleWrap = document.getElementById('sampleWrap');
      if (!srcEl.options.length) {
        const git = state.dashboard?.repo?.isGitRepo;
        if (git) {
          const opts = [
            { v: 'git:HEAD', t: 'Git HEAD' },
            { v: 'git:--staged', t: 'Git Staged (--cached)' },
            { v: 'git:--worktree', t: 'Git Working Tree' },
            ...state.dashboard.repo.commits.slice(0, 6).map((c) => ({ v: 'git:' + c.sha, t: c.sha + ' · ' + c.subject.slice(0, 34) })),
            { v: 'sample', t: 'Real Commits' },
          ];
          srcEl.innerHTML = opts.map((o) => '<option value="' + escapeHtml(o.v) + '">' + escapeHtml(o.t) + '</option>').join('');
        } else {
          srcEl.innerHTML = '<option value="sample">Real Commits</option>';
        }
      }
      if (!smpEl.options.length) {
        smpEl.innerHTML = state.samples.map((s) => '<option value="' + escapeHtml(s.id) + '">' + escapeHtml(s.label) + '</option>').join('');
      }
      if (state.mode === 'git') {
        const desired = 'git:' + state.gitTarget;
        if ([...srcEl.options].some((o) => o.value === desired)) srcEl.value = desired;
        sampleWrap.classList.add('hidden');
      } else if (state.mode === 'sample') {
        if ([...srcEl.options].some((o) => o.value === 'sample')) srcEl.value = 'sample';
        if ([...smpEl.options].some((o) => o.value === state.sampleId)) smpEl.value = state.sampleId;
        sampleWrap.classList.remove('hidden');
      } else {
        sampleWrap.classList.add('hidden');
      }
    }

    document.getElementById('dismissErrorBtn').addEventListener('click', clearGlobalError);

    document.getElementById('sourceSelect').addEventListener('change', async (e) => {
      const val = e.target.value;
      const sampleWrap = document.getElementById('sampleWrap');
      if (val.startsWith('git:')) {
        state.mode = 'git';
        state.gitTarget = val.slice(4);
        sampleWrap.classList.add('hidden');
        await fetchDashboard({ mode: 'git', gitTarget: state.gitTarget });
      } else {
        state.mode = 'sample';
        sampleWrap.classList.remove('hidden');
        await fetchDashboard({ mode: 'sample', sampleId: state.sampleId });
      }
    });

    document.getElementById('sampleSelect').addEventListener('change', async (e) => {
      state.mode = 'sample';
      state.sampleId = e.target.value;
      await fetchDashboard({ mode: 'sample', sampleId: state.sampleId });
    });

    document.getElementById('refreshBtn').addEventListener('click', async () => {
      if (state.mode === 'paste') {
        await fetchDashboard({ mode: 'paste', diff: state.rawDiff || document.getElementById('pasteInput').value });
      } else if (state.mode === 'github') {
        await fetchDashboard({ mode: 'github', url: state.githubUrl });
      } else if (state.mode === 'git') {
        await fetchDashboard({ mode: 'git', gitTarget: state.gitTarget });
      } else {
        await fetchDashboard({ mode: 'sample', sampleId: state.sampleId });
      }
    });

    document.getElementById('togglePasteBtn').addEventListener('click', () => {
      document.getElementById('pasteDrawer').classList.toggle('hidden');
    });
    document.getElementById('closePasteBtn').addEventListener('click', () => {
      document.getElementById('pasteDrawer').classList.add('hidden');
    });
    document.getElementById('analyzePasteBtn').addEventListener('click', async () => {
      const diff = document.getElementById('pasteInput').value;
      if (!diff.trim()) {
        const pasteErrEl = document.getElementById('pasteError');
        if (pasteErrEl) {
          pasteErrEl.textContent = 'Paste a unified git diff or fetch a GitHub URL first.';
          pasteErrEl.classList.remove('hidden');
        }
        return;
      }
      const ok = await fetchDashboard({ mode: 'paste', diff });
      if (ok) {
        state.mode = 'paste';
        document.getElementById('pasteDrawer').classList.add('hidden');
      }
    });

    async function handleFetchGithub() {
      const btn = document.getElementById('fetchGithubBtn');
      const url = document.getElementById('githubUrlInput').value.trim();
      btn.disabled = true;
      btn.textContent = 'Fetching...';
      try {
        const ok = await fetchDashboard({ mode: 'github', url });
        if (ok) {
          state.mode = 'github';
          state.githubUrl = url;
          document.getElementById('pasteInput').value = state.rawDiff || '';
          document.getElementById('pasteDrawer').classList.add('hidden');
        }
      } finally {
        btn.disabled = false;
        btn.textContent = 'Fetch GitHub Diff';
      }
    }
    document.getElementById('fetchGithubBtn').addEventListener('click', handleFetchGithub);
    document.getElementById('githubUrlInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleFetchGithub();
      }
    });

    document.getElementById('copyTriageBtn').addEventListener('click', async () => {
      const btn = document.getElementById('copyTriageBtn');
      const triage = state.dashboard?.agentTriage;
      if (!triage) return;
      const jsonText = JSON.stringify(triage, null, 2);
      let copied = false;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        try {
          await navigator.clipboard.writeText(jsonText);
          copied = true;
        } catch {}
      }
      btn.textContent = copied ? 'Copied Triage' : 'Ready (' + jsonText.length + 'B)';
      setTimeout(() => { btn.textContent = 'Copy Triage'; }, 1400);
    });

    document.getElementById('copyPacketBtn').addEventListener('click', async () => {
      const btn = document.getElementById('copyPacketBtn');
      btn.disabled = true;
      btn.textContent = 'Building...';
      try {
        const res = await fetch('/api/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'prompt', diff: state.rawDiff }),
        });
        const data = await res.json();
        if (res.ok && data.code === 0 && data.stdout) {
          let copied = false;
          if (navigator.clipboard && navigator.clipboard.writeText) {
            try {
              await navigator.clipboard.writeText(data.stdout);
              copied = true;
            } catch {}
          }
          btn.textContent = copied ? 'Copied Packet' : 'Ready (' + data.stdout.length + 'B)';
        } else {
          btn.textContent = 'Failed';
          showGlobalError(data.stderr || data.error || 'Failed to build offline review packet.');
        }
      } catch (err) {
        btn.textContent = 'Failed';
        showGlobalError('Failed to build offline review packet: ' + (err?.message || String(err)));
      } finally {
        btn.disabled = false;
        setTimeout(() => { btn.textContent = 'Copy Packet'; }, 1400);
      }
    });

    document.getElementById('openMeatInFilesBtn').addEventListener('click', () => {
      state.patchMode = 'meat';
      switchView('files');
    });
    document.getElementById('closePatchBtn').addEventListener('click', () => {
      state.selectedFile = null;
      renderOverview();
    });

    document.querySelectorAll('[data-patch-mode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.patchMode = btn.dataset.patchMode;
        renderFilesView();
      });
    });

    document.getElementById('sfPrevBtn').addEventListener('click', () => {
      const steps = activeChartObject()?.failureWalkthrough || [];
      if (!steps.length) return;
      state.activeStepIndex = state.activeStepIndex <= 0 ? steps.length - 1 : state.activeStepIndex - 1;
      renderStateflowView();
    });
    document.getElementById('sfNextBtn').addEventListener('click', () => {
      const steps = activeChartObject()?.failureWalkthrough || [];
      if (!steps.length) return;
      state.activeStepIndex = (state.activeStepIndex + 1) % steps.length;
      renderStateflowView();
    });
    document.getElementById('sfClearBtn').addEventListener('click', () => {
      state.activeStepIndex = -1;
      renderStateflowView();
    });
    document.getElementById('copyMermaidBtn').addEventListener('click', async () => {
      const text = document.getElementById('sfMermaid').textContent || '';
      const btn = document.getElementById('copyMermaidBtn');
      let copied = false;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        try {
          await navigator.clipboard.writeText(text);
          copied = true;
        } catch {}
      }
      btn.textContent = copied ? 'Copied' : 'Ready';
      setTimeout(() => { btn.textContent = 'Copy Mermaid'; }, 1200);
    });

    document.getElementById('fileFilterInput').addEventListener('input', (e) => {
      state.fileQuery = e.target.value;
      renderFilesView();
    });
    document.querySelectorAll('[data-risk]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.riskFilter = btn.dataset.risk;
        document.querySelectorAll('[data-risk]').forEach((b) => b.classList.toggle('active', b === btn));
        renderFilesView();
      });
    });

    const tipBox = document.getElementById('metricTooltip');
    const tipTitleEl = document.getElementById('metricTooltipTitle');
    const tipBodyEl = document.getElementById('metricTooltipBody');
    let tipAnchor = null;
    let pinnedTarget = null;

    function positionTooltip(target) {
      if (!target || !tipBox) return;
      tipBox.style.top = '0px';
      tipBox.style.left = '0px';
      const rect = target.getBoundingClientRect();
      const tipRect = tipBox.getBoundingClientRect();
      const pad = 8;
      let top = rect.top - tipRect.height - pad;
      if (top < pad) {
        top = rect.bottom + pad;
      }
      let left = rect.left + (rect.width / 2) - (tipRect.width / 2);
      left = Math.max(pad, Math.min(window.innerWidth - tipRect.width - pad, left));
      tipBox.style.top = Math.round(top) + 'px';
      tipBox.style.left = Math.round(left) + 'px';
    }

    function showTooltip(target) {
      const body = target?.dataset?.tip;
      if (!body) return;
      if (tipAnchor && tipAnchor !== target && tipAnchor.classList.contains('tip-btn')) {
        tipAnchor.setAttribute('aria-expanded', 'false');
      }
      tipAnchor = target;
      const title = target.dataset.tipTitle || '';
      tipTitleEl.textContent = title;
      tipTitleEl.classList.toggle('hidden', !title);
      tipBodyEl.textContent = body;
      tipBox.setAttribute('aria-hidden', 'false');
      tipBox.classList.add('visible');
      if (target.classList.contains('tip-btn')) {
        target.setAttribute('aria-expanded', 'true');
      }
      positionTooltip(target);
    }

    function hideTooltip() {
      if (tipAnchor && tipAnchor.classList.contains('tip-btn')) {
        tipAnchor.setAttribute('aria-expanded', 'false');
      }
      tipAnchor = null;
      pinnedTarget = null;
      tipBox.classList.remove('visible');
      tipBox.setAttribute('aria-hidden', 'true');
    }

    document.addEventListener('pointerover', (e) => {
      if (e.pointerType !== 'mouse' || pinnedTarget) return;
      const target = e.target.closest('[data-tip]');
      if (target) showTooltip(target);
    });
    document.addEventListener('pointerout', (e) => {
      if (e.pointerType !== 'mouse' || !tipAnchor || pinnedTarget) return;
      const related = e.relatedTarget?.closest?.('[data-tip]');
      if (!related) hideTooltip();
    });
    document.addEventListener('focusin', (e) => {
      if (pinnedTarget) return;
      const target = e.target.closest('[data-tip]');
      if (target && target.matches(':focus-visible')) showTooltip(target);
    });
    document.addEventListener('focusout', () => {
      if (!pinnedTarget) hideTooltip();
    });
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('.tip-btn');
      if (btn) {
        e.stopPropagation();
        if (pinnedTarget === btn && tipBox.classList.contains('visible')) {
          hideTooltip();
        } else {
          pinnedTarget = btn;
          showTooltip(btn);
        }
        return;
      }
      if (tipAnchor) hideTooltip();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') hideTooltip();
    });
    window.addEventListener('scroll', () => {
      if (tipAnchor && tipBox.classList.contains('visible')) positionTooltip(tipAnchor);
    }, { passive: true });
    window.addEventListener('resize', () => {
      if (tipAnchor && tipBox.classList.contains('visible')) positionTooltip(tipAnchor);
    });

    fetchDashboard({ mode: 'auto', sampleId: 'linux-tty' });
  </script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/api/dashboard') {
      const body = req.method === 'POST' ? await readJsonBody(req) : {};
      const requestedMode = String(body.mode || url.searchParams.get('mode') || 'auto');
      const reqSampleId = String(body.sampleId || url.searchParams.get('sampleId') || 'linux-tty');
      const reqGitTarget = String(body.gitTarget || url.searchParams.get('gitTarget') || 'HEAD');

      let resolvedMode = requestedMode;
      let resolvedGitTarget = reqGitTarget;
      let resolvedSampleId = reqSampleId;
      let diffText = '';
      let sourceLabel = 'Real Commit';

      if (requestedMode === 'paste') {
        diffText = String(body.diff || '');
        if (!diffText.trim()) {
          throw new HttpError(400, 'Paste a unified git diff before analyzing.');
        }
        sourceLabel = String(body.title || body.label || 'Custom diff');
      } else if (requestedMode === 'github') {
        try {
          const ghRes = await fetchGitHubDiff(body.url || body.githubRef || url.searchParams.get('url') || '');
          diffText = ghRes.diffText;
          sourceLabel = ghRes.sourceLabel;
        } catch (err) {
          throw new HttpError(400, err instanceof Error ? err.message : String(err));
        }
      } else if (requestedMode === 'git' || requestedMode === 'auto') {
        const repo = collectRepoStatus(__dirname);
        const gitRes = repo.isGitRepo ? readGitDiff(reqGitTarget) : null;
        if (gitRes && gitRes.diffText.trim()) {
          resolvedMode = 'git';
          resolvedGitTarget = reqGitTarget;
          diffText = gitRes.diffText;
          sourceLabel = gitRes.sourceLabel;
        } else if (requestedMode === 'git') {
          resolvedMode = 'git';
          resolvedGitTarget = reqGitTarget;
          diffText = '';
          sourceLabel = gitRes ? gitRes.sourceLabel : `Git ${reqGitTarget}`;
        } else {
          resolvedMode = 'sample';
        }
      }

      if (resolvedMode === 'sample' || (!diffText && resolvedMode !== 'paste' && resolvedMode !== 'github' && resolvedMode !== 'git')) {
        resolvedMode = 'sample';
        const sample = SAMPLES.find((s) => s.id === reqSampleId) || SAMPLES[0];
        resolvedSampleId = sample.id;
        diffText = await fs.readFile(path.join(__dirname, sample.file), 'utf8');
        sourceLabel = sample.label;
      }

      const dashboard = await buildDashboardPayload(diffText, sourceLabel, __dirname, {
        includeLedger: resolvedMode === 'git',
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        toolchain: getToolchainStatus(),
        activeSource: {
          mode: resolvedMode,
          gitTarget: resolvedGitTarget,
          sampleId: resolvedSampleId,
        },
        dashboard,
        samples: SAMPLES.map(({ id, label }) => ({ id, label })),
        rawDiff: diffText,
      }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/statecharts/references') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        toolchain: getToolchainStatus(),
        references: getReferenceStatecharts(),
      }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/statecharts/analyze') {
      const body = await readJsonBody(req);
      const chart = analyzeDiffForStatechart(String(body.diff || ''), String(body.title || body.label || 'Uploaded diff'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(chart));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/samples') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(SAMPLES.map(({ id, label }) => ({ id, label }))));
      return;
    }

    if (req.method === 'GET' && url.pathname.startsWith('/api/samples/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/samples/'.length));
      const sample = SAMPLES.find((s) => s.id === id);
      if (!sample) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Sample not found');
        return;
      }
      const content = await fs.readFile(path.join(__dirname, sample.file), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(content);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/run') {
      const body = await readJsonBody(req);
      const args = ALLOWED_MODES[body.mode];
      if (!args) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 2, stdout: '', stderr: 'Unsupported mode' }));
        return;
      }
      const needsStdin = ['look', 'prompt', 'statechart', 'inventory', 'plan'].includes(body.mode);
      const result = await runColumbo(args, needsStdin ? (body.diff || '') : undefined);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    if (req.method === 'GET' && (url.pathname === '/viewer' || url.pathname === '/viewer/')) {
      const html = await fs.readFile(
        path.join(__dirname, 'analysis/site-demo-commits-2026-08-02/viewer.html'),
        'utf8',
      );
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/data.js') {
      const js = await fs.readFile(
        path.join(__dirname, 'analysis/site-demo-commits-2026-08-02/data.js'),
        'utf8',
      );
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      res.end(js);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(INDEX_HTML);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  } catch (err) {
    const status = err instanceof HttpError ? err.statusCode : 500;
    const message = err instanceof Error ? err.message : String(err);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: message }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`columbo server listening on http://${HOST}:${PORT}`);
});
