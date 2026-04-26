"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.hasCheckpointThread = hasCheckpointThread;
exports.activateCommentThreads = activateCommentThreads;
exports.createCheckpointThread = createCheckpointThread;
exports.createPendingCheckpointThread = createPendingCheckpointThread;
exports.attachQuestion = attachQuestion;
const vscode = __importStar(require("vscode"));
const regionTracker_1 = require("../detection/regionTracker");
const recorder_1 = require("../metrics/recorder");
const BACKEND_URL = process.env.VIBECHECK_BACKEND_URL ?? 'http://localhost:8000';
let controller;
const threadsByRegion = new Map();
const metaByThread = new WeakMap();
let mostRecentThread;
function hasCheckpointThread(regionId) {
    return threadsByRegion.has(regionId);
}
function activateCommentThreads(context) {
    controller = vscode.comments.createCommentController('vibecheck', 'VibeCheck Comprehension Checks');
    // We DON'T expose a commenting-range provider — users can't start
    // free-form threads, only VibeCheck creates them in response to detected
    // AI bursts.
    context.subscriptions.push(controller);
    context.subscriptions.push(vscode.commands.registerCommand('vibecheck.submitAnswer', async (reply) => {
        await handleSubmitAnswer(reply);
    }), vscode.commands.registerCommand('vibecheck.overrideThread', async (arg) => {
        await handleOverride(arg);
    }), vscode.commands.registerCommand('vibecheck.dismissThread', async (arg) => {
        // Dismiss without answering counts toward vibing.
        const target = resolveThread(arg);
        if (!target)
            return;
        const meta = metaByThread.get(target);
        if (meta) {
            stopSpinner(meta.regionId);
            void (0, recorder_1.recordEvent)('checkpoint_dismissed', {
                region_id: meta.regionId,
                source: 'thread_dismiss',
            });
            removeThreadMeta(target, meta.regionId);
        }
        target.dispose();
    }), vscode.commands.registerCommand('vibecheck.skipThread', async (arg) => {
        await handleSkip(arg);
    }));
}
/**
 * Create (or return existing) comment thread for a region, then reveal it
 * in the editor by opening the file and scrolling to the range.
 */
async function createCheckpointThread(input) {
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
    const range = new vscode.Range(input.startLine, 0, input.startLine, 0);
    const seed = {
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
    });
    void (0, recorder_1.recordEvent)('checkpoint_opened', {
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
const pendingSpinners = new Map();
/**
 * Create a thread immediately with an animated circular spinner seed
 * comment, then start a setInterval that re-renders the seed at ~10 fps
 * so the user sees a live "Gemma is thinking" indicator. Caller fetches
 * the real question in the background and calls `attachQuestion()` when
 * it arrives, which stops the spinner and swaps in the final question.
 */
async function createPendingCheckpointThread(input) {
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
    const seed = {
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
    });
    // Record the open event the moment the thread appears, not when the
    // question arrives — so a user who dismisses during the spinner still
    // shows up as "opened but skipped" in the aggregate.
    void (0, recorder_1.recordEvent)('checkpoint_opened', {
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
function startSpinner(regionId, thread) {
    let frame = 1; // frame 0 was rendered synchronously above
    const tick = () => {
        if (!threadsByRegion.has(regionId)) {
            // Thread was disposed externally (dismiss, override, etc).
            stopSpinner(regionId);
            return;
        }
        const ch = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
        frame++;
        const newSeed = {
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
function stopSpinner(regionId) {
    const state = pendingSpinners.get(regionId);
    if (state) {
        clearInterval(state.intervalId);
        pendingSpinners.delete(regionId);
    }
}
function buildPendingMarkdown(spinnerChar) {
    // Dark-theme-friendly: pure markdown, no white backgrounds. The
    // `$(sync~spin)` codicon is included as a bonus — VSCode renders it
    // as a native spinning loader when `supportThemeIcons` is true. If
    // the comment widget strips codicons (it sometimes does), the braille
    // spinner still animates as a fallback.
    const md = new vscode.MarkdownString();
    md.supportThemeIcons = true;
    md.appendMarkdown(`### $(sync~spin)  ${spinnerChar}  Generating question with Gemma\n\n`);
    md.appendMarkdown(`*Reading the AI-authored code and crafting a comprehension check ` +
        `that targets the non-obvious design choice. Usually 1–3 seconds.*`);
    return md;
}
// ──────────────────────────────────────────────────────────────────────────
/**
 * Replace the placeholder seed comment of a pending thread with the
 * real question once it arrives. Stops the spinner animation. No-op
 * if the thread has been disposed.
 */
function attachQuestion(regionId, question, conceptTag) {
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
    const newSeed = {
        body: buildQuestionMarkdown(question, conceptTag),
        mode: vscode.CommentMode.Preview,
        author: { name: 'VibeCheck' },
        contextValue: 'vibecheck-question',
        label: 'comprehension check',
    };
    thread.comments = [newSeed, ...thread.comments.slice(1)];
    thread.label = `VibeCheck — ${conceptTag}`;
}
async function revealThread(thread) {
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
    }
    catch (err) {
        // Non-fatal; thread still exists and can be opened from the comments
        // panel manually.
        console.warn('[VibeCheck] revealThread failed:', err);
    }
}
async function handleSubmitAnswer(reply) {
    const thread = reply.thread;
    const meta = metaByThread.get(thread);
    if (!meta) {
        vscode.window.showErrorMessage('VibeCheck: lost track of this thread (extension was reloaded?). Please trigger a fresh AI burst.');
        return;
    }
    const text = reply.text.trim();
    if (text.length < 10) {
        vscode.window.showWarningMessage('VibeCheck: type a real explanation (at least ~10 characters).');
        return;
    }
    // If the user submits while the spinner is still running (question
    // hadn't loaded yet), stop the animation now so it doesn't overwrite
    // their reply on the next interval tick.
    stopSpinner(meta.regionId);
    // Bump attempt BEFORE the network call so retries after a fail show
    // up as attempts 2, 3, ….
    meta.attempt += 1;
    void (0, recorder_1.recordEvent)('answer_submitted', {
        region_id: meta.regionId,
        attempt: meta.attempt,
        chars: text.length,
    });
    // 1. Append the user's typed answer as a "You" comment.
    const userComment = {
        body: text,
        mode: vscode.CommentMode.Preview,
        author: { name: 'You' },
        contextValue: 'vibecheck-answer',
        timestamp: new Date(),
    };
    // 2. Append a transient "grading…" comment from VibeCheck.
    const gradingComment = {
        body: new vscode.MarkdownString('_Grading with Gemma…_'),
        mode: vscode.CommentMode.Preview,
        author: { name: 'VibeCheck' },
        contextValue: 'vibecheck-grading',
    };
    thread.comments = [...thread.comments, userComment, gradingComment];
    // 3. POST to /gate/verify.
    let score;
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
        const json = (await res.json());
        score = json.score;
    }
    catch (err) {
        const errComment = {
            body: new vscode.MarkdownString(`**Error:** ${err instanceof Error ? err.message : String(err)}\n\n_Try again — the backend may have been restarting._`),
            mode: vscode.CommentMode.Preview,
            author: { name: 'VibeCheck' },
            contextValue: 'vibecheck-error',
            label: 'error',
        };
        thread.comments = [...thread.comments.slice(0, -1), errComment];
        return;
    }
    // 4. Replace the "grading…" placeholder with the graded result.
    const gradedComment = {
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
        regionTracker_1.regionTracker.markStatus([meta.regionId], 'passed');
        thread.state = vscode.CommentThreadState.Resolved;
        thread.contextValue = 'vibecheck-resolved';
        thread.canReply = false;
        thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
        void (0, recorder_1.recordEvent)('answer_passed', {
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
function resolveThread(arg) {
    const replyThread = arg && 'thread' in arg ? arg.thread : undefined;
    if (replyThread) {
        return replyThread;
    }
    const thread = arg;
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
function removeThreadMeta(thread, regionId) {
    threadsByRegion.delete(regionId);
    if (mostRecentThread === thread) {
        mostRecentThread = undefined;
    }
}
async function handleOverride(arg) {
    const thread = resolveThread(arg);
    if (!thread) {
        vscode.window.showWarningMessage('VibeCheck: no active checkpoint thread found to override.');
        return;
    }
    const meta = metaByThread.get(thread);
    if (meta) {
        // If user overrides while still pending, stop the spinner first.
        stopSpinner(meta.regionId);
    }
    if (!meta) {
        thread.dispose();
        return;
    }
    const overrideComment = {
        body: new vscode.MarkdownString('_Region marked as overridden without verification. Use this only when the AI code is wrong and you plan to delete or rewrite it._'),
        mode: vscode.CommentMode.Preview,
        author: { name: 'VibeCheck' },
        contextValue: 'vibecheck-overridden',
        label: 'overridden',
        timestamp: new Date(),
    };
    thread.comments = [...thread.comments, overrideComment];
    thread.state = vscode.CommentThreadState.Resolved;
    thread.contextValue = 'vibecheck-resolved';
    thread.canReply = false;
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
    regionTracker_1.regionTracker.markStatus([meta.regionId], 'overridden');
    // Override counts as engagement (user read & rejected) → learning bucket.
    void (0, recorder_1.recordEvent)('checkpoint_overridden', {
        region_id: meta.regionId,
        source: 'thread_override',
    });
    removeThreadMeta(thread, meta.regionId);
    thread.dispose();
}
/**
 * Skip the checkpoint without claiming ownership: the region stays
 * unverified, and the event counts against the "vibing" gauge. Use
 * this when you want to defer the question, not reject the code.
 */
async function handleSkip(arg) {
    const thread = resolveThread(arg);
    if (!thread) {
        vscode.window.showWarningMessage('VibeCheck: no active checkpoint thread found to skip.');
        return;
    }
    const meta = metaByThread.get(thread);
    if (meta) {
        stopSpinner(meta.regionId);
        void (0, recorder_1.recordEvent)('checkpoint_dismissed', {
            region_id: meta.regionId,
            source: 'thread_skip',
        });
        removeThreadMeta(thread, meta.regionId);
    }
    thread.dispose();
}
// ── Markdown builders ──────────────────────────────────────────────────────
function buildQuestionMarkdown(question, conceptTag) {
    const md = new vscode.MarkdownString();
    md.supportHtml = true;
    md.isTrusted = false;
    md.appendMarkdown(`**Concept:** \`${conceptTag}\`\n\n`);
    md.appendMarkdown(question);
    return md;
}
function buildGradedMarkdown(score) {
    const fmt = (n) => typeof n === 'number' && !Number.isNaN(n) ? n.toFixed(2) : '—';
    const verdictIcon = score.passed ? '✓' : '✗';
    const verdictText = score.passed
        ? 'Comprehension verified'
        : 'Not quite — try again';
    const md = new vscode.MarkdownString();
    md.supportHtml = true;
    md.isTrusted = false;
    md.appendMarkdown(`**${verdictIcon} ${verdictText}** — overall **${fmt(score.overall)}**\n\n`);
    md.appendMarkdown(`| What it does | Why this approach | Tradeoffs |\n|---|---|---|\n| ${fmt(score.what_it_does)} | ${fmt(score.why_this_approach)} | ${fmt(score.tradeoffs)} |\n\n`);
    if (score.feedback) {
        md.appendMarkdown(`${score.feedback}\n\n`);
    }
    if (score.follow_up_question) {
        md.appendMarkdown(`**Follow-up:** ${score.follow_up_question}`);
    }
    return md;
}
function shortName(filePath) {
    return filePath.split('/').pop() ?? filePath;
}
//# sourceMappingURL=commentThreads.js.map