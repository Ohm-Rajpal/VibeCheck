import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export type CheckpointTrigger = 'velocity' | 'pre_commit' | 'devin_pr';

type PanelQuestion = {
  changedFunction?: string;
  changedFunctionFile?: string;
  changedFunctionSource?: string;
  calledBy?: string[];
  estimatedImpact?: 'Low' | 'Medium' | 'Medium-High' | 'High';
  question?: string;
  whyThisMatters?: string;
};

let currentPanel: vscode.WebviewPanel | undefined;

export function openCheckpointPanel(
  context: vscode.ExtensionContext,
  sessionId: string,
  questions: unknown[],
  trigger: CheckpointTrigger
): vscode.WebviewPanel {
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
      handlePanelMessage(message);
    });
  }

  currentPanel.webview.html = renderHtml(sessionId, questions, trigger);
  currentPanel.reveal(vscode.ViewColumn.Active, false);
  return currentPanel;
}

function renderHtml(
  sessionId: string,
  questions: unknown[],
  trigger: CheckpointTrigger
): string {
  const items = normalizeQuestions(questions);
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
  <script>
    const vscode = acquireVsCodeApi();
    const status = document.getElementById('status');
    document.getElementById('passBtn').addEventListener('click', () => {
      vscode.postMessage({ type: 'pass' });
      status.textContent = 'Sent PASS signal...';
    });
    document.getElementById('failBtn').addEventListener('click', () => {
      vscode.postMessage({ type: 'fail' });
      status.textContent = 'Sent FAIL signal...';
    });
    document.querySelectorAll('[data-action]').forEach((button) => {
      button.addEventListener('click', (event) => {
        const target = event.currentTarget;
        if (!target) return;
        const action = target.getAttribute('data-action');
        const changedFunction = target.getAttribute('data-function') || '';
        vscode.postMessage({ type: action, changedFunction });
        if (action === 'answer') status.textContent = 'Marked ' + changedFunction + ' for answer.';
        if (action === 'skip') status.textContent = 'Skipped ' + changedFunction + '.';
        if (action === 'explain') status.textContent = 'Explain request sent for ' + changedFunction + '.';
      });
    });
  </script>
</body>
</html>`;
}

function handlePanelMessage(message: unknown) {
  const msg = (message ?? {}) as { type?: string; changedFunction?: string };
  if (
    msg.type !== 'pass' &&
    msg.type !== 'fail' &&
    msg.type !== 'answer' &&
    msg.type !== 'skip' &&
    msg.type !== 'explain'
  ) {
    return;
  }
  if (msg.type === 'answer') {
    vscode.window.showInformationMessage(
      `VibeCheck: answer selected for ${msg.changedFunction ?? 'function'}.`
    );
    return;
  }
  if (msg.type === 'skip') {
    vscode.window.showWarningMessage(
      `VibeCheck: skipped ${msg.changedFunction ?? 'function'}.`
    );
    return;
  }
  if (msg.type === 'explain') {
    vscode.window.showInformationMessage(
      `VibeCheck: explain requested for ${msg.changedFunction ?? 'function'}.`
    );
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
  return questions.map((question) => {
    const item = (question ?? {}) as PanelQuestion;
    return {
      changedFunction: item.changedFunction ?? 'Unknown function',
      changedFunctionFile: item.changedFunctionFile ?? 'unknown file',
      changedFunctionSource: item.changedFunctionSource ?? '',
      calledBy: Array.isArray(item.calledBy) ? item.calledBy : [],
      estimatedImpact: item.estimatedImpact ?? 'Medium',
      question: typeof item.question === 'string' ? item.question : '',
      whyThisMatters: typeof item.whyThisMatters === 'string' ? item.whyThisMatters : '',
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
  return `
  <section style="border:1px solid #37474f;border-radius:8px;padding:14px;margin:0 0 14px 0;background:#222b31">
    <p style="margin:0 0 8px 0"><strong>Changed function:</strong> <code>${escapeHtml(item.changedFunction ?? 'Unknown function')}</code></p>
    <p style="margin:0 0 4px 0;color:#cfd8dc"><strong>Defined in:</strong> <code>${escapeHtml(item.changedFunctionFile ?? 'unknown file')}</code></p>
    <p style="margin:0 0 6px 0"><strong>Used by:</strong></p>
    <ul style="margin:0 0 10px 16px;padding:0">${usedByLines || '<li><em>No callers detected</em></li>'}</ul>
    <p style="margin:0 0 4px 0"><strong>Question:</strong> ${escapeHtml(item.question ?? '')}</p>
    <p style="margin:0 0 10px 0;color:#b0bec5"><strong>Why this matters:</strong> ${escapeHtml(item.whyThisMatters ?? '')}</p>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button data-action="answer" data-function="${changedFunction}" data-index="${index}" style="padding:6px 10px;background:#1565c0;color:#fff;border:none;border-radius:6px;cursor:pointer">Answer</button>
      <button data-action="skip" data-function="${changedFunction}" data-index="${index}" style="padding:6px 10px;background:#546e7a;color:#fff;border:none;border-radius:6px;cursor:pointer">Skip</button>
      <button data-action="explain" data-function="${changedFunction}" data-index="${index}" style="padding:6px 10px;background:#6a1b9a;color:#fff;border:none;border-radius:6px;cursor:pointer">Explain this code</button>
    </div>
  </section>`;
}
