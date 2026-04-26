import * as vscode from 'vscode';
import { regionTracker } from '../detection/regionTracker';
import { recordEvent } from '../metrics/recorder';
import { CheckpointPayload } from './panel';

const BACKEND_URL = process.env.VIBECHECK_BACKEND_URL ?? 'http://localhost:8000';

interface VerifyScore {
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

/**
 * Native-VSCode comprehension flow — no webviews. Used as the default path
 * because webviews are flaky over Remote SSH on certain VSCode versions
 * (the InvalidStateError service-worker bug). Same protocol as the webview
 * path: pre-fetched question in, regionTracker status update out.
 *
 * UX is a sequence of native VSCode prompts:
 *   1. Modal info dialog with the question + code excerpt + Answer/Override.
 *   2. InputBox for the typed answer (single line, but VSCode allows long
 *      strings so it works in practice for ~1-2 sentence answers).
 *   3. Progress notification while we POST to /gate/verify.
 *   4. Result dialog: pass → mark region green and toast; fail → offer
 *      retry / override / cancel.
 */
export async function runNativeCheckpoint(payload: CheckpointPayload): Promise<void> {
  const location = `${payload.fileShort}:${payload.startLine + 1}-${payload.endLine + 1}`;

  const choice = await vscode.window.showInformationMessage(
    `🧠 VibeCheck (${payload.conceptTag}) — ${location}\n\n${payload.question}`,
    {
      modal: true,
      // `detail` shows in a smaller font under the main message. Perfect
      // place to surface the AI-generated code so the user can re-read it
      // before answering.
      detail: payload.code,
    },
    'Answer',
    'Skip',
    'Override'
  );

  if (choice === 'Skip') {
    void recordEvent('checkpoint_dismissed', {
      region_id: payload.regionId,
      source: 'native_skip',
    });
    return;
  }

  if (choice === 'Override') {
    regionTracker.markStatus([payload.regionId], 'overridden');
    void recordEvent('checkpoint_overridden', {
      region_id: payload.regionId,
      source: 'native_override',
    });
    vscode.window.showWarningMessage(
      `VibeCheck: ${location} marked as overridden without verification.`
    );
    return;
  }
  if (choice !== 'Answer') {
    // Modal dismissed (Esc or X). Leave the region unverified — user can
    // re-trigger via the status bar.
    return;
  }

  const answer = await vscode.window.showInputBox({
    title: `VibeCheck — ${payload.conceptTag}`,
    prompt: payload.question,
    placeHolder: 'Why this approach? What edge case does it handle? What would break if you removed X?',
    ignoreFocusOut: true,
    validateInput: (val) =>
      val.trim().length < 10
        ? 'Type a real explanation (at least ~10 characters).'
        : null,
  });

  if (answer === undefined) {
    // User pressed Esc — no-op, region stays unverified.
    return;
  }

  let score: VerifyScore;
  try {
    score = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'VibeCheck: grading with Gemma…',
        cancellable: false,
      },
      async () => {
        const res = await fetch(`${BACKEND_URL}/gate/verify`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            session_id: payload.sessionId,
            checkpoint_id: payload.regionId,
            transcript: answer,
            file: payload.fileShort,
            diff_excerpt: payload.code,
          }),
        });
        if (!res.ok) {
          throw new Error(`verify failed (${res.status}): ${await res.text()}`);
        }
        const json = (await res.json()) as { score: VerifyScore };
        return json.score;
      }
    );
  } catch (err) {
    vscode.window.showErrorMessage(
      `VibeCheck: ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }

  await showResult(payload, score);
}

async function showResult(payload: CheckpointPayload, score: VerifyScore): Promise<void> {
  const fmt = (n: number) => (typeof n === 'number' ? n.toFixed(2) : '—');
  const scoreLine = `What it does ${fmt(score.what_it_does)} · Why ${fmt(
    score.why_this_approach
  )} · Tradeoffs ${fmt(score.tradeoffs)} · Overall ${fmt(score.overall)}`;

  if (score.passed) {
    regionTracker.markStatus([payload.regionId], 'passed');
    vscode.window.showInformationMessage(
      `✓ VibeCheck passed (${fmt(score.overall)}). ${score.feedback}`,
      { modal: false }
    );
    return;
  }

  // Failed — give the user the feedback + follow-up + a way out.
  const followUp = score.follow_up_question
    ? `\n\nFollow-up: ${score.follow_up_question}`
    : '';
  const retry = await vscode.window.showWarningMessage(
    `✗ Not quite (${fmt(score.overall)})\n\n${score.feedback}${followUp}`,
    { modal: true, detail: scoreLine },
    'Try again',
    'Override anyway'
  );

  if (retry === 'Try again') {
    // Recurse with the SAME payload so the same question is re-asked.
    await runNativeCheckpoint(payload);
  } else if (retry === 'Override anyway') {
    regionTracker.markStatus([payload.regionId], 'overridden');
    void recordEvent('checkpoint_overridden', {
      region_id: payload.regionId,
      source: 'native_failed_override',
    });
    vscode.window.showWarningMessage(
      `VibeCheck: region marked as overridden after failed check.`
    );
  }
  // Else: user dismissed → region stays unverified, can be retried later.
}
