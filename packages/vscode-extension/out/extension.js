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
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const http = __importStar(require("http"));
const velocityDetector_1 = require("./detection/velocityDetector");
const decorator_1 = require("./detection/decorator");
const regionTracker_1 = require("./detection/regionTracker");
const launcher_1 = require("./checkpoint/launcher");
const commentThreads_1 = require("./checkpoint/commentThreads");
const sidebar_1 = require("./growth/sidebar");
const recorder_1 = require("./metrics/recorder");
const vibeBar_1 = require("./status/vibeBar");
const CHECKPOINT_PORT = Number(process.env.CHECKPOINT_PORT ?? 3456);
function activate(context) {
    console.log('[VibeCheck] activate() called');
    console.log('[VibeCheck] extensionPath:', context.extensionPath);
    console.log('[VibeCheck] compiled __dirname:', __dirname);
    // 1. Local HTTP server: receives notifications from pre-commit hook + Devin webhook.
    // The hook just pings us with a trigger; we then open a checkpoint for the
    // first unverified region in the workspace. Region picking + question
    // generation is owned by the launcher so the HTTP path stays a thin shim.
    const server = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/checkpoint') {
            let body = '';
            req.on('data', (chunk) => (body += chunk));
            req.on('end', async () => {
                try {
                    const { trigger } = JSON.parse(body || '{}');
                    await (0, launcher_1.launchCheckpointForFirstUnverified)(context, trigger || 'pre_commit');
                    res.writeHead(200);
                    res.end('ok');
                }
                catch (err) {
                    res.writeHead(400);
                    res.end(`bad payload: ${err instanceof Error ? err.message : err}`);
                }
            });
            return;
        }
        res.writeHead(404);
        res.end();
    });
    server.listen(CHECKPOINT_PORT);
    context.subscriptions.push({ dispose: () => server.close() });
    // 2. Layer 1 — velocity detector + visual decorator + inline comment
    // threads. The comment controller MUST activate before the velocity
    // detector creates regions, since the launcher will try to attach
    // threads to those regions immediately.
    (0, commentThreads_1.activateCommentThreads)(context);
    (0, velocityDetector_1.activateVelocityDetector)(context);
    (0, decorator_1.activateDecorator)(context);
    // 3. Status bar counter — total unverified AI regions across the workspace.
    const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBar.command = 'vibecheck.openCheckpoint';
    context.subscriptions.push(statusBar, regionTracker_1.regionTracker.onChange(() => updateStatusBar(statusBar, context.extensionPath)), (0, recorder_1.onSummaryChange)((summary) => {
        currentSummary = summary;
        updateStatusBar(statusBar, context.extensionPath);
    }));
    updateStatusBar(statusBar, context.extensionPath);
    statusBar.show();
    // 4. Vibing / Learning gauge — two bars in the bottom-right status area.
    (0, vibeBar_1.activateVibeBar)(context);
    // 5. Growth dashboard sidebar.
    (0, sidebar_1.activateGrowthSidebar)(context);
    // 6. Commands.
    context.subscriptions.push(vscode.commands.registerCommand('vibecheck.showGrowth', () => {
        vscode.commands.executeCommand('workbench.view.extension.vibecheck');
    }), vscode.commands.registerCommand('vibecheck.resetMetrics', async () => {
        // Confirm before nuking — even though it's scoped to this user's
        // events, undo isn't available once Mongo deletes the docs.
        const confirm = await vscode.window.showWarningMessage('Reset all VibeCheck metrics for this machine? ' +
            'This deletes every recorded event from the database. ' +
            'Other users on this MongoDB cluster are unaffected.', { modal: true }, 'Reset');
        if (confirm !== 'Reset') {
            return;
        }
        // Wipe in-memory unverified regions too so the yellow margin
        // highlights, the "N unverified" status-bar counter, and the
        // decorator stripes clear at the same instant the gauges zero
        // out. Without this, the gauges would say "no data" while the
        // editor still shows leftover unverified regions from before
        // the reset.
        regionTracker_1.regionTracker.clearAll();
        const result = await (0, recorder_1.resetMetrics)();
        if (result.ok) {
            // Two distinct success messages so the user knows whether the
            // reset also produced a session snapshot for the trend chart.
            const snapshotMsg = result.snapshotted
                ? ' Session snapshot saved to history.'
                : '';
            vscode.window.showInformationMessage(`VibeCheck: metrics reset (${result.deleted} events deleted).` +
                snapshotMsg);
        }
        else {
            // Optimistic broadcast already zeroed the gauges locally, so the
            // UI is still in the expected state — but the server didn't
            // confirm. Surface that so the user knows to investigate.
            vscode.window.showWarningMessage('VibeCheck: gauges cleared locally, but the backend did not ' +
                'confirm the delete. Check the API server is running.');
        }
    }), vscode.commands.registerCommand('vibecheck.simulateAIBurst', async () => {
        // Find a usable text editor — `activeTextEditor` is undefined when
        // focus is on a webview/panel, so fall back to any visible editor.
        let editor = vscode.window.activeTextEditor;
        if (!editor) {
            editor = vscode.window.visibleTextEditors[0];
        }
        if (!editor) {
            vscode.window.showWarningMessage('Open a file first, then run "VibeCheck: Simulate AI Burst".');
            return;
        }
        // Reset cooldown + active-burst state so repeated invocations always
        // fire a fresh toast, regardless of how recently a real burst happened.
        (0, velocityDetector_1.resetDetectorForTest)();
        // Brief delay so the reset's "lastChangeTime=0" propagates into the
        // detector's idle calculation (the editor.edit fires synchronously).
        await new Promise((r) => setTimeout(r, 50));
        // Auth-helper sample (clean, no bugs — interesting design
        // choices). Gemma's question prompt is tuned to find specific
        // implementation choices, so a buggy sample makes the answer
        // obvious ("yeah, that's the bug"). With clean code Gemma asks
        // *why* a choice was made (refresh window, delete-on-expiry,
        // crypto.randomUUID), which forces real reasoning. Override
        // becomes a tradeoff disagreement, not a bug fix.
        const sample = [
            '',
            '// Inserted by vibecheck.simulateAIBurst for detection-pipeline testing.',
            '// Delete after verifying the toast.',
            'const REFRESH_WINDOW_MS = 5 * 60 * 1000;',
            'const SESSION_LIFETIME_MS = 60 * 60 * 1000;',
            'const sessions: Map<string, { token: string; expiresAt: number }> = new Map();',
            '',
            'function login(userId: string, password: string): string | null {',
            '  if (!password) return null;',
            '  const token = crypto.randomUUID();',
            '  sessions.set(userId, { token, expiresAt: Date.now() + SESSION_LIFETIME_MS });',
            '  return token;',
            '}',
            '',
            'function isAuthenticated(userId: string, token: string): boolean {',
            '  const session = sessions.get(userId);',
            '  if (!session) return false;',
            '  if (session.token !== token) return false;',
            '  if (session.expiresAt <= Date.now()) {',
            '    sessions.delete(userId);',
            '    return false;',
            '  }',
            '  return true;',
            '}',
            '',
            'function refresh(userId: string, token: string): string | null {',
            '  const session = sessions.get(userId);',
            '  if (!session || session.token !== token) return null;',
            '  if (session.expiresAt - Date.now() > REFRESH_WINDOW_MS) return null;',
            '  const newToken = crypto.randomUUID();',
            '  sessions.set(userId, { token: newToken, expiresAt: Date.now() + SESSION_LIFETIME_MS });',
            '  return newToken;',
            '}',
            '',
        ].join('\n');
        const pos = editor.selection.active;
        await editor.edit((builder) => builder.insert(pos, sample));
    }), vscode.commands.registerCommand('vibecheck.openCheckpoint', async () => {
        try {
            await (0, launcher_1.launchCheckpointForFirstUnverified)(context, 'manual');
        }
        catch (err) {
            vscode.window.showErrorMessage(`VibeCheck: ${err instanceof Error ? err.message : err}`);
        }
    }));
}
function updateStatusBar(item, extensionPath) {
    const { unverified, files } = regionTracker_1.regionTracker.stats();
    const metrics = latestMetricText();
    if (unverified === 0) {
        item.text = `$(pulse) VibeCheck: clean · ${metrics}`;
        item.tooltip = new vscode.MarkdownString(`No unverified AI regions.\n\n` +
            `**Metrics:** ${metrics}\n\n` +
            `**Loaded extension path:**\n\n\`${extensionPath}\`\n\n` +
            `If you do not see ${VIBING_ICON}/${LEARNING_ICON}/${COOKING_ICON} in this status item, the Extension Host is loading stale code.`);
        item.backgroundColor = undefined;
    }
    else {
        item.text = `$(pulse) ${unverified} unverified · ${metrics}`;
        item.tooltip = new vscode.MarkdownString(`Click to open checkpoint panel for ${unverified} unverified AI region${unverified === 1 ? '' : 's'} across ${files} file${files === 1 ? '' : 's'}.\n\n` +
            `**Metrics:** ${metrics}\n\n` +
            `**Loaded extension path:**\n\n\`${extensionPath}\``);
        item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }
}
function latestMetricText() {
    const summary = currentSummary;
    if (!summary || summary.generated === 0) {
        return `${VIBING_ICON}– ${LEARNING_ICON}– ${COOKING_ICON}–`;
    }
    return `${VIBING_ICON}${summary.vibing_pct}% ${LEARNING_ICON}${summary.learning_pct}% ${COOKING_ICON}${summary.cooking_pct}%`;
}
let currentSummary;
const VIBING_ICON = '\u{1F60E}';
const LEARNING_ICON = '\u{1F913}';
const COOKING_ICON = '\u{1F680}';
function deactivate() { }
//# sourceMappingURL=extension.js.map