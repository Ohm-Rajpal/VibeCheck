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
exports.openCheckpointPanel = openCheckpointPanel;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const regionTracker_1 = require("../detection/regionTracker");
const recorder_1 = require("../metrics/recorder");
const BACKEND_URL = process.env.VIBECHECK_BACKEND_URL ?? 'http://localhost:8000';
let currentPanel;
let currentPayload;
async function openCheckpointPanel(context, payload) {
    if (currentPanel) {
        currentPanel.reveal(vscode.ViewColumn.Beside);
    }
    else {
        currentPanel = vscode.window.createWebviewPanel('vibecheckCheckpoint', 'VibeCheck — Comprehension Check', vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true });
        currentPanel.onDidDispose(() => {
            currentPanel = undefined;
            currentPayload = undefined;
        });
        currentPanel.webview.onDidReceiveMessage(async (msg) => {
            const panel = currentPanel;
            const payload = currentPayload;
            if (!panel || !payload)
                return;
            try {
                await handleMessage(panel, payload, msg);
            }
            catch (err) {
                const reply = {
                    type: 'SCORE',
                    checkpointId: payload.regionId,
                    score: {
                        passed: false,
                        value: 0,
                        feedback: err instanceof Error ? err.message : String(err),
                    },
                };
                panel.webview.postMessage(reply);
            }
        });
    }
    currentPayload = payload;
    currentPanel.title = `VibeCheck — ${payload.fileShort}:${payload.startLine + 1}-${payload.endLine + 1}`;
    currentPanel.webview.html = renderHtml(context, payload);
    return currentPanel;
}
async function handleMessage(panel, payload, msg) {
    switch (msg.type) {
        case 'PASS':
            regionTracker_1.regionTracker.markStatus([payload.regionId], 'passed');
            vscode.window.showInformationMessage(`✅ VibeCheck: marked ${msg.checkpointId} as understood.`);
            break;
        case 'OVERRIDE':
            regionTracker_1.regionTracker.markStatus([payload.regionId], 'overridden');
            void (0, recorder_1.recordEvent)('checkpoint_overridden', {
                region_id: payload.regionId,
                source: 'webview_override',
                reason: msg.reason,
            });
            vscode.window.showWarningMessage(`⚠️ VibeCheck overridden: ${msg.reason}`);
            panel.dispose();
            break;
        case 'SUBMIT_TRANSCRIPT':
            await handleSubmit(panel, payload, msg.checkpointId, msg.transcript);
            break;
        case 'CLOSE':
            currentPanel?.dispose();
            break;
    }
}
async function handleSubmit(panel, payload, checkpointId, transcript) {
    const text = transcript.trim();
    if (!text) {
        const reply = {
            type: 'SCORE',
            checkpointId,
            score: {
                passed: false,
                value: 0,
                feedback: 'Type a few sentences explaining the design choice.',
            },
        };
        panel.webview.postMessage(reply);
        return;
    }
    void (0, recorder_1.recordEvent)('answer_submitted', {
        region_id: payload.regionId,
        source: 'webview',
        char_count: text.length,
    });
    const res = await fetch(`${BACKEND_URL}/gate/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            session_id: payload.sessionId,
            checkpoint_id: payload.regionId,
            transcript: text,
            file: payload.fileShort,
            diff_excerpt: payload.code,
        }),
    });
    if (!res.ok) {
        throw new Error(`verify failed (${res.status}): ${await res.text()}`);
    }
    const json = (await res.json());
    const reply = {
        type: 'SCORE',
        checkpointId,
        score: json.score,
    };
    panel.webview.postMessage(reply);
    if (json.score.passed) {
        regionTracker_1.regionTracker.markStatus([payload.regionId], 'passed');
        void (0, recorder_1.recordEvent)('answer_passed', {
            region_id: payload.regionId,
            source: 'webview',
            overall: json.score.overall,
        });
    }
}
function renderHtml(context, payload) {
    const distPath = path.join(context.extensionPath, 'webview', 'dist', 'index.html');
    let html;
    try {
        html = fs.readFileSync(distPath, 'utf8');
    }
    catch {
        return fallbackHtml(payload);
    }
    const questions = [
        {
            question: payload.question,
            concept_tag: payload.conceptTag,
            code_context: `${payload.fileShort}:${payload.startLine + 1}-${payload.endLine + 1}`,
            file: payload.fileShort,
            checkpoint_id: payload.regionId,
        },
    ];
    const initJson = JSON.stringify({
        sessionId: payload.sessionId,
        questions,
        trigger: payload.trigger,
    })
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026');
    const inject = `<script>
  window.__VIBECHECK_VIEW__ = 'checkpoint';
  window.__VIBECHECK_INIT__ = ${initJson};
</script>`;
    // Insert the init script just before </head> so it runs before the bundle.
    if (html.includes('</head>')) {
        return html.replace('</head>', `${inject}</head>`);
    }
    // Fallback: prepend if no <head> tag.
    return inject + html;
}
function fallbackHtml(payload) {
    const location = `${payload.fileShort}:${payload.startLine + 1}-${payload.endLine + 1}`;
    return `<!doctype html>
<html><body style="font-family:system-ui;padding:24px;color:#eee;background:#1e1e1e">
  <h2>🧠 VibeCheck — ${escapeHtml(payload.trigger)}</h2>
  <p>Session: <code>${escapeHtml(payload.sessionId)}</code></p>
  <p><strong>${escapeHtml(location)}</strong></p>
  <p>${escapeHtml(payload.question)}</p>
  <pre>${escapeHtml(payload.code)}</pre>
  <p><i>Webview bundle not built. Run <code>npm run build:webview</code> from the repo root.</i></p>
</body></html>`;
}
function escapeHtml(s) {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
//# sourceMappingURL=panel.js.map