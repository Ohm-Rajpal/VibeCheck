import * as vscode from 'vscode';
import { openCheckpointPanel } from '../checkpoint/panel';

// Called by the local HTTP server when the backend forwards a Devin PR webhook.
export function handleDevinPRNotification(
  context: vscode.ExtensionContext,
  payload: { session_id: string; questions: unknown[]; pr_url: string }
) {
  vscode.window.showInformationMessage(
    `🤖 Devin opened a PR: ${payload.pr_url}. Review required.`
  );
  openCheckpointPanel(context, payload.session_id, payload.questions, 'devin_pr');
}
