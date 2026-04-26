import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { regionTracker } from '../detection/regionTracker';
import { recordEvent } from '../metrics/recorder';
import { WebviewToExtension, ExtensionToWebview } from './messages';

export type CheckpointTrigger = 'velocity' | 'pre_commit' | 'devin_pr' | 'manual';

const BACKEND_URL = process.env.VIBECHECK_BACKEND_URL ?? 'http://localhost:8000';

export interface CheckpointPayload {
  regionId: string;        // regionTracker AIRegion.id
  sessionId: string;       // burstId or 'manual-<ts>'
  file: string;            // absolute path
  fileShort: string;       // basename for display
  startLine: number;       // 0-indexed
  endLine: number;         // 0-indexed, inclusive
  language: string;        // e.g., 'typescript', 'python', or 'unknown'
  code: string;            // region body (already trimmed)
  question: string;        // pre-fetched from /gate/question
  conceptTag: string;      // e.g., 'memoization', 'design choice'
  trigger: CheckpointTrigger;
}

let currentPanel: vscode.WebviewPanel | undefined;
let currentPayload: CheckpointPayload | undefined;

export async function openCheckpointPanel(
  context: vscode.ExtensionContext,
  payload: CheckpointPayload
): Promise<vscode.WebviewPanel> {
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
      currentPayload = undefined;
    });
    currentPanel.webview.onDidReceiveMessage(async (msg: WebviewToExtension) => {
      const panel = currentPanel;
      const payload = currentPayload;
      if (!panel || !payload) return;
      try {
        await handleMessage(panel, payload, msg);
      } catch (err) {
        const reply: ExtensionToWebview = {
          type: 'SCORE',
          checkpointId: payload.regionId,
          score: {
            passed: false,
            value: 0,
            feedback: err instanceof Error ? err.message : String(err),
          },
        };
        panel.webview.postMessage(reply);
      }
    });
  }

  currentPayload = payload;
  currentPanel.title = `VibeCheck — ${payload.fileShort}:${payload.startLine + 1}-${
    payload.endLine + 1
  }`;
  currentPanel.webview.html = renderHtml(context, payload);
  return currentPanel;
}

async function handleMessage(
  panel: vscode.WebviewPanel,
  payload: CheckpointPayload,
  msg: WebviewToExtension
): Promise<void> {
  switch (msg.type) {
    case 'PASS':
      regionTracker.markStatus([payload.regionId], 'passed');
      vscode.window.showInformationMessage(
        `✅ VibeCheck: marked ${msg.checkpointId} as understood.`
      );
      break;

    case 'OVERRIDE':
      regionTracker.markStatus([payload.regionId], 'overridden');
      void recordEvent('checkpoint_overridden', {
        region_id: payload.regionId,
        source: 'webview_override',
        reason: msg.reason,
      });
      vscode.window.showWarningMessage(
        `⚠️ VibeCheck overridden: ${msg.reason}`
      );
      panel.dispose();
      break;

    case 'SUBMIT_TRANSCRIPT':
      await handleSubmit(panel, payload, msg.checkpointId, msg.transcript);
      break;

    case 'CLOSE':
      currentPanel?.dispose();
      break;
  }
}

async function handleSubmit(
  panel: vscode.WebviewPanel,
  payload: CheckpointPayload,
  checkpointId: string,
  transcript: string
): Promise<void> {
  const text = transcript.trim();
  if (!text) {
    const reply: ExtensionToWebview = {
      type: 'SCORE',
      checkpointId,
      score: {
        passed: false,
        value: 0,
        feedback: 'Type a few sentences explaining the design choice.',
      },
    };
    panel.webview.postMessage(reply);
    return;
  }

  void recordEvent('answer_submitted', {
    region_id: payload.regionId,
    source: 'webview',
    char_count: text.length,
  });

  const res = await fetch(`${BACKEND_URL}/gate/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      session_id: payload.sessionId,
      checkpoint_id: payload.regionId,
      transcript: text,
      file: payload.fileShort,
      diff_excerpt: payload.code,
    }),
  });
  if (!res.ok) {
    throw new Error(`verify failed (${res.status}): ${await res.text()}`);
  }
  const json = (await res.json()) as { score: VerifyScorePayload };
  const reply: ExtensionToWebview = {
    type: 'SCORE',
    checkpointId,
    score: json.score,
  };
  panel.webview.postMessage(reply);
  if (json.score.passed) {
    regionTracker.markStatus([payload.regionId], 'passed');
    void recordEvent('answer_passed', {
      region_id: payload.regionId,
      source: 'webview',
      overall: json.score.overall,
    });
  }
}

interface VerifyScorePayload {
  what_it_does: number;
  why_this_approach: number;
  tradeoffs: number;
  overall: number;
  passed: boolean;
  feedback: string;
  follow_up_question: string | null;
  concepts_weak: string[];
  concepts_strong: string[];
  spoken_response: string;
}

function renderHtml(
  context: vscode.ExtensionContext,
  payload: CheckpointPayload
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
    return fallbackHtml(payload);
  }

  const questions = [
    {
      question: payload.question,
      concept_tag: payload.conceptTag,
      code_context: `${payload.fileShort}:${payload.startLine + 1}-${payload.endLine + 1}`,
      file: payload.fileShort,
      checkpoint_id: payload.regionId,
    },
  ];
  const initJson = JSON.stringify({
    sessionId: payload.sessionId,
    questions,
    trigger: payload.trigger,
  })
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

function fallbackHtml(payload: CheckpointPayload): string {
  const location = `${payload.fileShort}:${payload.startLine + 1}-${payload.endLine + 1}`;
  return `<!doctype html>
<html><body style="font-family:system-ui;padding:24px;color:#eee;background:#1e1e1e">
  <h2>🧠 VibeCheck — ${escapeHtml(payload.trigger)}</h2>
  <p>Session: <code>${escapeHtml(payload.sessionId)}</code></p>
  <p><strong>${escapeHtml(location)}</strong></p>
  <p>${escapeHtml(payload.question)}</p>
  <pre>${escapeHtml(payload.code)}</pre>
  <p><i>Webview bundle not built. Run <code>npm run build:webview</code> from the repo root.</i></p>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
