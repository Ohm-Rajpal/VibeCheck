import * as vscode from 'vscode';

const AI_LINE_THRESHOLD = 8;
const AI_TIME_THRESHOLD_MS = 250;

interface PendingChange {
  file: string;
  lines: string;
  content: string;
  timestamp: number;
  answered: boolean;
}

let lastChangeTime = Date.now();
const pendingChanges: PendingChange[] = [];

export function activateVelocityDetector(context: vscode.ExtensionContext) {
  const sub = vscode.workspace.onDidChangeTextDocument(async (event) => {
    const change = event.contentChanges[0];
    if (!change) return;

    const linesAdded = change.text.split('\n').length;
    const elapsed = Date.now() - lastChangeTime;
    const isAIBurst =
      linesAdded > AI_LINE_THRESHOLD && elapsed < AI_TIME_THRESHOLD_MS;

    lastChangeTime = Date.now();
    if (!isAIBurst) return;

    pendingChanges.push({
      file: event.document.fileName,
      lines: `${change.range.start.line}-${change.range.end.line}`,
      content: change.text,
      timestamp: Date.now(),
      answered: false,
    });

    // TODO: call backend /gate/generate (mode=inline) and show toast.
    vscode.window.showInformationMessage(
      `🧠 VibeCheck: AI just wrote ${linesAdded} lines. Quick check?`,
      'Answer Now',
      'Skip'
    );
  });

  context.subscriptions.push(sub);
}

export function getPendingChanges(): PendingChange[] {
  return pendingChanges;
}
