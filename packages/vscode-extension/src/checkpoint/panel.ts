import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { WebviewToExtension, ExtensionToWebview } from './messages';
import { regionTracker } from '../detection/regionTracker';

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
    currentPanel.webview.onDidReceiveMessage((msg: WebviewToExtension) => {
      handleMessage(msg);
    });
  }

  currentPanel.webview.html = renderHtml(context, sessionId, questions, trigger);
  return currentPanel;
}

function handleMessage(msg: WebviewToExtension): void {
  switch (msg.type) {
    case 'PASS':
      vscode.window.showInformationMessage(
        `✅ VibeCheck: marked ${msg.checkpointId} as understood.`
      );
      regionTracker.markStatus([msg.checkpointId], 'passed');
      break;

    case 'OVERRIDE':
      vscode.window.showWarningMessage(
        `⚠️ VibeCheck overridden: ${msg.reason}`
      );
      // TODO: log override to growth dashboard.
      break;

    case 'SUBMIT_TRANSCRIPT': {
      // TODO: forward to scoring backend (e.g. POST /score). Mocked for now.
      const score = mockScore(msg.transcript);
      const reply: ExtensionToWebview = {
        type: 'SCORE',
        checkpointId: msg.checkpointId,
        score,
      };
      // Small delay so the "Scoring…" state is visible.
      setTimeout(() => currentPanel?.webview.postMessage(reply), 700);
      break;
    }

    case 'CLOSE':
      currentPanel?.dispose();
      break;
  }
}

// Deterministic mock scorer: short answers fail, longer ones pass.
// Replace with a real call to the backend scoring endpoint.
function mockScore(transcript: string): { passed: boolean; value: number; feedback: string } {
  const words = transcript.trim().split(/\s+/).filter(Boolean).length;
  if (words < 8) {
    return {
      passed: false,
      value: Math.min(0.55, words / 16),
      feedback:
        'Your explanation is too short to verify comprehension. Try walking through the data flow step by step.',
    };
  }
  const value = Math.min(0.95, 0.6 + words / 80);
  return {
    passed: true,
    value,
    feedback:
      'Good explanation — the key concepts are covered. The region will be marked verified.',
  };
}

function renderHtml(
  context: vscode.ExtensionContext,
  sessionId: string,
  questions: unknown[],
  trigger: CheckpointTrigger
): string {
  const distPath = path.join(
    context.extensionPath,
    'webview',
    'dist',
    'index.html'
  );

  let html: string;
  try {
    html = fs.readFileSync(distPath, 'utf8');
  } catch {
    return fallbackHtml(sessionId, questions, trigger);
  }

  // Encode the init payload safely for inline JSON in HTML.
  const initJson = JSON.stringify({ sessionId, questions, trigger })
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');

  const inject = `<script>
  window.__VIBECHECK_VIEW__ = 'checkpoint';
  window.__VIBECHECK_INIT__ = ${initJson};
</script>`;

  // Insert the init script just before </head> so it runs before the bundle.
  if (html.includes('</head>')) {
    return html.replace('</head>', `${inject}</head>`);
  }
  // Fallback: prepend if no <head> tag.
  return inject + html;
}

function fallbackHtml(
  sessionId: string,
  questions: unknown[],
  trigger: CheckpointTrigger
): string {
  return `<!doctype html>
<html><body style="font-family:system-ui;padding:24px;color:#eee;background:#1e1e1e">
  <h2>🧠 VibeCheck — ${trigger}</h2>
  <p>Session: <code>${sessionId}</code></p>
  <pre>${escapeHtml(JSON.stringify(questions, null, 2))}</pre>
  <p><i>Webview bundle not built. Run <code>npm run build:webview</code> from the repo root.</i></p>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
