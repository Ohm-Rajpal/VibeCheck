import * as vscode from 'vscode';
import { regionTracker } from '../detection/regionTracker';
import { recordEvent } from '../metrics/recorder';

const BACKEND_URL = process.env.VIBECHECK_BACKEND_URL ?? 'http://localhost:8000';

/**
 * Comment-thread integration. Each AI-authored region gets attached as an
 * inline comment thread anchored to its line range. The thread looks and
 * behaves exactly like a GitHub PR review comment:
 *   - Seed comment from "VibeCheck" containing the Gemma question.
 *   - User types in the reply box and clicks "Submit answer".
 *   - Their reply is posted as a comment.
 *   - We POST to /gate/verify and replace a transient "grading…" comment
 *     with a graded reply (markdown table of scores + feedback).
 *   - On pass: thread state flips to Resolved, region marked passed,
 *     thread auto-collapses.
 *   - On fail: thread stays open; user can edit/resubmit. Override button
 *     in the reply menu marks the region overridden.
 *
 * This lives BESIDE the modal and webview UIs — the launcher picks one
 * via `vibecheck.checkpointUi` setting. Comment threads are the default.
 */

interface ThreadMeta {
  regionId: string;
  sessionId: string;
  question: string;
  conceptTag: string;
  code: string;
  fileShort: string;
  // Incremented on every Submit. A pass with attempt === 1 counts
  // toward the "first-try pass rate" metric.
  attempt: number;
  // 'comprehension' (default) → Submit posts the user's reply for grading.
  // 'override'              → user clicked Override; the question comment
  //                            has been swapped in-place for an override
  //                            prompt, and Submit will instead delete the
  //                            AI-authored snippet and forward the reply
  //                            to Cascade as the next prompt.
  mode: 'comprehension' | 'override';
}

let controller: vscode.CommentController | undefined;
const threadsByRegion = new Map<string, vscode.CommentThread>();
const metaByThread = new WeakMap<vscode.CommentThread, ThreadMeta>();
let mostRecentThread: vscode.CommentThread | undefined;

export function hasCheckpointThread(regionId: string): boolean {
  return threadsByRegion.has(regionId);
}

export function activateCommentThreads(context: vscode.ExtensionContext): void {
  controller = vscode.comments.createCommentController(
    'vibecheck',
    'VibeCheck Comprehension Checks'
  );
  // We DON'T expose a commenting-range provider — users can't start
  // free-form threads, only VibeCheck creates them in response to detected
  // AI bursts.
  context.subscriptions.push(controller);

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'vibecheck.submitAnswer',
      async (reply: vscode.CommentReply) => {
        await handleSubmitAnswer(reply);
      }
    ),
    vscode.commands.registerCommand(
      'vibecheck.overrideThread',
      async (arg?: ThreadCommandArg) => {
        await handleOverride(arg);
      }
    ),
    vscode.commands.registerCommand(
      'vibecheck.dismissThread',
      async (arg?: ThreadCommandArg) => {
        // Dismiss without answering counts toward vibing.
        const target = resolveThread(arg);
        if (!target) return;
        const meta = metaByThread.get(target);
        if (meta) {
          stopSpinner(meta.regionId);
          void recordEvent('checkpoint_dismissed', {
            region_id: meta.regionId,
            source: 'thread_dismiss',
          });
          removeThreadMeta(target, meta.regionId);
        }
        target.dispose();
      }
    ),
    vscode.commands.registerCommand(
      'vibecheck.skipThread',
      async (arg?: ThreadCommandArg) => {
        await handleSkip(arg);
      }
    )
  );
}

export interface CreateThreadInput {
  regionId: string;
  sessionId: string;
  file: string;          // absolute path
  startLine: number;
  endLine: number;
  code: string;
  question: string;
  conceptTag: string;
}

/** Subset of CreateThreadInput used by `createPendingCheckpointThread`. */
export interface CreatePendingThreadInput {
  regionId: string;
  sessionId: string;
  file: string;
  startLine: number;
  endLine: number;
  code: string;
}

/**
 * Create (or return existing) comment thread for a region, then reveal it
 * in the editor by opening the file and scrolling to the range.
 */
export async function createCheckpointThread(
  input: CreateThreadInput
): Promise<vscode.CommentThread | undefined> {
  if (!controller) {
    return undefined;
  }

  const existing = threadsByRegion.get(input.regionId);
  if (existing) {
    mostRecentThread = existing;
    await revealThread(existing);
    return existing;
  }

  const uri = vscode.Uri.file(input.file);
  // Anchor to the FIRST line of the region — that's where VSCode draws
  // the comment indicator in the gutter, and reveals the comment widget.
  // The widget itself spans visually below the anchor regardless of range.
  const range = new vscode.Range(
    input.startLine,
    0,
    input.startLine,
    0
  );

  const seed: vscode.Comment = {
    body: buildQuestionMarkdown(input.question, input.conceptTag),
    mode: vscode.CommentMode.Preview,
    author: { name: 'VibeCheck' },
    contextValue: 'vibecheck-question',
    label: 'comprehension check',
  };

  const thread = controller.createCommentThread(uri, range, [seed]);
  thread.canReply = true;
  thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
  thread.label = `VibeCheck — ${input.conceptTag}`;
  thread.contextValue = 'vibecheck-unresolved';
  thread.state = vscode.CommentThreadState.Unresolved;

  threadsByRegion.set(input.regionId, thread);
  mostRecentThread = thread;
  metaByThread.set(thread, {
    regionId: input.regionId,
    sessionId: input.sessionId,
    question: input.question,
    conceptTag: input.conceptTag,
    code: input.code,
    fileShort: shortName(input.file),
    attempt: 0,
    mode: 'comprehension',
  });

  void recordEvent('checkpoint_opened', {
    region_id: input.regionId,
    concept_tag: input.conceptTag,
  });

  await revealThread(thread);
  return thread;
}

// ── Spinner animation for pending threads ────────────────────────────────
// Standard 10-frame braille spinner (the one you see in npm, cargo, pip).
// Cycles through dot patterns that visually trace a circle. Renders crisp
// in dark themes (VSCode comment widgets inherit `editorWidget.foreground`)
// and is theme-agnostic — no white background ever flashes through.
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_INTERVAL_MS = 100;

interface PendingSpinner {
  thread: vscode.CommentThread;
  intervalId: ReturnType<typeof setInterval>;
}
const pendingSpinners = new Map<string, PendingSpinner>();

type ThreadCommandArg =
  | vscode.CommentThread
  | vscode.CommentReply
  | { thread?: vscode.CommentThread }
  | undefined;

/**
 * Create a thread immediately with an animated circular spinner seed
 * comment, then start a setInterval that re-renders the seed at ~10 fps
 * so the user sees a live "Gemma is thinking" indicator. Caller fetches
 * the real question in the background and calls `attachQuestion()` when
 * it arrives, which stops the spinner and swaps in the final question.
 */
export async function createPendingCheckpointThread(
  input: CreatePendingThreadInput
): Promise<vscode.CommentThread | undefined> {
  if (!controller) {
    return undefined;
  }

  const existing = threadsByRegion.get(input.regionId);
  if (existing) {
    mostRecentThread = existing;
    await revealThread(existing);
    return existing;
  }

  const uri = vscode.Uri.file(input.file);
  const range = new vscode.Range(input.startLine, 0, input.startLine, 0);

  // Initial render — frame 0 of the spinner.
  const seed: vscode.Comment = {
    body: buildPendingMarkdown(SPINNER_FRAMES[0]),
    mode: vscode.CommentMode.Preview,
    author: { name: 'VibeCheck' },
    contextValue: 'vibecheck-pending',
    label: 'analyzing',
  };

  const thread = controller.createCommentThread(uri, range, [seed]);
  thread.canReply = true;
  thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
  thread.label = 'VibeCheck — analyzing…';
  thread.contextValue = 'vibecheck-unresolved';
  thread.state = vscode.CommentThreadState.Unresolved;

  threadsByRegion.set(input.regionId, thread);
  mostRecentThread = thread;
  metaByThread.set(thread, {
    regionId: input.regionId,
    sessionId: input.sessionId,
    question: '(loading)',
    conceptTag: 'analyzing',
    code: input.code,
    fileShort: shortName(input.file),
    attempt: 0,
    mode: 'comprehension',
  });

  // Record the open event the moment the thread appears, not when the
  // question arrives — so a user who dismisses during the spinner still
  // shows up as "opened but skipped" in the aggregate.
  void recordEvent('checkpoint_opened', {
    region_id: input.regionId,
    concept_tag: 'analyzing',
    pending: true,
  });

  // Kick off the spinner animation. It'll keep updating until either
  // attachQuestion() lands the real question or the thread is disposed.
  startSpinner(input.regionId, thread);

  await revealThread(thread);
  return thread;
}

function startSpinner(regionId: string, thread: vscode.CommentThread): void {
  let frame = 1; // frame 0 was rendered synchronously above
  const tick = () => {
    if (!threadsByRegion.has(regionId)) {
      // Thread was disposed externally (dismiss, override, etc).
      stopSpinner(regionId);
      return;
    }
    const ch = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
    frame++;
    const newSeed: vscode.Comment = {
      body: buildPendingMarkdown(ch),
      mode: vscode.CommentMode.Preview,
      author: { name: 'VibeCheck' },
      contextValue: 'vibecheck-pending',
      label: 'analyzing',
    };
    // Replace ONLY the first comment so any user replies typed during
    // the loading state are preserved.
    thread.comments = [newSeed, ...thread.comments.slice(1)];
  };
  const intervalId = setInterval(tick, SPINNER_INTERVAL_MS);
  pendingSpinners.set(regionId, { thread, intervalId });
}

function stopSpinner(regionId: string): void {
  const state = pendingSpinners.get(regionId);
  if (state) {
    clearInterval(state.intervalId);
    pendingSpinners.delete(regionId);
  }
}

function buildPendingMarkdown(spinnerChar: string): vscode.MarkdownString {
  // Dark-theme-friendly: pure markdown, no white backgrounds. The
  // `$(sync~spin)` codicon is included as a bonus — VSCode renders it
  // as a native spinning loader when `supportThemeIcons` is true. If
  // the comment widget strips codicons (it sometimes does), the braille
  // spinner still animates as a fallback.
  const md = new vscode.MarkdownString();
  md.supportThemeIcons = true;
  md.appendMarkdown(
    `### $(sync~spin)  ${spinnerChar}  Generating question with Gemma\n\n`
  );
  md.appendMarkdown(
    `*Reading the AI-authored code and crafting a comprehension check ` +
      `that targets the non-obvious design choice. Usually 1–3 seconds.*`
  );
  return md;
}
// ──────────────────────────────────────────────────────────────────────────

/**
 * Replace the placeholder seed comment of a pending thread with the
 * real question once it arrives. Stops the spinner animation. No-op
 * if the thread has been disposed.
 */
export function attachQuestion(
  regionId: string,
  question: string,
  conceptTag: string
): void {
  const thread = threadsByRegion.get(regionId);
  if (!thread) {
    return;
  }
  // CRITICAL: stop the spinner BEFORE swapping the seed, otherwise the
  // next interval tick would overwrite the real question with another
  // spinner frame.
  stopSpinner(regionId);

  const meta = metaByThread.get(thread);
  if (meta) {
    meta.question = question;
    meta.conceptTag = conceptTag;
  }
  // Replace just the FIRST comment (the seed). Any user replies that may
  // already have been posted while the question was loading are preserved.
  const newSeed: vscode.Comment = {
    body: buildQuestionMarkdown(question, conceptTag),
    mode: vscode.CommentMode.Preview,
    author: { name: 'VibeCheck' },
    contextValue: 'vibecheck-question',
    label: 'comprehension check',
  };
  thread.comments = [newSeed, ...thread.comments.slice(1)];
  thread.label = `VibeCheck — ${conceptTag}`;
}

async function revealThread(thread: vscode.CommentThread): Promise<void> {
  try {
    const doc = await vscode.workspace.openTextDocument(thread.uri);
    const editor = await vscode.window.showTextDocument(doc, {
      preserveFocus: false,
      preview: false,
    });
    if (thread.range) {
      editor.revealRange(thread.range, vscode.TextEditorRevealType.InCenter);
    }
    // Force the thread expanded after reveal — sometimes VSCode collapses
    // it on open.
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
  } catch (err) {
    // Non-fatal; thread still exists and can be opened from the comments
    // panel manually.
    console.warn('[VibeCheck] revealThread failed:', err);
  }
}

async function handleSubmitAnswer(reply: vscode.CommentReply): Promise<void> {
  const thread = reply.thread;
  const meta = metaByThread.get(thread);
  if (!meta) {
    vscode.window.showErrorMessage(
      'VibeCheck: lost track of this thread (extension was reloaded?). Please trigger a fresh AI burst.'
    );
    return;
  }

  const text = reply.text.trim();

  // Override mode: the question comment was swapped for an override
  // prompt. Whatever the user typed is treated as their feedback to
  // Cascade, regardless of length — but it MUST contain real content.
  // Empty / whitespace-only submissions are blocked so cooking% can't
  // be farmed by clicking Override + Submit with no actual suggestion.
  if (meta.mode === 'override') {
    if (text.trim().length === 0) {
      vscode.window.showWarningMessage(
        'VibeCheck: type what the code should do instead, or click Skip to cancel.'
      );
      return;
    }
    await executeOverride(thread, meta, text);
    return;
  }

  if (text.length < 10) {
    vscode.window.showWarningMessage(
      'VibeCheck: type a real explanation (at least ~10 characters).'
    );
    return;
  }

  // If the user submits while the spinner is still running (question
  // hadn't loaded yet), stop the animation now so it doesn't overwrite
  // their reply on the next interval tick.
  stopSpinner(meta.regionId);

  // Bump attempt BEFORE the network call so retries after a fail show
  // up as attempts 2, 3, ….
  meta.attempt += 1;
  void recordEvent('answer_submitted', {
    region_id: meta.regionId,
    attempt: meta.attempt,
    chars: text.length,
  });

  // 1. Append the user's typed answer as a "You" comment.
  const userComment: vscode.Comment = {
    body: text,
    mode: vscode.CommentMode.Preview,
    author: { name: 'You' },
    contextValue: 'vibecheck-answer',
    timestamp: new Date(),
  };

  // 2. Append a transient "grading…" comment from VibeCheck.
  const gradingComment: vscode.Comment = {
    body: new vscode.MarkdownString('_Grading with Gemma…_'),
    mode: vscode.CommentMode.Preview,
    author: { name: 'VibeCheck' },
    contextValue: 'vibecheck-grading',
  };

  thread.comments = [...thread.comments, userComment, gradingComment];

  // Force-clear the reply textarea. VSCode does NOT reliably auto-clear
  // it during long-running async commands, so we toggle `canReply` which
  // makes VSCode tear down + recreate the reply input (empty). The flicker
  // is imperceptible and the grading comment keeps the user oriented.
  clearReplyInput(thread);

  // 3. POST to /gate/verify.
  let score: VerifyScore;
  try {
    const res = await fetch(`${BACKEND_URL}/gate/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        session_id: meta.sessionId,
        checkpoint_id: meta.regionId,
        transcript: text,
        file: meta.fileShort,
        // Pass question + diff_excerpt inline as a fallback so the verify
        // call works even if the question fetch hadn't finished storing
        // the question server-side yet (race with optimistic UI).
        question: meta.question,
        diff_excerpt: meta.code,
      }),
    });
    if (!res.ok) {
      throw new Error(`verify failed (${res.status}): ${await res.text()}`);
    }
    const json = (await res.json()) as { score: VerifyScore };
    score = json.score;
  } catch (err) {
    const errComment: vscode.Comment = {
      body: new vscode.MarkdownString(
        `**Error:** ${err instanceof Error ? err.message : String(err)}\n\n_Try again — the backend may have been restarting._`
      ),
      mode: vscode.CommentMode.Preview,
      author: { name: 'VibeCheck' },
      contextValue: 'vibecheck-error',
      label: 'error',
    };
    thread.comments = [...thread.comments.slice(0, -1), errComment];
    return;
  }

  // 4. Replace the "grading…" placeholder with the graded result.
  const gradedComment: vscode.Comment = {
    body: buildGradedMarkdown(score),
    mode: vscode.CommentMode.Preview,
    author: { name: 'VibeCheck' },
    contextValue: score.passed ? 'vibecheck-passed' : 'vibecheck-failed',
    label: score.passed ? 'passed' : 'failed',
    timestamp: new Date(),
  };
  thread.comments = [...thread.comments.slice(0, -1), gradedComment];

  // 5. Update thread + region state.
  if (score.passed) {
    regionTracker.markStatus([meta.regionId], 'passed');
    thread.state = vscode.CommentThreadState.Resolved;
    thread.contextValue = 'vibecheck-resolved';
    thread.canReply = false;
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
    void recordEvent('answer_passed', {
      region_id: meta.regionId,
      attempt: meta.attempt,
      overall: score.overall,
      first_try: meta.attempt === 1,
    });
  }
  // On fail: leave the thread open + canReply so the user can refine
  // their answer and resubmit. The graded comment includes the follow-up
  // question.
}

/**
 * Force-clear the reply textarea on a thread by briefly flipping
 * `canReply` off and on. There's no public API to set the draft text
 * directly, but toggling `canReply` causes VSCode to dispose and
 * recreate the reply input — which always renders empty. We restore
 * `canReply` on the next microtask so the action group buttons return.
 */
function clearReplyInput(thread: vscode.CommentThread): void {
  const previous = thread.canReply;
  thread.canReply = false;
  // Use queueMicrotask so VSCode applies the canReply=false state
  // (tearing down the input) before we flip it back on.
  queueMicrotask(() => {
    thread.canReply = previous;
  });
}

function resolveThread(arg: ThreadCommandArg): vscode.CommentThread | undefined {
  const replyThread = arg && 'thread' in arg ? arg.thread : undefined;
  if (replyThread) {
    return replyThread;
  }
  const thread = arg as vscode.CommentThread | undefined;
  if (thread) {
    if (metaByThread.has(thread)) {
      return thread;
    }
    for (const candidate of threadsByRegion.values()) {
      if (candidate === thread) {
        return candidate;
      }
    }
  }
  if (mostRecentThread) {
    return mostRecentThread;
  }
  for (const t of threadsByRegion.values()) {
    return t;
  }
  return undefined;
}

function removeThreadMeta(thread: vscode.CommentThread, regionId: string): void {
  threadsByRegion.delete(regionId);
  if (mostRecentThread === thread) {
    mostRecentThread = undefined;
  }
}

/**
 * Override flow (two-step, in-thread):
 *
 *   STEP 1 — `handleOverride` (this fn): user clicks the Override button.
 *   We swap the question comment in-place for an override prompt
 *   ("What should this code do instead? …") and flip the thread's
 *   metadata to `mode: 'override'`. The reply textarea + Submit button
 *   are reused — no top-of-window InputBox.
 *
 *   STEP 2 — `executeOverride` (called from `handleSubmitAnswer` when
 *   `meta.mode === 'override'`): the user types their feedback in the
 *   reply box and clicks Submit. We delete the AI-authored snippet,
 *   forward the exact text to Cascade (auto-paste from clipboard
 *   best-effort), record the event, and dispose the thread.
 *
 * Rationale: a "raw" override (just mark + dispose) trains the engineer
 * to dismiss checkpoints reflexively. Forcing them to articulate WHAT
 * should change converts the override into a structured handoff to the
 * agent — which is exactly the human-AI collaboration loop we're pitching.
 * Keeping the prompt inline with the thread (rather than a top InputBox)
 * keeps the UI quiet and lets users edit/refine in a multi-line textarea.
 */
async function handleOverride(arg: ThreadCommandArg): Promise<void> {
  const thread = resolveThread(arg);
  if (!thread) {
    vscode.window.showWarningMessage(
      'VibeCheck: no active checkpoint thread found to override.'
    );
    return;
  }
  const meta = metaByThread.get(thread);
  if (!meta) {
    thread.dispose();
    return;
  }
  // Already in override mode — no-op so a stray double-click doesn't
  // re-render the prompt and clobber whatever the user is typing.
  if (meta.mode === 'override') {
    return;
  }
  // If user overrides while still pending, stop the spinner first so it
  // doesn't overwrite the override prompt on the next interval tick.
  stopSpinner(meta.regionId);

  // Replace the question comment with a clean override prompt. Any user
  // replies that may have been posted are preserved (we only swap index 0).
  meta.mode = 'override';
  const overridePromptComment: vscode.Comment = {
    body: buildOverridePromptMarkdown(),
    mode: vscode.CommentMode.Preview,
    author: { name: 'VibeCheck' },
    contextValue: 'vibecheck-override-prompt',
    label: 'override',
  };
  thread.comments = [overridePromptComment, ...thread.comments.slice(1)];
  thread.label = 'VibeCheck — override';
  // Flip the thread's contextValue so the package.json menu `when`
  // clauses hide the Override button. Submit + Skip stay visible.
  thread.contextValue = 'vibecheck-override-pending';

  // Force the reply textarea to render fresh (and empty) so the user
  // isn't typing on top of a stale comprehension draft.
  clearReplyInput(thread);
}

/**
 * Step 2 of the override flow. Called from `handleSubmitAnswer` when the
 * thread's mode is 'override' and the user has typed feedback + clicked
 * Submit. Deletes the AI-authored snippet, forwards the text to Cascade,
 * and tears down the thread.
 */
async function executeOverride(
  thread: vscode.CommentThread,
  meta: ThreadMeta,
  userReasoning: string
): Promise<void> {
  // Defense in depth: `handleSubmitAnswer` already gates on non-empty
  // text, but we re-check here so cooking% can NEVER be awarded for
  // an empty/whitespace-only override. Bail silently — the calling
  // path is responsible for any user-facing toast.
  if (userReasoning.trim().length === 0) {
    return;
  }

  // 1. Look up the FRESH line numbers from the tracker (they may have
  //    shifted since the thread was created if the user edited above).
  const region = regionTracker.getById(meta.regionId);

  // 2. Build the structured Cascade prompt BEFORE deleting the code,
  //    so we can quote the original snippet from the live document
  //    (more accurate than meta.code, which can drift on later edits
  //    above the region).
  const cascadePrompt = buildCascadePrompt({
    fileShort: meta.fileShort,
    region,
    fallbackCode: meta.code,
    userReasoning,
  });

  // 3. Delete the AI-authored snippet from the document. The
  //    velocityDetector's onDidChangeTextDocument handler will fire
  //    `applyEdit` + `gcStaleRegions` and remove the region from the
  //    tracker automatically.
  if (region) {
    try {
      const uri = vscode.Uri.file(region.file);
      const doc = await vscode.workspace.openTextDocument(uri);
      const startLine = Math.max(0, region.startLine);
      const endLine = Math.min(doc.lineCount - 1, region.endLine);
      const startPos = new vscode.Position(startLine, 0);
      const endPos =
        endLine + 1 < doc.lineCount
          ? new vscode.Position(endLine + 1, 0)
          : doc.lineAt(endLine).range.end;
      const edit = new vscode.WorkspaceEdit();
      edit.delete(uri, new vscode.Range(startPos, endPos));
      await vscode.workspace.applyEdit(edit);
    } catch (err) {
      console.warn('[VibeCheck] override: failed to delete region:', err);
    }
  }

  // 4. Put the structured prompt on the clipboard. This is the
  //    bulletproof fallback — even if the auto-paste below fails, the
  //    user can Cmd/Ctrl+V into Cascade.
  await vscode.env.clipboard.writeText(cascadePrompt);

  // 5. Open Cascade and best-effort auto-paste the prompt into its input.
  const result = await tryOpenCascadeWithPrompt(cascadePrompt);

  // 5. Record + dispose. We DON'T call markStatus('overridden') — the
  //    deletion above already removed the region via gcStaleRegions, so
  //    there's nothing left to mark.
  void recordEvent('checkpoint_overridden', {
    region_id: meta.regionId,
    source: 'thread_override',
    cascade_opened: result.opened,
    cascade_pasted: result.pasted,
    feedback_chars: userReasoning.length,
  });
  removeThreadMeta(thread, meta.regionId);
  thread.dispose();

  // 6. Toast that reflects what actually happened.
  if (result.opened && result.pasted) {
    vscode.window.showInformationMessage(
      'VibeCheck: code removed. Prompt pasted into Cascade — press Enter to send.'
    );
  } else if (result.opened) {
    vscode.window.showInformationMessage(
      'VibeCheck: code removed. Cascade opened — paste with Cmd/Ctrl+V, then press Enter.'
    );
  } else {
    vscode.window.showInformationMessage(
      'VibeCheck: code removed. Prompt copied to clipboard — open Cascade (Cmd+L / Ctrl+L) and paste.'
    );
  }
}

/**
 * Best-effort handoff of the user's feedback into Cascade as the next
 * prompt. The primary command — `windsurf.triggerCascade` ("Start
 * Cascade Conversation") — was verified by inspecting the bundled
 * Windsurf extension manifest at
 *   ~/.windsurf-server/bin/<rev>/extensions/windsurf/package.json
 *
 * The handler is implemented inside the closed-source Windsurf binary
 * and (as of this build) ignores any arguments we pass — it just opens
 * an empty Cascade conversation. So we do this in two phases:
 *
 *   1. Open Cascade. Probe several arg shapes for `windsurf.triggerCascade`
 *      in case a future build accepts a query, then fall back to
 *      `workbench.action.chat.open`. The first invocation that doesn't
 *      throw wins.
 *
 *   2. After a short delay (so the chat input has time to mount + grab
 *      focus), execute `editor.action.clipboardPasteAction` to paste
 *      the prompt — the caller is responsible for putting the prompt
 *      on the clipboard BEFORE calling this fn. There's no public
 *      "submit chat" command, so the user still presses Enter manually.
 */
async function tryOpenCascadeWithPrompt(
  prompt: string
): Promise<{ opened: boolean; pasted: boolean }> {
  const candidates: Array<{ id: string; args: unknown[] }> = [
    // Verified Windsurf command. Try the object-shape first since most
    // VSCode chat APIs use `{ query }`; fall back to the positional
    // string in case Windsurf accepts a raw string. The no-args variant
    // is the documented behavior (just open the panel).
    { id: 'windsurf.triggerCascade', args: [{ query: prompt, prompt }] },
    { id: 'windsurf.triggerCascade', args: [prompt] },
    { id: 'windsurf.triggerCascade', args: [] },
    // Last-ditch: VSCode's built-in chat opener. If Cascade hijacks the
    // chat surface in this build, this still routes the prompt to it.
    { id: 'workbench.action.chat.open', args: [{ query: prompt }] },
  ];

  let opened = false;
  for (const c of candidates) {
    try {
      await vscode.commands.executeCommand(c.id, ...c.args);
      opened = true;
      break;
    } catch {
      // Try the next one.
    }
  }
  if (!opened) {
    return { opened: false, pasted: false };
  }

  // Give Cascade a moment to mount its webview and put focus into the
  // chat input. 400ms is empirically enough on a warm window without
  // making the user wait noticeably.
  await new Promise((resolve) => setTimeout(resolve, 400));

  // Best-effort paste from clipboard into whatever has focus. If
  // Cascade's input is focused (it usually is right after triggerCascade),
  // the prompt lands there and the user just hits Enter.
  let pasted = false;
  for (const cmd of [
    'editor.action.clipboardPasteAction',
    'execPaste',
    'paste',
  ]) {
    try {
      await vscode.commands.executeCommand(cmd);
      pasted = true;
      break;
    } catch {
      // Try the next paste variant.
    }
  }

  return { opened, pasted };
}

/**
 * Build the structured prompt that gets sent to Cascade as the next
 * message when the user overrides a checkpoint. Including the file
 * path, the AI-authored snippet we're rejecting, AND the user's
 * reasoning gives Cascade the full context to write a replacement
 * that addresses the specific complaint, instead of just hearing the
 * complaint out of nowhere.
 *
 * Source of the snippet, in priority order:
 *   1. The current text of the file at the region's range, if the
 *      region is still tracked. Most accurate — captures any tweaks
 *      the user made before clicking Override.
 *   2. The frozen `meta.code` captured at burst time. Fallback for
 *      regions that have already been GC'd or moved.
 */
function buildCascadePrompt(input: {
  fileShort: string;
  region: ReturnType<typeof regionTracker.getById>;
  fallbackCode: string;
  userReasoning: string;
}): string {
  const { fileShort, region, fallbackCode, userReasoning } = input;

  // Try to read the live snippet so the prompt reflects exactly what's
  // about to be deleted, not what was generated minutes ago.
  let snippet = fallbackCode;
  let lineRange: string | undefined;
  if (region) {
    try {
      const doc = vscode.workspace.textDocuments.find(
        (d) => d.uri.fsPath === region.file
      );
      if (doc) {
        const startLine = Math.max(0, region.startLine);
        const endLine = Math.min(doc.lineCount - 1, region.endLine);
        const range = new vscode.Range(
          startLine,
          0,
          endLine,
          doc.lineAt(endLine).range.end.character
        );
        snippet = doc.getText(range);
        lineRange = `${startLine + 1}-${endLine + 1}`;
      }
    } catch {
      // Fall through to the frozen meta.code.
    }
  }

  const lang = languageHintForFile(fileShort);
  const where = lineRange
    ? `\`${fileShort}\` (lines ${lineRange})`
    : `\`${fileShort}\``;

  const lines: string[] = [];
  lines.push(
    `I'm rejecting an AI-generated snippet in ${where} and want you to ` +
      `rewrite it. Here is the snippet I'm removing:`
  );
  lines.push('');
  lines.push('```' + lang);
  lines.push(snippet.replace(/\n+$/u, ''));
  lines.push('```');
  lines.push('');
  lines.push(`What I want instead:`);
  lines.push('');
  lines.push(userReasoning);
  lines.push('');
  lines.push(
    `Please write the replacement code directly into ${where}. Match ` +
      `the surrounding style and explain the key tradeoff in 1–2 sentences.`
  );
  return lines.join('\n');
}

/**
 * Map a filename to a markdown code-fence language tag so Cascade gets
 * syntax-aware quoting of the snippet. Falls back to no language if
 * the extension is unknown.
 */
function languageHintForFile(fileShort: string): string {
  const ext = fileShort.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    ts: 'ts',
    tsx: 'tsx',
    js: 'js',
    jsx: 'jsx',
    py: 'python',
    rs: 'rust',
    go: 'go',
    java: 'java',
    kt: 'kotlin',
    rb: 'ruby',
    php: 'php',
    cs: 'csharp',
    c: 'c',
    h: 'c',
    cpp: 'cpp',
    hpp: 'cpp',
    cc: 'cpp',
    swift: 'swift',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    sql: 'sql',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    toml: 'toml',
    md: 'markdown',
    html: 'html',
    css: 'css',
    scss: 'scss',
  };
  return map[ext] ?? '';
}

/**
 * Question-comment body shown after the user clicks the Override
 * button. Replaces the original "Concept: … / What would happen if …"
 * comprehension question. Plain markdown — no codicons or HTML — so
 * the comment widget renders crisply across themes.
 */
function buildOverridePromptMarkdown(): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.supportHtml = false;
  md.isTrusted = false;
  md.appendMarkdown(`**Override** — what should this code do instead?\n\n`);
  md.appendMarkdown(
    `Type your replacement instructions in the reply box below and click ` +
      `**Submit answer** (or press Enter). Your text is sent straight to ` +
      `Cascade as the next prompt, and the AI-authored snippet above is ` +
      `deleted.\n\n`
  );
  md.appendMarkdown(
    `_Click **Skip** to cancel and leave the code untouched._`
  );
  return md;
}

/**
 * Skip the checkpoint without claiming ownership: the region stays
 * unverified, and the event counts against the "vibing" gauge. Use
 * this when you want to defer the question, not reject the code.
 */
async function handleSkip(arg: ThreadCommandArg): Promise<void> {
  const thread = resolveThread(arg);
  if (!thread) {
    vscode.window.showWarningMessage(
      'VibeCheck: no active checkpoint thread found to skip.'
    );
    return;
  }
  const meta = metaByThread.get(thread);
  if (meta) {
    stopSpinner(meta.regionId);
    // Mark the region 'skipped' so the decorator stops painting the
    // yellow "needs check" highlight, but the region itself stays in
    // the tracker (counts toward the "vibing" gauge / dismissed totals).
    regionTracker.markStatus([meta.regionId], 'skipped');
    // Distinct source tag for skips that happened AFTER the user
    // clicked Override but bailed without typing a suggestion. The
    // event is still `checkpoint_dismissed` (vibing bucket — never
    // cooking) but the source string makes the abandonment obvious
    // in analytics.
    const source =
      meta.mode === 'override' ? 'thread_override_abandoned' : 'thread_skip';
    void recordEvent('checkpoint_dismissed', {
      region_id: meta.regionId,
      source,
    });
    removeThreadMeta(thread, meta.regionId);
  }
  thread.dispose();
}

// ── Markdown builders ──────────────────────────────────────────────────────

function buildQuestionMarkdown(
  question: string,
  conceptTag: string
): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.supportHtml = true;
  md.isTrusted = false;
  md.appendMarkdown(`**Concept:** \`${conceptTag}\`\n\n`);
  md.appendMarkdown(question);
  return md;
}

function buildGradedMarkdown(score: VerifyScore): vscode.MarkdownString {
  const fmt = (n: number) =>
    typeof n === 'number' && !Number.isNaN(n) ? n.toFixed(2) : '—';
  const verdictIcon = score.passed ? '✓' : '✗';
  const verdictText = score.passed
    ? 'Comprehension verified'
    : 'Not quite — try again';

  const md = new vscode.MarkdownString();
  md.supportHtml = true;
  md.isTrusted = false;
  md.appendMarkdown(
    `**${verdictIcon} ${verdictText}** — overall **${fmt(score.overall)}**\n\n`
  );
  md.appendMarkdown(
    `| What it does | Why this approach | Tradeoffs |\n|---|---|---|\n| ${fmt(
      score.what_it_does
    )} | ${fmt(score.why_this_approach)} | ${fmt(score.tradeoffs)} |\n\n`
  );
  if (score.feedback) {
    md.appendMarkdown(`${score.feedback}\n\n`);
  }
  if (score.follow_up_question) {
    md.appendMarkdown(`**Follow-up:** ${score.follow_up_question}`);
  }
  return md;
}

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

function shortName(filePath: string): string {
  return filePath.split('/').pop() ?? filePath;
}
