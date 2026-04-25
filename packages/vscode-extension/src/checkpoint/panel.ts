import * as vscode from 'vscode';

export type CheckpointTrigger = 'velocity' | 'pre_commit' | 'devin_pr';

let currentPanel: vscode.WebviewPanel | undefined;

export function openCheckpointPanel(
  context: vscode.ExtensionContext,
  sessionId: string,
  questions: unknown[],
  trigger: CheckpointTrigger
): vscode.WebviewPanel {
  if (currentPanel) {
    currentPanel.reveal(vscode.ViewColumn.Beside);
  } else {
    currentPanel = vscode.window.createWebviewPanel(
      'vibecheckCheckpoint',
      'VibeCheck — Comprehension Check',
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    currentPanel.onDidDispose(() => {
      currentPanel = undefined;
    });
  }

  currentPanel.webview.html = renderHtml(sessionId, questions, trigger);
  // TODO: wire postMessage handlers (PASS / OVERRIDE / SUBMIT_TRANSCRIPT).
  return currentPanel;
}

function renderHtml(
  sessionId: string,
  questions: unknown[],
  trigger: CheckpointTrigger
): string {
  // TODO: replace with built webview bundle from webview/dist.
  return `<!doctype html>
<html><body style="font-family:system-ui;padding:24px;color:#eee;background:#1e1e1e">
  <h2>🧠 VibeCheck — ${trigger}</h2>
  <p>Session: <code>${sessionId}</code></p>
  <pre>${JSON.stringify(questions, null, 2)}</pre>
  <p><i>Webview UI not yet built.</i></p>
</body></html>`;
}
