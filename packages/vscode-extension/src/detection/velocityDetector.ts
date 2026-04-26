import * as vscode from 'vscode';
import { openCheckpointPanel } from '../checkpoint/panel';
import { looksLikePaste, refreshClipboardSnapshot } from './clipboard';
import { regionTracker, AIRegion } from './regionTracker';

// ── Tunable thresholds ─────────────────────────────────────
const AI_LINE_THRESHOLD = 5;          // single change must add more than this many lines to qualify
const HUMAN_IDLE_MIN_MS = 300;        // gap of inactivity preceding the burst
const BURST_AGGREGATION_MS = 1_500;   // fold subsequent fast edits into the same burst
const MAX_BURST_DURATION_MS = 4_000;  // hard cap so bursts can't extend forever
const TOAST_COOLDOWN_MS = 1_500;      // don't spam toasts on rapid bursts
// ───────────────────────────────────────────────────────────

let lastChangeTime = 0;
let lastToastTime = 0;
let output: vscode.OutputChannel | undefined;

// In-flight burst aggregator. Once an AI burst is detected, any further
// content changes within BURST_AGGREGATION_MS are added to the same burst,
// even across files. This is the key to handling Cascade's multi-file edits.
interface ActiveBurst {
  burstId: string;
  startedAt: number;
  lastEditAt: number;
  regions: AIRegion[];
  toastShown: boolean;
}
let activeBurst: ActiveBurst | null = null;

function log(line: string) {
  if (!output) return;
  const ts = new Date().toISOString().split('T')[1].replace('Z', '');
  output.appendLine(`[${ts}] ${line}`);
}

export function activateVelocityDetector(context: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel('VibeCheck');
  context.subscriptions.push(output);
  // Forward regionTracker diagnostics through the same channel.
  regionTracker.setLogger(log);
  log('velocity detector active');
  // Make the channel visible without stealing keyboard focus, so the
  // dropdown is preselected to "VibeCheck" the first time the user opens
  // the Output panel.
  output.show(true);

  context.subscriptions.push(
    vscode.window.onDidChangeWindowState(async (s) => {
      if (s.focused) await refreshClipboardSnapshot();
    })
  );
  void refreshClipboardSnapshot();

  const sub = vscode.workspace.onDidChangeTextDocument(async (event) => {
    if (event.document.uri.scheme !== 'file') return;
    if (event.contentChanges.length === 0) return;

    const now = Date.now();
    const elapsedSinceLast = lastChangeTime === 0 ? Infinity : now - lastChangeTime;
    lastChangeTime = now;

    const reason = event.reason;
    const isUndoRedo = reason !== undefined;

    // Per-event totals across ALL contentChanges (not just [0]).
    let totalLinesAdded = 0;
    let totalLinesNet = 0; // positive = grew, negative = shrunk
    for (const c of event.contentChanges) {
      const insertedLines = c.text === '' ? 0 : c.text.split('\n').length;
      const removedLines = c.range.end.line - c.range.start.line + 1;
      totalLinesAdded += insertedLines;
      totalLinesNet += insertedLines - removedLines;
    }

    const anyPaste = event.contentChanges.some((c) => looksLikePaste(c.text));
    const burstSize = totalLinesAdded > AI_LINE_THRESHOLD;
    const followsIdle = elapsedSinceLast >= HUMAN_IDLE_MIN_MS;

    // Expire the active burst if it's older than MAX_BURST_DURATION_MS.
    // Without this, every continuation resets lastEditAt and the burst can
    // run forever as long as something keeps editing every <1.5s.
    if (activeBurst && now - activeBurst.startedAt > MAX_BURST_DURATION_MS) {
      log(`burst expired (lifetime ${now - activeBurst.startedAt}ms > ${MAX_BURST_DURATION_MS}ms)`);
      activeBurst = null;
    }

    // Continuation of an active burst.
    // Stricter than before: the continuation must ITSELF be burst-sized.
    // This is what stops snippet-expansion / format-on-save / autocomplete
    // chains from being absorbed into the AI burst — those produce many
    // small (1-3 line) edits in rapid succession; real AI generations
    // produce burst-sized chunks.
    if (
      activeBurst &&
      now - activeBurst.lastEditAt < BURST_AGGREGATION_MS &&
      burstSize &&
      !isUndoRedo &&
      !anyPaste
    ) {
      const regions = changesToRegions(event, activeBurst.burstId);
      activeBurst.regions.push(...regions);
      activeBurst.lastEditAt = now;
      regionTracker.addBurst(regions);
      log(
        `burst+= file=${shortName(event.document.fileName)} +${totalLinesAdded} lines (burst total ${activeBurst.regions.length} regions)`
      );
      if (!activeBurst.toastShown) maybeToast(context, event.document, totalLinesAdded);
      return;
    }

    // Active burst exists but this edit didn't qualify — log and treat as
    // a human edit (shift regions). The burst stays open for further
    // burst-sized continuations until the time/duration window closes.
    if (activeBurst && !burstSize && !isUndoRedo) {
      log(
        `burst held: ignoring small edit +${totalLinesAdded} lines (burst still active)`
      );
    }

    // Fresh evaluation.
    const isAIBurst = burstSize && followsIdle && !isUndoRedo && !anyPaste;
    log(
      `change file=${shortName(event.document.fileName)} +${totalLinesAdded}/${totalLinesNet} idle=${
        elapsedSinceLast === Infinity ? 'inf' : `${elapsedSinceLast}ms`
      } reason=${reason ?? 'none'} paste=${anyPaste} burst=${burstSize} → ${isAIBurst ? 'AI BURST ✅' : 'ignored'}`
    );

    // Reconcile existing regions against this human edit. Handles deletions
    // (full or partial), insertions before/after/inside regions, etc.
    if (!isAIBurst && !isUndoRedo) {
      for (const c of event.contentChanges) {
        const insertedLines = c.text === '' ? 0 : c.text.split('\n').length - 1;
        regionTracker.applyEdit(
          event.document.fileName,
          c.range.start.line,
          c.range.end.line,
          insertedLines
        );
      }
      // Drop any regions whose surviving content is now all-whitespace —
      // happens when the user deletes the AI body but leaves a blank line
      // behind, which `applyEdit` alone can't detect (it only sees line
      // numbers, not text).
      regionTracker.gcStaleRegions(event.document);
      return;
    }

    if (!isAIBurst) return;

    // New burst.
    const burstId = `burst-${now}-${Math.random().toString(36).slice(2, 7)}`;
    const regions = changesToRegions(event, burstId);
    activeBurst = {
      burstId,
      startedAt: now,
      lastEditAt: now,
      regions,
      toastShown: false,
    };
    regionTracker.addBurst(regions);
    log(`burst start id=${burstId} regions=${regions.length}`);

    maybeToast(context, event.document, totalLinesAdded);
  });

  context.subscriptions.push(sub);
}

function changesToRegions(
  event: vscode.TextDocumentChangeEvent,
  burstId: string
): AIRegion[] {
  const out: AIRegion[] = [];
  const file = event.document.fileName;
  const now = Date.now();
  for (const c of event.contentChanges) {
    if (!c.text) continue;
    const lines = c.text.split('\n');
    if (lines.length < 2) continue; // ignore tiny single-line edits inside a burst

    // Trim leading/trailing blank lines so the highlighted region only spans
    // actual code. Without this, an inserted block that starts/ends with a
    // blank line (very common: "...\n\nfunction foo() { ... }\n") would
    // include those blanks in the region range, and any subsequent user
    // typing on those "blank" lines would appear under the yellow highlight.
    let first = 0;
    while (first < lines.length && lines[first].trim() === '') first++;
    let last = lines.length - 1;
    while (last >= 0 && lines[last].trim() === '') last--;
    if (first > last) continue; // all-blank insert (rare)
    if (last - first < 1) continue; // fewer than 2 non-blank lines

    const startLine = c.range.start.line + first;
    const endLine = c.range.start.line + last;
    const trimmedText = lines.slice(first, last + 1).join('\n');
    out.push({
      id: `region-${now}-${Math.random().toString(36).slice(2, 7)}`,
      burstId,
      file,
      startLine,
      endLine,
      text: trimmedText,
      generatedAt: now,
      status: 'unverified',
    });
  }
  return out;
}

async function maybeToast(
  context: vscode.ExtensionContext,
  doc: vscode.TextDocument,
  linesAdded: number
) {
  const now = Date.now();
  const sinceLastToast = now - lastToastTime;
  if (lastToastTime > 0 && sinceLastToast < TOAST_COOLDOWN_MS) {
    log(`toast SUPPRESSED (cooldown ${sinceLastToast}ms < ${TOAST_COOLDOWN_MS}ms)`);
    return;
  }
  lastToastTime = now;
  if (activeBurst) activeBurst.toastShown = true;

  const burst = activeBurst;
  const fileCount = burst ? new Set(burst.regions.map((r) => r.file)).size : 1;
  const filePart =
    fileCount > 1 ? `${fileCount} files` : shortName(doc.fileName);

  log(`toast SHOWN (~${linesAdded} lines in ${filePart})`);
  const choice = await vscode.window.showInformationMessage(
    `🧠 VibeCheck: AI just wrote ~${linesAdded} lines in ${filePart}. Quick check?`,
    'Answer Now',
    'Skip'
  );

  if (choice === 'Answer Now') {
    log('user clicked Answer Now → opening panel');
    const regions = burst ? regionTracker.getByBurst(burst.burstId) : [];
    const questions = regions.map((r) => regionToQuestion(r));
    openCheckpointPanel(
      context,
      burst?.burstId ?? `local-${now}`,
      questions.length ? questions : [fallbackQuestion(doc)],
      'velocity'
    );
  } else if (choice === 'Skip') {
    log('user skipped checkpoint');
  } else {
    log('toast dismissed without action (auto-timeout)');
  }
}

function regionToQuestion(r: AIRegion) {
  const file = shortName(r.file);
  return {
    checkpoint_id: r.id,
    question: `Walk me through what the AI-generated code in ${file}:${r.startLine + 1}-${r.endLine + 1} does, and why this approach over alternatives.`,
    concept_tag: 'general comprehension',
    code_context: `${file}:${r.startLine + 1}-${r.endLine + 1}`,
    file,
    diff_excerpt: r.text,
  };
}

function fallbackQuestion(doc: vscode.TextDocument) {
  return {
    question: `Walk me through what was just generated in ${shortName(doc.fileName)}.`,
    concept_tag: 'general comprehension',
    code_context: shortName(doc.fileName),
    file: shortName(doc.fileName),
  };
}

function shortName(filePath: string): string {
  return filePath.split('/').pop() ?? filePath;
}

// Test helper: clears the cooldown + active-burst state so the next
// onDidChangeTextDocument is evaluated as a fresh AI burst. Used by
// the `vibecheck.simulateAIBurst` command so repeated invocations
// reliably fire a toast for testing.
export function resetDetectorForTest() {
  lastToastTime = 0;
  activeBurst = null;
  lastChangeTime = 0;
  log('detector state reset (test helper)');
}
