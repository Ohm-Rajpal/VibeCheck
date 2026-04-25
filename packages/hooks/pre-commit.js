#!/usr/bin/env node
// VibeCheck Layer 2A — pre-commit comprehension gate.
// Skeleton: agent detection + backend ping + terminal freeze loop.

const { execSync } = require('child_process');
const fs = require('fs');

const PASS_FILE = process.env.PASS_FILE || '.vibecheck-pass.tmp';
const TIMEOUT_MS = Number(process.env.GATE_TIMEOUT_MS || 5 * 60 * 1000);
const BACKEND = process.env.BACKEND_URL || 'http://localhost:8000';
const EXT_PORT = Number(process.env.CHECKPOINT_PORT || 3456);

// ── Agent detection ───────────────────────────────────────
const isAgentCommit =
  process.env.CLAUDE_CODE ||
  process.env.CURSOR_AGENT ||
  process.env.WINDSURF_AGENT ||
  process.env.CI;

// ── Devin detection ───────────────────────────────────────
const committerEmail = safeExec('git config user.email');
const DEVIN_EMAILS = [
  'devin-ai-integration[bot]@users.noreply.github.com',
  'devin@cognition.ai',
];
const isDevin =
  DEVIN_EMAILS.some((e) => committerEmail.includes(e)) ||
  !!process.env.DEVIN_SESSION_ID;

if (isAgentCommit || isDevin) {
  // Log but never block agent commits.
  // TODO: POST /gate/agent-commit
  process.exit(0);
}

// ── Human commit flow ─────────────────────────────────────
const diff = safeExec('git diff --cached');
if (!diff.trim()) process.exit(0);

const claudeMd = fs.existsSync('./CLAUDE.md')
  ? fs.readFileSync('./CLAUDE.md', 'utf8')
  : '';

// TODO: POST /gate/generate, ping extension at EXT_PORT, then spin until PASS_FILE.
console.log('🧠 VibeCheck pre-commit hook (skeleton).');
console.log(`Backend: ${BACKEND}  Extension: :${EXT_PORT}`);
console.log(`Diff size: ${diff.split('\n').length} lines`);
process.exit(0);

// ── helpers ────────────────────────────────────────────────
function safeExec(cmd) {
  try {
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return '';
  }
}
