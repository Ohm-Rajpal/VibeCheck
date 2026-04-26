import * as vscode from 'vscode';
import { AIRegion, regionTracker } from '../detection/regionTracker';
import {
  attachQuestion,
  createCheckpointThread,
  createPendingCheckpointThread,
} from './commentThreads';
import { runNativeCheckpoint } from './nativeUi';
import {
  CheckpointPayload,
  CheckpointTrigger,
  openCheckpointPanel,
} from './panel';

const BACKEND_URL = process.env.VIBECHECK_BACKEND_URL ?? 'http://localhost:8000';

const LANG_BY_EXT: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  rb: 'ruby',
  cs: 'csharp',
  cpp: 'cpp',
  cc: 'cpp',
  c: 'c',
  h: 'c',
  swift: 'swift',
  php: 'php',
};

function inferLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  return LANG_BY_EXT[ext] ?? 'unknown';
}

function basename(filePath: string): string {
  return filePath.split('/').pop() ?? filePath;
}

interface QuestionResponse {
  checkpoint_id: string;
  question: string;
  concept_tag: string;
  code_context: string;
  file: string;
  diff_excerpt: string;
}

// Fetch a Gemma-generated question for one region. Falls back to a generic
// question if the backend is unreachable, so the demo never deadlocks on
// network errors.
async function fetchQuestion(
  region: AIRegion,
  sessionId: string
): Promise<{ question: string; conceptTag: string }> {
  try {
    const res = await fetch(`${BACKEND_URL}/gate/question`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        session_id: sessionId,
        checkpoint_id: region.id,
        code: region.text,
        file: basename(region.file),
        language: inferLanguage(region.file),
        start_line: region.startLine,
        end_line: region.endLine,
      }),
    });
    if (!res.ok) {
      throw new Error(`question failed (${res.status})`);
    }
    const json = (await res.json()) as QuestionResponse;
    return {
      question: json.question,
      conceptTag: json.concept_tag || 'design choice',
    };
  } catch (err) {
    return {
      question: `In ${basename(region.file)}:${region.startLine + 1}-${
        region.endLine + 1
      }, why this approach instead of an obvious alternative? Name one edge case the code handles. (offline fallback — backend unreachable: ${
        err instanceof Error ? err.message : String(err)
      })`,
      conceptTag: 'design choice',
    };
  }
}

/**
 * High-level helper used by toast / status bar / HTTP /checkpoint route.
 * Picks one region, fetches a question for it, and runs the comprehension
 * check.
 *
 * The user can choose between three UIs (set `vibecheck.checkpointUi`):
 *   - "comments" (DEFAULT) — inline GitHub-PR-style comment thread
 *     anchored to the AI region. Native VSCode chrome, multi-line replies,
 *     auto-resolves on pass. Best UX, recommended for demos.
 *   - "native"  — sequence of VSCode info dialogs + InputBox. Looks like
 *     a system error dialog. Use only if comments threads aren't working.
 *   - "webview" — rich HTML panel. Prettiest in theory but flaky on some
 *     VSCode Remote setups (InvalidStateError service-worker bug).
 */
export async function launchCheckpointForRegion(
  context: vscode.ExtensionContext,
  region: AIRegion,
  trigger: CheckpointTrigger,
  sessionId: string = region.burstId
): Promise<void> {
  const ui = vscode.workspace
    .getConfiguration('vibecheck')
    .get<string>('checkpointUi', 'comments');

  // ── Comments mode: OPTIMISTIC. Open the thread instantly with a
  // "generating…" placeholder, then fetch the real question in the
  // background and patch it in. User sees the panel < 50ms instead of
  // waiting on Gemma.
  if (ui === 'comments') {
    await createPendingCheckpointThread({
      regionId: region.id,
      sessionId,
      file: region.file,
      startLine: region.startLine,
      endLine: region.endLine,
      code: region.text,
    });
    // Fire and forget — when the question lands, splice it into the seed.
    fetchQuestion(region, sessionId)
      .then(({ question, conceptTag }) => {
        attachQuestion(region.id, question, conceptTag);
      })
      .catch((err) => {
        console.warn('[VibeCheck] question fetch failed:', err);
        attachQuestion(
          region.id,
          `In ${basename(region.file)}, why this approach? Name one edge case it handles. (offline)`,
          'design choice'
        );
      });
    return;
  }

  // ── Native + webview modes: BLOCKING (they can't render without the
  // question). Keep the original synchronous flow.
  const { question, conceptTag } = await fetchQuestion(region, sessionId);
  const payload: CheckpointPayload = {
    regionId: region.id,
    sessionId,
    file: region.file,
    fileShort: basename(region.file),
    startLine: region.startLine,
    endLine: region.endLine,
    language: inferLanguage(region.file),
    code: region.text,
    question,
    conceptTag,
    trigger,
  };

  if (ui === 'webview') {
    await openCheckpointPanel(context, payload);
  } else {
    await runNativeCheckpoint(payload);
  }
}

/**
 * Open a checkpoint for the FIRST unverified region in the workspace.
 * Used by the status bar click + manual command. No-op (with a friendly
 * info message) if nothing is unverified.
 */
export async function launchCheckpointForFirstUnverified(
  context: vscode.ExtensionContext,
  trigger: CheckpointTrigger
): Promise<void> {
  const unverified = regionTracker.getUnverified();
  if (unverified.length === 0) {
    vscode.window.showInformationMessage(
      'VibeCheck: nothing to check — no unverified AI regions.'
    );
    return;
  }
  await launchCheckpointForRegion(
    context,
    unverified[0],
    trigger,
    `manual-${Date.now()}`
  );
}
