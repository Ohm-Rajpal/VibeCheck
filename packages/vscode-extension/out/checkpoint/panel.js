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
let currentPanel;
function openCheckpointPanel(context, sessionId, questions, trigger) {
    if (currentPanel) {
        currentPanel.reveal(vscode.ViewColumn.Beside);
    }
    else {
        currentPanel = vscode.window.createWebviewPanel('vibecheckCheckpoint', 'VibeCheck — Comprehension Check', vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true });
        currentPanel.onDidDispose(() => {
            currentPanel = undefined;
        });
    }
    currentPanel.webview.html = renderHtml(sessionId, questions, trigger);
    // TODO: wire postMessage handlers (PASS / OVERRIDE / SUBMIT_TRANSCRIPT).
    return currentPanel;
}
function renderHtml(sessionId, questions, trigger) {
    // TODO: replace with built webview bundle from webview/dist.
    return `<!doctype html>
<html><body style="font-family:system-ui;padding:24px;color:#eee;background:#1e1e1e">
  <h2>🧠 VibeCheck — ${trigger}</h2>
  <p>Session: <code>${sessionId}</code></p>
  <pre>${JSON.stringify(questions, null, 2)}</pre>
  <p><i>Webview UI not yet built.</i></p>
</body></html>`;
}
//# sourceMappingURL=panel.js.map