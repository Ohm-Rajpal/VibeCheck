#!/usr/bin/env node
// VibeCheck Layer 2A — pre-commit comprehension gate.
// Blocks commit, starts AST analysis, waits for pass signal.

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const PASS_FILE = process.env.PASS_FILE || '.vibecheck-pass.tmp';
const FAIL_FILE = process.env.FAIL_FILE || '.vibecheck-fail.tmp';
const TIMEOUT_MS = Number(process.env.GATE_TIMEOUT_MS || 5 * 60 * 1000);
const BACKEND = process.env.BACKEND_URL || 'http://localhost:8000';
const EXT_PORT = Number(process.env.CHECKPOINT_PORT || 3456);
const POLL_MS = 500;

// ── Agent detection ───────────────────────────────────────
// keep in sync with packages/vscode-extension/src/detection/agents.ts
const KNOWN_AGENT_EMAILS = [
  'devin-ai-integration[bot]@users.noreply.github.com',
  'devin@cognition.ai',
  'noreply@anthropic.com',
  'copilot-swe-agent[bot]@users.noreply.github.com',
];
const KNOWN_AGENT_ENV_VARS = [
  'CLAUDE_CODE',
  'CURSOR_AGENT',
  'WINDSURF_AGENT',
  'DEVIN_SESSION_ID',
  'CI',
];

const committerEmail = safeExec('git config user.email').toLowerCase();
const isAgentEmail = KNOWN_AGENT_EMAILS.some((e) =>
  committerEmail.includes(e.toLowerCase())
);
const isAgentEnv = KNOWN_AGENT_ENV_VARS.some((v) => !!process.env[v]);
const isAgentCommit = isAgentEmail || isAgentEnv;

if (isAgentCommit) {
  // Log but never block agent commits — they get reviewed at PR time
  // (Layer 2B) or via the Gemma diff classifier (next sprint).
  // TODO: POST /gate/agent-commit
  process.exit(0);
}

// ── Human commit flow ─────────────────────────────────────
const diff = safeExec('git diff --cached');
if (!diff.trim()) process.exit(0);

const claudeMd = fs.existsSync('./CLAUDE.md')
  ? fs.readFileSync('./CLAUDE.md', 'utf8')
  : '';

(async () => {
  const workspaceRoot = process.cwd();
  const passFilePath = path.resolve(workspaceRoot, PASS_FILE);
  const failFilePath = path.resolve(workspaceRoot, FAIL_FILE);
  cleanupSignalFiles(passFilePath, failFilePath);

  const questions = generateAstQuestions(workspaceRoot);
  const payload = {
    session_id: `pre-commit-${Date.now()}`,
    questions,
    trigger: 'pre_commit',
    metadata: {
      backend: BACKEND,
      claude_md_present: Boolean(claudeMd.trim()),
      diff_lines: diff.split('\n').length,
    },
  };

  const posted = await postCheckpointPayload(payload, EXT_PORT);
  if (!posted) {
    console.error(
      `[VibeCheck] Could not reach extension on :${EXT_PORT}. Aborting commit so checks are not bypassed.`
    );
    process.exit(1);
  }

  console.log('[VibeCheck] Pre-commit checkpoint opened in VS Code.');
  console.log(
    `[VibeCheck] Waiting for pass signal file: ${path.relative(workspaceRoot, passFilePath)}`
  );
  console.log(
    `[VibeCheck] You can fail explicitly by creating: ${path.relative(workspaceRoot, failFilePath)}`
  );

  const start = Date.now();
  while (Date.now() - start < TIMEOUT_MS) {
    if (fs.existsSync(passFilePath)) {
      cleanupSignalFiles(passFilePath, failFilePath);
      console.log('[VibeCheck] Pass signal detected. Proceeding with commit.');
      process.exit(0);
    }
    if (fs.existsSync(failFilePath)) {
      cleanupSignalFiles(passFilePath, failFilePath);
      console.error('[VibeCheck] Fail signal detected. Aborting commit.');
      process.exit(1);
    }
    sleep(POLL_MS);
  }

  console.error(
    `[VibeCheck] Timed out after ${Math.round(TIMEOUT_MS / 1000)}s waiting for PASS_FILE. Aborting commit.`
  );
  process.exit(1);
})();

// ── helpers ────────────────────────────────────────────────
function generateAstQuestions(workspaceRoot) {
  try {
    const analyzerPath = path.join(
      workspaceRoot,
      'packages',
      'vscode-extension',
      'out',
      'analysis',
      'gitDiffAst.js'
    );
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const { generateQuestionsFromGitDiff } = require(analyzerPath);
    const questions = generateQuestionsFromGitDiff(workspaceRoot, { staged: true });
    return Array.isArray(questions) ? questions : [];
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    return [
      {
        question:
          'Which behavior changed in this staged diff, and what tests prove the previous behavior still works?',
        why: `AST analyzer failed in pre-commit hook: ${message}`,
      },
    ];
  }
}

function postCheckpointPayload(payload, port) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/checkpoint',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 2500,
      },
      (res) => {
        const ok = (res.statusCode ?? 500) >= 200 && (res.statusCode ?? 500) < 300;
        resolve(ok);
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.write(body);
    req.end();
  });
}

function cleanupSignalFiles(passFilePath, failFilePath) {
  try {
    if (fs.existsSync(passFilePath)) {
      fs.unlinkSync(passFilePath);
    }
  } catch {}
  try {
    if (fs.existsSync(failFilePath)) {
      fs.unlinkSync(failFilePath);
    }
  } catch {}
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function safeExec(cmd) {
  try {
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return '';
  }
}
