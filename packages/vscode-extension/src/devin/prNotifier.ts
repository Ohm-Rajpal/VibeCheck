import * as vscode from 'vscode';
import { launchCheckpointForFirstUnverified } from '../checkpoint/launcher';

// Called by the local HTTP server when the backend forwards a Devin PR webhook.
// For now this just surfaces a toast and opens the next unverified region — the
// PR-specific question payload will be wired in once Layer 2B (PR-time
// classifier) is implemented.
export async function handleDevinPRNotification(
  context: vscode.ExtensionContext,
  payload: { session_id: string; questions: unknown[]; pr_url: string }
) {
  vscode.window.showInformationMessage(
    `🤖 Devin opened a PR: ${payload.pr_url}. Review required.`
  );
  await launchCheckpointForFirstUnverified(context, 'devin_pr');
}
