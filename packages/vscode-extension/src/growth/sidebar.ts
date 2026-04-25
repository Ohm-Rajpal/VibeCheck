import * as vscode from 'vscode';

class GrowthViewProvider implements vscode.WebviewViewProvider {
  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = { enableScripts: true };
    view.webview.html = `<!doctype html>
<html><body style="font-family:system-ui;padding:12px;color:#eee">
  <h3>📈 Growth</h3>
  <p><i>Dashboard not yet built.</i></p>
</body></html>`;
  }
}

export function activateGrowthSidebar(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'vibecheck.growth',
      new GrowthViewProvider()
    )
  );
}
