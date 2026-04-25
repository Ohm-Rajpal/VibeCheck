// postMessage protocol between webview and extension host.

export type WebviewToExtension =
  | { type: 'PASS'; sessionId: string; checkpointId: string }
  | { type: 'OVERRIDE'; sessionId: string; reason: string }
  | { type: 'SUBMIT_TRANSCRIPT'; sessionId: string; checkpointId: string; transcript: string }
  | { type: 'CLOSE' };

export type ExtensionToWebview =
  | { type: 'INIT'; sessionId: string; questions: unknown[]; trigger: string }
  | { type: 'SCORE'; checkpointId: string; score: unknown };
