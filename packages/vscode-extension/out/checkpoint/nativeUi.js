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
exports.runNativeCheckpoint = runNativeCheckpoint;
const vscode = __importStar(require("vscode"));
const regionTracker_1 = require("../detection/regionTracker");
const recorder_1 = require("../metrics/recorder");
const BACKEND_URL = process.env.VIBECHECK_BACKEND_URL ?? 'http://localhost:8000';
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
async function runNativeCheckpoint(payload) {
    const location = `${payload.fileShort}:${payload.startLine + 1}-${payload.endLine + 1}`;
    const choice = await vscode.window.showInformationMessage(`🧠 VibeCheck (${payload.conceptTag}) — ${location}\n\n${payload.question}`, {
        modal: true,
        // `detail` shows in a smaller font under the main message. Perfect
        // place to surface the AI-generated code so the user can re-read it
        // before answering.
        detail: payload.code,
    }, 'Answer', 'Skip', 'Override');
    if (choice === 'Skip') {
        void (0, recorder_1.recordEvent)('checkpoint_dismissed', {
            region_id: payload.regionId,
            source: 'native_skip',
        });
        return;
    }
    if (choice === 'Override') {
        regionTracker_1.regionTracker.markStatus([payload.regionId], 'overridden');
        void (0, recorder_1.recordEvent)('checkpoint_overridden', {
            region_id: payload.regionId,
            source: 'native_override',
        });
        vscode.window.showWarningMessage(`VibeCheck: ${location} marked as overridden without verification.`);
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
        validateInput: (val) => val.trim().length < 10
            ? 'Type a real explanation (at least ~10 characters).'
            : null,
    });
    if (answer === undefined) {
        // User pressed Esc — no-op, region stays unverified.
        return;
    }
    let score;
    try {
        score = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'VibeCheck: grading with Gemma…',
            cancellable: false,
        }, async () => {
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
            const json = (await res.json());
            return json.score;
        });
    }
    catch (err) {
        vscode.window.showErrorMessage(`VibeCheck: ${err instanceof Error ? err.message : String(err)}`);
        return;
    }
    await showResult(payload, score);
}
async function showResult(payload, score) {
    const fmt = (n) => (typeof n === 'number' ? n.toFixed(2) : '—');
    const scoreLine = `What it does ${fmt(score.what_it_does)} · Why ${fmt(score.why_this_approach)} · Tradeoffs ${fmt(score.tradeoffs)} · Overall ${fmt(score.overall)}`;
    if (score.passed) {
        regionTracker_1.regionTracker.markStatus([payload.regionId], 'passed');
        vscode.window.showInformationMessage(`✓ VibeCheck passed (${fmt(score.overall)}). ${score.feedback}`, { modal: false });
        return;
    }
    // Failed — give the user the feedback + follow-up + a way out.
    const followUp = score.follow_up_question
        ? `\n\nFollow-up: ${score.follow_up_question}`
        : '';
    const retry = await vscode.window.showWarningMessage(`✗ Not quite (${fmt(score.overall)})\n\n${score.feedback}${followUp}`, { modal: true, detail: scoreLine }, 'Try again', 'Override anyway');
    if (retry === 'Try again') {
        // Recurse with the SAME payload so the same question is re-asked.
        await runNativeCheckpoint(payload);
    }
    else if (retry === 'Override anyway') {
        regionTracker_1.regionTracker.markStatus([payload.regionId], 'overridden');
        void (0, recorder_1.recordEvent)('checkpoint_overridden', {
            region_id: payload.regionId,
            source: 'native_failed_override',
        });
        vscode.window.showWarningMessage(`VibeCheck: region marked as overridden after failed check.`);
    }
    // Else: user dismissed → region stays unverified, can be retried later.
}
//# sourceMappingURL=nativeUi.js.map