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
exports.launchCheckpointForRegion = launchCheckpointForRegion;
exports.launchCheckpointForFirstUnverified = launchCheckpointForFirstUnverified;
const vscode = __importStar(require("vscode"));
const regionTracker_1 = require("../detection/regionTracker");
const commentThreads_1 = require("./commentThreads");
const nativeUi_1 = require("./nativeUi");
const panel_1 = require("./panel");
const BACKEND_URL = process.env.VIBECHECK_BACKEND_URL ?? 'http://localhost:8000';
const LANG_BY_EXT = {
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
function inferLanguage(filePath) {
    const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
    return LANG_BY_EXT[ext] ?? 'unknown';
}
function basename(filePath) {
    return filePath.split('/').pop() ?? filePath;
}
async function fetchQuestion(region, sessionId) {
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
    const json = (await res.json());
    return {
        question: json.question,
        conceptTag: json.concept_tag || 'design choice',
    };
}
function fetchQuestionUntilReady(region, sessionId, attempt = 0) {
    void fetchQuestion(region, sessionId)
        .then(({ question, conceptTag }) => {
        (0, commentThreads_1.attachQuestion)(region.id, question, conceptTag);
    })
        .catch((err) => {
        console.warn('[VibeCheck] question fetch failed:', err);
        if (!(0, commentThreads_1.hasCheckpointThread)(region.id)) {
            return;
        }
        const delay = Math.min(10000, 1000 + attempt * 1000);
        setTimeout(() => fetchQuestionUntilReady(region, sessionId, attempt + 1), delay);
    });
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
async function launchCheckpointForRegion(context, region, trigger, sessionId = region.burstId) {
    const ui = vscode.workspace
        .getConfiguration('vibecheck')
        .get('checkpointUi', 'comments');
    // ── Comments mode: OPTIMISTIC. Open the thread instantly with a
    // "generating…" placeholder, then fetch the real question in the
    // background and patch it in. User sees the panel < 50ms instead of
    // waiting on Gemma.
    if (ui === 'comments') {
        await (0, commentThreads_1.createPendingCheckpointThread)({
            regionId: region.id,
            sessionId,
            file: region.file,
            startLine: region.startLine,
            endLine: region.endLine,
            code: region.text,
        });
        fetchQuestionUntilReady(region, sessionId);
        return;
    }
    // ── Native + webview modes: BLOCKING (they can't render without the
    // question). Keep the original synchronous flow.
    const { question, conceptTag } = await fetchQuestion(region, sessionId);
    const payload = {
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
        await (0, panel_1.openCheckpointPanel)(context, payload);
    }
    else {
        await (0, nativeUi_1.runNativeCheckpoint)(payload);
    }
}
/**
 * Open a checkpoint for the FIRST unverified region in the workspace.
 * Used by the status bar click + manual command. No-op (with a friendly
 * info message) if nothing is unverified.
 */
async function launchCheckpointForFirstUnverified(context, trigger) {
    const unverified = regionTracker_1.regionTracker.getUnverified();
    if (unverified.length === 0) {
        vscode.window.showInformationMessage('VibeCheck: nothing to check — no unverified AI regions.');
        return;
    }
    await launchCheckpointForRegion(context, unverified[0], trigger, `manual-${Date.now()}`);
}
//# sourceMappingURL=launcher.js.map