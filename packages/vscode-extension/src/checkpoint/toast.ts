import * as vscode from 'vscode';

// Non-blocking Layer 1 toast. Returns user choice or undefined if dismissed.
export async function showVelocityToast(
  linesAdded: number
): Promise<'answer' | 'skip' | undefined> {
  const choice = await vscode.window.showInformationMessage(
    `🧠 VibeCheck: AI just wrote ${linesAdded} lines. Quick check?`,
    'Answer Now',
    'Skip'
  );
  if (choice === 'Answer Now') return 'answer';
  if (choice === 'Skip') return 'skip';
  return undefined;
}
