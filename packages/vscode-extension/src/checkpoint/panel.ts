import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as https from 'https';

export type CheckpointTrigger = 'velocity' | 'pre_commit' | 'devin_pr';

type PanelQuestion = {
  checkpointId?: string;
  changedFunction?: string;
  changedFunctionFile?: string;
  changedFunctionSource?: string;
  calledBy?: string[];
  estimatedImpact?: 'Low' | 'Medium' | 'Medium-High' | 'High';
  question?: string;
  whyThisMatters?: string;
  llmContext?: unknown;
};

let currentPanel: vscode.WebviewPanel | undefined;
let currentSessionId: string | undefined;
let currentQuestions: PanelQuestion[] = [];
let resolvedCheckpointIds = new Set<string>();

const BACKEND_URL = process.env.BACKEND_URL || 'http://127.0.0.1:8000';
const KNOWLEDGE_LOG_FILE =
  process.env.VIBECHECK_KNOWLEDGE_LOG_FILE || '.vibecheck-knowledge.jsonl';

export function openCheckpointPanel(
  context: vscode.ExtensionContext,
  sessionId: string,
  questions: unknown[],
  trigger: CheckpointTrigger
): vscode.WebviewPanel {
  currentSessionId = sessionId;
  currentQuestions = normalizeQuestions(questions);
  resolvedCheckpointIds = new Set<string>();

  if (currentPanel) {
    currentPanel.reveal(vscode.ViewColumn.Active, false);
  } else {
    currentPanel = vscode.window.createWebviewPanel(
      'vibecheckCheckpoint',
      'VibeCheck — Comprehension Check',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    currentPanel.onDidDispose(() => {
      currentPanel = undefined;
    });
    currentPanel.webview.onDidReceiveMessage((message) => {
      handlePanelMessage(message, context);
    });
  }

  currentPanel.webview.html = renderHtml(sessionId, currentQuestions, trigger);
  currentPanel.reveal(vscode.ViewColumn.Active, false);
  return currentPanel;
}

function renderHtml(
  sessionId: string,
  questions: PanelQuestion[],
  trigger: CheckpointTrigger
): string {
  const items = questions;
  const totalChanged = items.length;
  const impact = estimateOverallImpact(items);
  const cards = items
    .map((item, index) => renderQuestionCard(item, index))
    .join('\n');

  return `<!doctype html>
<html>
<body style="font-family:system-ui;padding:24px;color:#eee;background:#1e1e1e;line-height:1.45">
  <h1 style="margin-bottom:4px">VibeCheck Pre-Commit Checkpoint</h1>
  <p style="margin-top:0;color:#cfd8dc">Session: <code>${escapeHtml(sessionId)}</code></p>
  <p style="margin:4px 0 2px 0;font-size:16px;font-weight:600">We found ${totalChanged} changed function${totalChanged === 1 ? '' : 's'} that may affect your codebase.</p>
  <p style="margin:0 0 12px 0;color:#cfd8dc">Estimated impact: <strong>${impact}</strong></p>
  <div style="display:flex;gap:8px;margin-bottom:16px">
    <button id="passBtn" style="padding:8px 12px;background:#2e7d32;color:#fff;border:none;border-radius:6px;cursor:pointer">Mark Pass</button>
    <button id="failBtn" style="padding:8px 12px;background:#b71c1c;color:#fff;border:none;border-radius:6px;cursor:pointer">Mark Fail</button>
  </div>
  <p id="status" style="color:#ccc"></p>
  <div id="cards">${cards || '<p style="color:#ccc">No changed functions found in current staged diff.</p>'}</div>
  <h2 style="margin:18px 0 8px 0;font-size:16px;color:#cfd8dc">Completed</h2>
  <div id="completedCards" style="display:flex;flex-direction:column;gap:10px"></div>
  <script>
    const vscode = acquireVsCodeApi();
    const status = document.getElementById('status');
    function moveResolvedCardToBottom(checkpointId, statusText) {
      const card = document.querySelector('[data-question-card="' + checkpointId + '"]');
      const completed = document.getElementById('completedCards');
      if (card && completed) {
        card.style.opacity = '0.8';
        const controls = card.querySelector('[data-card-controls]');
        if (controls) controls.style.display = 'none';
        const badge = document.createElement('p');
        badge.style.margin = '0 0 8px 0';
        badge.style.color = '#a5d6a7';
        badge.style.fontWeight = '600';
        badge.textContent = 'Completed';
        const existing = card.querySelector('[data-completed-badge]');
        if (!existing) {
          badge.setAttribute('data-completed-badge', '1');
          card.insertBefore(badge, card.firstChild);
        }
        completed.appendChild(card);
      }
      if (statusText) status.textContent = statusText;
      const remaining = document.querySelectorAll('[data-question-card]');
      if (remaining.length === 0) {
        status.textContent = statusText || 'All questions handled.';
        return;
      }
      const next = remaining[0];
      next.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const answerBtn = next.querySelector('[data-action="answer"]');
      if (answerBtn) answerBtn.focus();
    }
    function toggleAnswerBox(checkpointId, visible) {
      const box = document.querySelector('[data-answer-box="' + checkpointId + '"]');
      if (!box) return;
      box.style.display = visible ? 'block' : 'none';
      if (!visible) return;
      const textarea = box.querySelector('textarea');
      if (textarea) textarea.focus();
    }
    document.getElementById('passBtn').addEventListener('click', () => {
      vscode.postMessage({ type: 'pass' });
      status.textContent = 'Sent PASS signal...';
    });
    document.getElementById('failBtn').addEventListener('click', () => {
      vscode.postMessage({ type: 'fail' });
      status.textContent = 'Sent FAIL signal...';
    });
    window.addEventListener('message', (event) => {
      const msg = event.data || {};
      if (msg.type !== 'explainResult') return;
      const node = document.querySelector('[data-explain-target="' + msg.checkpointId + '"]');
      if (!node) return;
      node.textContent = 'Explanation: ' + (msg.explanation || '') + ' | Follow-up: ' + (msg.followUp || '');
    });
    window.addEventListener('message', (event) => {
      const msg = event.data || {};
      if (msg.type !== 'answerResult') return;
      const card = document.querySelector('[data-question-card="' + msg.checkpointId + '"]');
      const scoreNode = card ? card.querySelector('[data-score-target]') : null;
      if (scoreNode) {
        scoreNode.textContent =
          'Score: ' + (msg.scorePercent || 0) + '% | ' + (msg.feedback || 'No feedback');
      }
      status.textContent = msg.statusText || '';
      setTimeout(() => {
        moveResolvedCardToBottom(msg.checkpointId, msg.statusText || '');
      }, 1400);
    });
    window.addEventListener('message', (event) => {
      const msg = event.data || {};
      if (msg.type !== 'skipResult') return;
      moveResolvedCardToBottom(msg.checkpointId, msg.statusText || '');
    });
    window.addEventListener('message', (event) => {
      const msg = event.data || {};
      if (msg.type !== 'explainResultDone') return;
      const card = document.querySelector('[data-question-card="' + msg.checkpointId + '"]');
      const scoreNode = card ? card.querySelector('[data-score-target]') : null;
      if (scoreNode) {
        scoreNode.textContent =
          'Follow-up score: ' + (msg.scorePercent || 0) + '% | ' + (msg.feedback || 'No feedback');
      }
      status.textContent = msg.statusText || '';
      setTimeout(() => {
        moveResolvedCardToBottom(msg.checkpointId, msg.statusText || '');
      }, 1400);
    });
    document.querySelectorAll('[data-action]').forEach((button) => {
      button.addEventListener('click', (event) => {
        const target = event.currentTarget;
        if (!target) return;
        const action = target.getAttribute('data-action');
        const changedFunction = target.getAttribute('data-function') || '';
        const checkpointId = target.getAttribute('data-checkpoint-id') || '';
        if (action === 'answer') {
          toggleAnswerBox(checkpointId, true);
          status.textContent = 'Provide your answer for ' + changedFunction + '.';
          return;
        }
        vscode.postMessage({ type: action, changedFunction, checkpointId });
        if (action === 'skip') status.textContent = 'Skipped ' + changedFunction + '.';
        if (action === 'explain') status.textContent = 'Explain request sent for ' + changedFunction + '.';
      });
    });
    document.querySelectorAll('[data-answer-submit]').forEach((button) => {
      button.addEventListener('click', (event) => {
        const target = event.currentTarget;
        if (!target) return;
        const checkpointId = target.getAttribute('data-answer-submit') || '';
        const changedFunction = target.getAttribute('data-function') || '';
        const box = document.querySelector('[data-answer-box="' + checkpointId + '"]');
        const textarea = box ? box.querySelector('textarea') : null;
        const answerText = textarea ? textarea.value.trim() : '';
        vscode.postMessage({ type: 'answer', changedFunction, checkpointId, answerText });
        status.textContent = 'Submitted answer for ' + changedFunction + '.';
      });
    });
    document.querySelectorAll('[data-answer-cancel]').forEach((button) => {
      button.addEventListener('click', (event) => {
        const target = event.currentTarget;
        if (!target) return;
        const checkpointId = target.getAttribute('data-answer-cancel') || '';
        toggleAnswerBox(checkpointId, false);
      });
    });
  </script>
</body>
</html>`;
}

async function handlePanelMessage(message: unknown, context: vscode.ExtensionContext) {
  const msg = (message ?? {}) as {
    type?: string;
    changedFunction?: string;
    checkpointId?: string;
    answerText?: string;
  };
  if (
    msg.type !== 'pass' &&
    msg.type !== 'fail' &&
    msg.type !== 'answer' &&
    msg.type !== 'skip' &&
    msg.type !== 'explain'
  ) {
    return;
  }
  const checkpointId = msg.checkpointId ?? '';
  const question = currentQuestions.find((item) => item.checkpointId === checkpointId);

  if (msg.type === 'answer') {
    if (!question) {
      vscode.window.showErrorMessage('VibeCheck: could not find question for answer action.');
      return;
    }
    const transcript = (msg.answerText || '').trim();
    if (!transcript) {
      vscode.window.showWarningMessage('VibeCheck: answer cannot be empty.');
      return;
    }
    try {
      const score = await verifyAnswer(question, transcript);
      logKnowledge(context, {
        sessionId: currentSessionId ?? 'unknown',
        checkpointId: question.checkpointId ?? checkpointId,
        changedFunction: question.changedFunction ?? 'unknown',
        mode: 'answer',
        transcript,
        overall: score.overall,
        passed: score.passed,
        feedback: score.feedback,
      });
      vscode.window.showInformationMessage(
        `VibeCheck: scored ${Math.round(score.overall * 100)}% (${score.passed ? 'pass' : 'needs work'}) for ${msg.changedFunction ?? 'function'}.`
      );
      markCheckpointResolved(question.checkpointId ?? checkpointId);
      currentPanel?.webview.postMessage({
        type: 'answerResult',
        checkpointId: question.checkpointId ?? checkpointId,
        statusText: `Answered ${msg.changedFunction ?? 'function'} (${Math.round(score.overall * 100)}%).`,
        scorePercent: Math.round(score.overall * 100),
        feedback: score.feedback,
      });
      maybeAutoPass();
    } catch (error) {
      const messageText = error instanceof Error ? error.message : 'unknown verification error';
      vscode.window.showErrorMessage(`VibeCheck: failed to verify answer: ${messageText}`);
    }
    return;
  }
  if (msg.type === 'skip') {
    vscode.window.showWarningMessage(
      `VibeCheck: skipped ${msg.changedFunction ?? 'function'}.`
    );
    if (question?.checkpointId) {
      markCheckpointResolved(question.checkpointId);
      currentPanel?.webview.postMessage({
        type: 'skipResult',
        checkpointId: question.checkpointId,
        statusText: `Skipped ${msg.changedFunction ?? 'function'}.`,
      });
      maybeAutoPass();
    }
    return;
  }
  if (msg.type === 'explain') {
    if (!question) {
      vscode.window.showErrorMessage('VibeCheck: could not find question for explain action.');
      return;
    }
    const explanation = buildExplanation(question);
    const followUp = buildSimplerFollowUp(question);
    currentPanel?.webview.postMessage({
      type: 'explainResult',
      checkpointId: question.checkpointId,
      explanation,
      followUp,
    });
    const followUpAnswer = await vscode.window.showInputBox({
      prompt: `Follow-up: ${followUp}`,
      placeHolder: 'Type a short answer to the simpler follow-up question.',
      ignoreFocusOut: true,
    });
    if (!followUpAnswer || !followUpAnswer.trim()) {
      vscode.window.showWarningMessage(
        `VibeCheck: follow-up unanswered for ${msg.changedFunction ?? 'function'}.`
      );
      return;
    }
    try {
      const score = await verifyAnswer(
        { ...question, question: followUp, whyThisMatters: explanation },
        followUpAnswer.trim()
      );
      logKnowledge(context, {
        sessionId: currentSessionId ?? 'unknown',
        checkpointId: question.checkpointId ?? checkpointId,
        changedFunction: question.changedFunction ?? 'unknown',
        mode: 'explain_follow_up',
        transcript: followUpAnswer.trim(),
        overall: score.overall,
        passed: score.passed,
        feedback: score.feedback,
      });
      vscode.window.showInformationMessage(
        `VibeCheck: follow-up captured for ${msg.changedFunction ?? 'function'} (${Math.round(score.overall * 100)}%).`
      );
      markCheckpointResolved(question.checkpointId ?? checkpointId);
      currentPanel?.webview.postMessage({
        type: 'explainResultDone',
        checkpointId: question.checkpointId ?? checkpointId,
        statusText: `Explained ${msg.changedFunction ?? 'function'} and captured follow-up.`,
        scorePercent: Math.round(score.overall * 100),
        feedback: score.feedback,
      });
      maybeAutoPass();
    } catch (error) {
      const messageText = error instanceof Error ? error.message : 'unknown verification error';
      vscode.window.showErrorMessage(`VibeCheck: failed to verify follow-up: ${messageText}`);
    }
    return;
  }

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    vscode.window.showErrorMessage('VibeCheck: open a workspace before signaling pre-commit pass/fail.');
    return;
  }

  const passFileName = process.env.PASS_FILE || '.vibecheck-pass.tmp';
  const failFileName = process.env.FAIL_FILE || '.vibecheck-fail.tmp';
  const passPath = path.join(workspaceRoot, passFileName);
  const failPath = path.join(workspaceRoot, failFileName);

  try {
    if (msg.type === 'pass') {
      fs.writeFileSync(passPath, `pass ${new Date().toISOString()}\n`, 'utf8');
      if (fs.existsSync(failPath)) {
        fs.unlinkSync(failPath);
      }
      vscode.window.showInformationMessage('VibeCheck: PASS signal created. Commit can continue.');
      return;
    }

    fs.writeFileSync(failPath, `fail ${new Date().toISOString()}\n`, 'utf8');
    if (fs.existsSync(passPath)) {
      fs.unlinkSync(passPath);
    }
    vscode.window.showWarningMessage('VibeCheck: FAIL signal created. Commit will be blocked.');
  } catch (error) {
    const messageText = error instanceof Error ? error.message : 'unknown file system error';
    vscode.window.showErrorMessage(`VibeCheck: failed to write signal file: ${messageText}`);
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeQuestions(questions: unknown[]): PanelQuestion[] {
  return questions.map((question, index) => {
    const item = (question ?? {}) as PanelQuestion;
    return {
      checkpointId: item.checkpointId ?? `cp-${index + 1}`,
      changedFunction: item.changedFunction ?? 'Unknown function',
      changedFunctionFile: item.changedFunctionFile ?? 'unknown file',
      changedFunctionSource: item.changedFunctionSource ?? '',
      calledBy: Array.isArray(item.calledBy) ? item.calledBy : [],
      estimatedImpact: item.estimatedImpact ?? 'Medium',
      question: typeof item.question === 'string' ? item.question : '',
      whyThisMatters: typeof item.whyThisMatters === 'string' ? item.whyThisMatters : '',
      llmContext: item.llmContext,
    };
  });
}

function estimateOverallImpact(items: PanelQuestion[]): string {
  if (items.some((item) => item.estimatedImpact === 'High')) {
    return 'High';
  }
  if (items.some((item) => item.estimatedImpact === 'Medium-High')) {
    return 'Medium-High';
  }
  if (items.some((item) => item.estimatedImpact === 'Medium')) {
    return 'Medium';
  }
  return 'Low';
}

function renderQuestionCard(item: PanelQuestion, index: number): string {
  const usedByLines = (item.calledBy ?? [])
    .slice(0, 5)
    .map((caller) => `<li><code>${escapeHtml(caller)}</code></li>`)
    .join('');

  const changedFunction = escapeHtml(item.changedFunction ?? 'Unknown function');
  const checkpointId = escapeHtml(item.checkpointId ?? `cp-${index + 1}`);
  return `
  <section data-question-card="${checkpointId}" style="border:1px solid #37474f;border-radius:8px;padding:14px;margin:0 0 14px 0;background:#222b31">
    <p style="margin:0 0 8px 0"><strong>Changed function:</strong> <code>${escapeHtml(item.changedFunction ?? 'Unknown function')}</code></p>
    <p style="margin:0 0 4px 0;color:#cfd8dc"><strong>Defined in:</strong> <code>${escapeHtml(item.changedFunctionFile ?? 'unknown file')}</code></p>
    <p style="margin:0 0 6px 0"><strong>Used by:</strong></p>
    <ul style="margin:0 0 10px 16px;padding:0">${usedByLines || '<li><em>No callers detected</em></li>'}</ul>
    <p style="margin:0 0 4px 0"><strong>Question:</strong> ${escapeHtml(item.question ?? '')}</p>
    <p style="margin:0 0 10px 0;color:#b0bec5"><strong>Why this matters:</strong> ${escapeHtml(item.whyThisMatters ?? '')}</p>
    <p data-score-target style="margin:0 0 10px 0;color:#a5d6a7"></p>
    <p data-explain-target="${checkpointId}" style="margin:0 0 10px 0;color:#90caf9"></p>
    <div data-answer-box="${checkpointId}" style="display:none;margin:0 0 10px 0">
      <textarea style="width:100%;min-height:72px;background:#1b242a;color:#fff;border:1px solid #455a64;border-radius:6px;padding:8px;" placeholder="Type your answer here..."></textarea>
      <div style="display:flex;gap:8px;margin-top:8px">
        <button data-answer-submit="${checkpointId}" data-function="${changedFunction}" style="padding:6px 10px;background:#00897b;color:#fff;border:none;border-radius:6px;cursor:pointer">Submit answer</button>
        <button data-answer-cancel="${checkpointId}" style="padding:6px 10px;background:#455a64;color:#fff;border:none;border-radius:6px;cursor:pointer">Cancel</button>
      </div>
    </div>
    <div data-card-controls style="display:flex;gap:8px;flex-wrap:wrap">
      <button data-action="answer" data-function="${changedFunction}" data-checkpoint-id="${checkpointId}" data-index="${index}" style="padding:6px 10px;background:#1565c0;color:#fff;border:none;border-radius:6px;cursor:pointer">Answer</button>
      <button data-action="skip" data-function="${changedFunction}" data-checkpoint-id="${checkpointId}" data-index="${index}" style="padding:6px 10px;background:#546e7a;color:#fff;border:none;border-radius:6px;cursor:pointer">Skip</button>
      <button data-action="explain" data-function="${changedFunction}" data-checkpoint-id="${checkpointId}" data-index="${index}" style="padding:6px 10px;background:#6a1b9a;color:#fff;border:none;border-radius:6px;cursor:pointer">Explain this code</button>
    </div>
  </section>`;
}

function markCheckpointResolved(checkpointId: string) {
  if (!checkpointId) {
    return;
  }
  resolvedCheckpointIds.add(checkpointId);
}

function maybeAutoPass() {
  if (!currentSessionId || currentQuestions.length === 0) {
    return;
  }
  if (resolvedCheckpointIds.size < currentQuestions.length) {
    return;
  }
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    return;
  }
  const passFileName = process.env.PASS_FILE || '.vibecheck-pass.tmp';
  const failFileName = process.env.FAIL_FILE || '.vibecheck-fail.tmp';
  const passPath = path.join(workspaceRoot, passFileName);
  const failPath = path.join(workspaceRoot, failFileName);
  fs.writeFileSync(passPath, `pass ${new Date().toISOString()}\n`, 'utf8');
  if (fs.existsSync(failPath)) {
    fs.unlinkSync(failPath);
  }
  vscode.window.showInformationMessage(
    'VibeCheck: all questions handled. PASS signal created automatically.'
  );
}

function buildExplanation(question: PanelQuestion): string {
  const fn = question.changedFunction ?? 'This function';
  const why = (question.whyThisMatters ?? '').trim();
  if (why) {
    return `${fn} matters because ${why}`;
  }
  return `${fn} was changed and may affect behavior in callers, so understanding the change reduces regressions before commit.`;
}

function buildSimplerFollowUp(question: PanelQuestion): string {
  const fn = question.changedFunction ?? 'this function';
  return `In one sentence, what is the most important behavior change in ${fn}?`;
}

type VerifyScore = {
  overall: number;
  passed: boolean;
  feedback: string;
};

function verifyAnswer(question: PanelQuestion, transcript: string): Promise<VerifyScore> {
  const diffExcerpt = resolveDiffExcerpt(question);
  return postJson<{ score?: VerifyScore }>(`${BACKEND_URL}/gate/verify`, {
    session_id: currentSessionId ?? 'pre-commit-ui',
    checkpoint_id: question.checkpointId ?? 'unknown',
    transcript,
    question: question.question ?? '',
    diff_excerpt: diffExcerpt,
    file: question.changedFunctionFile ?? 'unknown',
    llm_context: question.llmContext ?? null,
  }).then((payload) => {
    const score = payload?.score;
    if (!score) {
      throw new Error('verify response missing score');
    }
    return score;
  });
}

function resolveDiffExcerpt(question: PanelQuestion): string {
  const direct = (question.changedFunctionSource ?? '').trim();
  if (direct) {
    return direct;
  }

  const llmContext = question.llmContext as
    | { seed?: { diff?: string; snippet?: string } }
    | undefined;
  const seedDiff = llmContext?.seed?.diff?.trim() ?? '';
  if (seedDiff) {
    return seedDiff;
  }
  const seedSnippet = llmContext?.seed?.snippet?.trim() ?? '';
  if (seedSnippet) {
    return seedSnippet;
  }
  return 'No diff excerpt provided by analyzer.';
}

function postJson<T>(targetUrl: string, payload: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(targetUrl);
    } catch {
      reject(new Error(`invalid URL: ${targetUrl}`));
      return;
    }
    const client = parsed.protocol === 'https:' ? https : http;
    const body = JSON.stringify(payload);
    const req = client.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 50000,
      },
      (res) => {
        let responseBody = '';
        res.on('data', (chunk) => {
          responseBody += chunk;
        });
        res.on('end', () => {
          if ((res.statusCode ?? 500) < 200 || (res.statusCode ?? 500) >= 300) {
            reject(
              new Error(`HTTP ${res.statusCode ?? 500}: ${responseBody.slice(0, 400)}`)
            );
            return;
          }
          try {
            resolve(JSON.parse(responseBody) as T);
          } catch {
            reject(new Error('invalid JSON response'));
          }
        });
      }
    );
    req.on('error', (error) => reject(error));
    req.on('timeout', () => {
      req.destroy(new Error('request timeout'));
    });
    req.write(body);
    req.end();
  });
}

function logKnowledge(
  context: vscode.ExtensionContext,
  record: {
    sessionId: string;
    checkpointId: string;
    changedFunction: string;
    mode: 'answer' | 'explain_follow_up';
    transcript: string;
    overall: number;
    passed: boolean;
    feedback: string;
  }
) {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    return;
  }
  const filePath = path.join(workspaceRoot, KNOWLEDGE_LOG_FILE);
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    ...record,
  });
  fs.appendFileSync(filePath, `${line}\n`, 'utf8');
}
