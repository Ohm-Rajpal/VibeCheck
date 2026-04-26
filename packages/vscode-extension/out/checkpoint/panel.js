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
        currentPanel.webview.onDidReceiveMessage((message) => {
            handlePanelMessage(message);
        });
    }
    currentPanel.webview.html = renderHtml(sessionId, questions, trigger);
    return currentPanel;
}
function renderHtml(sessionId, questions, trigger) {
    const safeQuestions = escapeHtml(JSON.stringify(questions, null, 2));
    return `<!doctype html>
<html><body style="font-family:system-ui;padding:24px;color:#eee;background:#1e1e1e">
  <h2>🧠 VibeCheck — ${trigger}</h2>
  <p>Session: <code>${sessionId}</code></p>
  <div style="display:flex;gap:8px;margin-bottom:12px">
    <button id="passBtn" style="padding:8px 12px;background:#2e7d32;color:#fff;border:none;border-radius:6px;cursor:pointer">Mark Pass</button>
    <button id="failBtn" style="padding:8px 12px;background:#b71c1c;color:#fff;border:none;border-radius:6px;cursor:pointer">Mark Fail</button>
  </div>
  <p id="status" style="color:#ccc"></p>
  <pre>${safeQuestions}</pre>
  <script>
    const vscode = acquireVsCodeApi();
    const status = document.getElementById('status');
    document.getElementById('passBtn').addEventListener('click', () => {
      vscode.postMessage({ type: 'pass' });
      status.textContent = 'Sent PASS signal...';
    });
    document.getElementById('failBtn').addEventListener('click', () => {
      vscode.postMessage({ type: 'fail' });
      status.textContent = 'Sent FAIL signal...';
    });
  </script>
</body></html>`;
}
function handlePanelMessage(message) {
    const msg = (message ?? {});
    if (msg.type !== 'pass' && msg.type !== 'fail') {
        return;
    }
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
        vscode.window.showErrorMessage('VibeCheck: open a workspace before signaling pre-commit pass/fail.');
        return;
    }
    const passFileName = process.env.PASS_FILE || '.vibecheck-pass.tmp';
    const failFileName = process.env.FAIL_FILE || '.vibecheck-fail.tmp';
    const passPath = path.join(workspaceRoot, passFileName);
    const failPath = path.join(workspaceRoot, failFileName);
    try {
        if (msg.type === 'pass') {
            fs.writeFileSync(passPath, `pass ${new Date().toISOString()}\n`, 'utf8');
            if (fs.existsSync(failPath)) {
                fs.unlinkSync(failPath);
            }
            vscode.window.showInformationMessage('VibeCheck: PASS signal created. Commit can continue.');
            return;
        }
        fs.writeFileSync(failPath, `fail ${new Date().toISOString()}\n`, 'utf8');
        if (fs.existsSync(passPath)) {
            fs.unlinkSync(passPath);
        }
        vscode.window.showWarningMessage('VibeCheck: FAIL signal created. Commit will be blocked.');
    }
    catch (error) {
        const messageText = error instanceof Error ? error.message : 'unknown file system error';
        vscode.window.showErrorMessage(`VibeCheck: failed to write signal file: ${messageText}`);
    }
}
function escapeHtml(value) {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
//# sourceMappingURL=panel.js.map