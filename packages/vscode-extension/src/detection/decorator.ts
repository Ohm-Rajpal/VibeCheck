import * as vscode from 'vscode';
import { regionTracker, AIRegion } from './regionTracker';

// Three styles so the engineer can see at a glance which AI-touched regions
// they still owe a checkpoint on.
let unverifiedDeco: vscode.TextEditorDecorationType;
let passedDeco: vscode.TextEditorDecorationType;
let overriddenDeco: vscode.TextEditorDecorationType;

export function activateDecorator(context: vscode.ExtensionContext) {
  unverifiedDeco = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'rgba(255, 200, 0, 0.10)',
    borderWidth: '0 0 0 2px',
    borderStyle: 'solid',
    borderColor: 'rgba(255, 200, 0, 0.7)',
    isWholeLine: true,
    overviewRulerColor: 'rgba(255, 200, 0, 0.7)',
    overviewRulerLane: vscode.OverviewRulerLane.Right,
    after: {
      contentText: '  🧠 AI — needs check',
      color: 'rgba(255, 200, 0, 0.6)',
      margin: '0 0 0 2em',
    },
  });

  passedDeco = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'rgba(74, 222, 128, 0.08)',
    borderWidth: '0 0 0 2px',
    borderStyle: 'solid',
    borderColor: 'rgba(74, 222, 128, 0.6)',
    isWholeLine: true,
    overviewRulerColor: 'rgba(74, 222, 128, 0.6)',
    overviewRulerLane: vscode.OverviewRulerLane.Right,
  });

  overriddenDeco = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'rgba(239, 68, 68, 0.08)',
    borderWidth: '0 0 0 2px',
    borderStyle: 'solid',
    borderColor: 'rgba(239, 68, 68, 0.6)',
    isWholeLine: true,
    overviewRulerColor: 'rgba(239, 68, 68, 0.6)',
    overviewRulerLane: vscode.OverviewRulerLane.Right,
  });

  context.subscriptions.push(
    unverifiedDeco,
    passedDeco,
    overriddenDeco,
    vscode.window.onDidChangeActiveTextEditor((ed) => ed && refresh(ed)),
    vscode.workspace.onDidOpenTextDocument(() => refreshAll()),
    regionTracker.onChange(() => refreshAll())
  );

  refreshAll();
}

function refreshAll() {
  for (const ed of vscode.window.visibleTextEditors) refresh(ed);
}

function refresh(editor: vscode.TextEditor) {
  const file = editor.document.fileName;
  const regions = regionTracker.getForFile(file);

  const ranges = (status: AIRegion['status']): vscode.Range[] =>
    regions
      .filter((r) => r.status === status)
      .map(
        (r) =>
          new vscode.Range(
            new vscode.Position(r.startLine, 0),
            new vscode.Position(r.endLine, Number.MAX_SAFE_INTEGER)
          )
      );

  editor.setDecorations(unverifiedDeco, ranges('unverified'));
  editor.setDecorations(passedDeco, ranges('passed'));
  editor.setDecorations(overriddenDeco, ranges('overridden'));
  // 'skipped' regions are intentionally NOT decorated — the tracker still
  // remembers them for analytics, but we don't paint anything in the editor.
}
