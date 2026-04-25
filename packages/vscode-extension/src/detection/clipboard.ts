import * as vscode from 'vscode';

// Snapshot of the most recently observed clipboard contents. We keep this
// in-memory so paste detection is O(1) and doesn't await on every keystroke.
let lastClipboard = '';

export async function refreshClipboardSnapshot(): Promise<void> {
  try {
    lastClipboard = (await vscode.env.clipboard.readText()) ?? '';
  } catch {
    lastClipboard = '';
  }
}

// Returns true if the inserted text matches the current clipboard contents,
// strongly suggesting a human paste rather than an AI generation.
export function looksLikePaste(insertedText: string): boolean {
  if (!insertedText || !lastClipboard) return false;
  // Exact match — most pastes preserve content verbatim.
  if (insertedText === lastClipboard) return true;
  // Trimmed match — editors sometimes strip trailing whitespace.
  if (insertedText.trim() === lastClipboard.trim()) return true;
  return false;
}
