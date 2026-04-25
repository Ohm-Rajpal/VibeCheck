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
