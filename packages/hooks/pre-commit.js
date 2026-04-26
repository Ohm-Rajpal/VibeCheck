#!/usr/bin/env node
// VibeCheck Layer 2A — pre-commit comprehension gate.
// Blocks commit, starts AST analysis, waits for pass signal.

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const PASS_FILE = process.env.PASS_FILE || '.vibecheck-pass.tmp';
const FAIL_FILE = process.env.FAIL_FILE || '.vibecheck-fail.tmp';
const TIMEOUT_MS = Number(process.env.GATE_TIMEOUT_MS || 5 * 60 * 1000);
const BACKEND = process.env.BACKEND_URL || 'http://localhost:8000';
const EXT_PORT = Number(process.env.CHECKPOINT_PORT || 3456);
const POLL_MS = 500;
const QUESTION_API_URL = process.env.VIBECHECK_QUESTION_API_URL || '';
const QUESTION_API_KEY = process.env.VIBECHECK_QUESTION_API_KEY || '';
const DEBUG_LLM_CONTEXT = process.env.VIBECHECK_DEBUG_LLM_CONTEXT === '1';
const DEBUG_QUESTION_API = process.env.VIBECHECK_DEBUG_QUESTION_API === '1';
const DEBUG_FLOW = process.env.VIBECHECK_DEBUG_FLOW === '1';

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
  if (DEBUG_FLOW) {
    console.log('[VibeCheck] Debug flow enabled');
    console.log(`[VibeCheck] cwd=${workspaceRoot}`);
    console.log(`[VibeCheck] staged diff chars=${diff.length}`);
    console.log(
      `[VibeCheck] QUESTION_API_URL=${QUESTION_API_URL || '<unset>'} | CHECKPOINT_PORT=${EXT_PORT}`
    );
  }

  const questions = await generateAstQuestions(workspaceRoot);
  if (DEBUG_FLOW) {
    console.log(`[VibeCheck] questions after generation=${Array.isArray(questions) ? questions.length : 0}`);
    const first = Array.isArray(questions) ? questions[0] : undefined;
    if (first && typeof first === 'object') {
      console.log(
        `[VibeCheck] first question preview question="${String(first.question ?? '').slice(0, 120)}" why="${String(first.whyThisMatters ?? '').slice(0, 120)}"`
      );
    }
  }
  const panelQuestions = sanitizeQuestionsForPanel(questions);
  const payload = {
    session_id: `pre-commit-${Date.now()}`,
    questions: panelQuestions,
    trigger: 'pre_commit',
    metadata: {
      backend: BACKEND,
      claude_md_present: Boolean(claudeMd.trim()),
      diff_lines: diff.split('\n').length,
      generated_questions: Array.isArray(questions) ? questions.length : 0,
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
async function generateAstQuestions(workspaceRoot) {
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
    const localQuestions = generateQuestionsFromGitDiff(workspaceRoot, { staged: true });
    const normalized = Array.isArray(localQuestions) ? localQuestions : [];
    if (DEBUG_LLM_CONTEXT) {
      logLlmContexts(normalized);
    }
    if (!QUESTION_API_URL) {
      if (DEBUG_FLOW) {
        console.warn('[VibeCheck] QUESTION_API_URL is unset; skipping backend question generation');
      }
      return normalized;
    }

    if (DEBUG_QUESTION_API) {
      console.log(`[VibeCheck] Question API enabled: ${QUESTION_API_URL}`);
    }
    const apiQuestions = await tryGenerateQuestionsViaApi({
      workspaceRoot,
      localQuestions: normalized,
      stagedDiff: safeExec('git diff --cached --no-color'),
    });
    if (DEBUG_QUESTION_API) {
      const source = Array.isArray(apiQuestions) && apiQuestions.length > 0 ? 'api' : 'local-fallback';
      console.log(`[VibeCheck] Question source selected: ${source}`);
    }
    return Array.isArray(apiQuestions) && apiQuestions.length > 0
      ? apiQuestions
      : normalized;
  } catch (error) {
    return [];
  }
}

function tryGenerateQuestionsViaApi({ workspaceRoot, localQuestions, stagedDiff }) {
  return new Promise((resolve) => {
    let parsedUrl;
    try {
      parsedUrl = new URL(QUESTION_API_URL);
    } catch {
      resolve(null);
      return;
    }

    const client = parsedUrl.protocol === 'https:' ? https : http;
    const body = JSON.stringify({
      workspaceRoot,
      stagedDiff,
      localQuestions,
    });
    if (DEBUG_FLOW) {
      console.log(
        `[VibeCheck] Calling question API with localQuestions=${localQuestions.length} stagedDiffChars=${stagedDiff.length}`
      );
    }
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    };
    if (QUESTION_API_KEY) {
      headers.Authorization = `Bearer ${QUESTION_API_KEY}`;
    }

    const req = client.request(
      {
        protocol: parsedUrl.protocol,
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: `${parsedUrl.pathname}${parsedUrl.search}`,
        method: 'POST',
        headers,
        timeout: 5000,
      },
      (res) => {
        let responseBody = '';
        res.on('data', (chunk) => {
          responseBody += chunk;
        });
        res.on('end', () => {
          if (DEBUG_FLOW) {
            console.log(
              `[VibeCheck] Question API HTTP ${res.statusCode ?? 500} response chars=${responseBody.length}`
            );
          }
          if ((res.statusCode ?? 500) < 200 || (res.statusCode ?? 500) >= 300) {
            if (DEBUG_QUESTION_API) {
              console.warn(
                `[VibeCheck] Question API fallback: HTTP ${res.statusCode ?? 500} body=${responseBody.slice(0, 300)}`
              );
            }
            resolve(null);
            return;
          }
          try {
            const parsed = JSON.parse(responseBody);
            if (Array.isArray(parsed)) {
              if (DEBUG_QUESTION_API) {
                console.log(`[VibeCheck] Question API returned array length=${parsed.length}`);
              }
              resolve(parsed);
              return;
            }
            if (Array.isArray(parsed?.questions)) {
              if (DEBUG_QUESTION_API) {
                console.log(
                  `[VibeCheck] Question API returned object.questions length=${parsed.questions.length}`
                );
              }
              resolve(parsed.questions);
              return;
            }
            if (DEBUG_QUESTION_API) {
              console.warn('[VibeCheck] Question API fallback: response JSON missing questions array');
            }
            resolve(null);
          } catch {
            if (DEBUG_QUESTION_API) {
              console.warn('[VibeCheck] Question API fallback: response is not valid JSON');
            }
            resolve(null);
          }
        });
      }
    );

    req.on('error', (error) => {
      if (DEBUG_QUESTION_API) {
        console.warn(`[VibeCheck] Question API fallback: request error ${error?.message ?? 'unknown'}`);
      }
      resolve(null);
    });
    req.on('timeout', () => {
      req.destroy();
      if (DEBUG_QUESTION_API) {
        console.warn('[VibeCheck] Question API fallback: request timeout');
      }
      resolve(null);
    });
    req.write(body);
    req.end();
  });
}

function sanitizeQuestionsForPanel(questions) {
  if (!Array.isArray(questions)) {
    return [];
  }
  return questions.map((question) => {
    const item = question ?? {};
    return {
      changedFunction: item.changedFunction ?? 'Unknown function',
      changedFunctionFile: item.changedFunctionFile ?? 'unknown file',
      calledBy: Array.isArray(item.calledBy) ? item.calledBy : [],
      estimatedImpact: item.estimatedImpact ?? 'Medium',
      question: typeof item.question === 'string' ? item.question : '',
      whyThisMatters: typeof item.whyThisMatters === 'string' ? item.whyThisMatters : '',
    };
  });
}

function logLlmContexts(questions) {
  console.log('[VibeCheck] Debug llmContext dump start');
  for (const question of questions) {
    if (!question || typeof question !== 'object') {
      continue;
    }
    const changedFunction = question.changedFunction || '<unknown>';
    const llmContext = question.llmContext || {};
    const beforeSource = typeof question.beforeSource === 'string' ? question.beforeSource : '';
    const afterSource = typeof question.afterSource === 'string' ? question.afterSource : '';
    try {
      console.log(
        `[VibeCheck] llmContext for ${changedFunction}: ${JSON.stringify(llmContext, null, 2)}`
      );
      console.log(
        `[VibeCheck] source diff preview for ${changedFunction}: before(${beforeSource.length})="${previewSource(beforeSource)}" | after(${afterSource.length})="${previewSource(afterSource)}"`
      );
    } catch {
      console.log(`[VibeCheck] llmContext for ${changedFunction}: <unserializable>`);
    }
  }
  console.log('[VibeCheck] Debug llmContext dump end');
}

function previewSource(value) {
  if (!value) {
    return '';
  }
  return value.replace(/\s+/g, ' ').trim().slice(0, 300);
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
