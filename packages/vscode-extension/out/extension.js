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
const panel_1 = require("./checkpoint/panel");
const sidebar_1 = require("./growth/sidebar");
const gitDiffAst_1 = require("./analysis/gitDiffAst");
const CHECKPOINT_PORT = Number(process.env.CHECKPOINT_PORT ?? 3456);
function activate(context) {
    console.log('[VibeCheck] activate() called');
    console.log('[VibeCheck] activate() called');
    // 1. Local HTTP server: receives notifications from pre-commit hook + Devin webhook.
    const server = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/checkpoint') {
            let body = '';
            req.on('data', (chunk) => (body += chunk));
            req.on('end', () => {
                try {
                    const { session_id, questions, trigger } = JSON.parse(body);
                    (0, panel_1.openCheckpointPanel)(context, session_id, questions, trigger);
                    res.writeHead(200);
                    res.end('ok');
                }
                catch {
                    res.writeHead(400);
                    res.end('bad payload');
                }
            });
            return;
        }
        res.writeHead(404);
        res.end();
    });
    server.listen(CHECKPOINT_PORT);
    context.subscriptions.push({ dispose: () => server.close() });
    // 2. Layer 1 — velocity detector + visual decorator.
    (0, velocityDetector_1.activateVelocityDetector)(context);
    (0, decorator_1.activateDecorator)(context);
    // 3. Status bar counter — total unverified AI regions across the workspace.
    const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBar.command = 'vibecheck.openCheckpoint';
    context.subscriptions.push(statusBar, regionTracker_1.regionTracker.onChange(() => updateStatusBar(statusBar)));
    updateStatusBar(statusBar);
    statusBar.show();
    // 4. Growth dashboard sidebar.
    (0, sidebar_1.activateGrowthSidebar)(context);
    // 5. Commands.
    context.subscriptions.push(vscode.commands.registerCommand('vibecheck.showGrowth', () => {
        vscode.commands.executeCommand('workbench.view.extension.vibecheck');
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
        const sample = [
            '',
            'function simulatedAIFunction(input: string): string {',
            '  // This block was inserted by vibecheck.simulateAIBurst for',
            '  // detection-pipeline testing. Delete after verifying the toast.',
            '  const trimmed = input.trim();',
            '  if (!trimmed) return "empty";',
            '  const result = trimmed',
            '    .split(/\\s+/)',
            '    .map((word) => word.toLowerCase())',
            '    .filter((w) => w.length > 2)',
            '    .join("-");',
            '  return result || "no-significant-tokens";',
            '}',
            '',
            'class SimulatedAIClass {',
            '  constructor(private readonly seed: number) {}',
            '  next(): number {',
            '    return (this.seed * 9301 + 49297) % 233280;',
            '  }',
            '}',
            '',
        ].join('\n');
        const pos = editor.selection.active;
        await editor.edit((builder) => builder.insert(pos, sample));
    }), vscode.commands.registerCommand('vibecheck.openCheckpoint', () => {

        const regions = regionTracker_1.regionTracker.getUnverified();
        const questions = regions.map((r) => ({
            question: `Walk me through ${r.file.split('/').pop()}:${r.startLine + 1}-${r.endLine + 1}.`,
            concept_tag: 'general comprehension',
            code_context: `${r.file.split('/').pop()}:${r.startLine + 1}-${r.endLine + 1}`,
            file: r.file.split('/').pop() ?? r.file,
        }));
        (0, panel_1.openCheckpointPanel)(context, `manual-${Date.now()}`, questions.length ? questions : [], 'pre_commit');

    }), vscode.commands.registerCommand('vibecheck.analyzeGitDiff', () => {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
            vscode.window.showErrorMessage('VibeCheck: Open a workspace folder to analyze git diff.');
            return;
        }
        try {
            const questions = (0, gitDiffAst_1.generateQuestionsFromGitDiff)(workspaceRoot);
            (0, panel_1.openCheckpointPanel)(context, `git-diff-${Date.now()}`, questions, 'pre_commit');
            vscode.window.showInformationMessage(`VibeCheck: Generated ${questions.length} AST-based question(s) from git diff.`);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown analysis error';
            vscode.window.showErrorMessage(`VibeCheck: Failed to analyze git diff: ${message}`);
        }
    }));
}
function updateStatusBar(item) {
    const { unverified, files } = regionTracker_1.regionTracker.stats();
    if (unverified === 0) {
        item.text = '$(pulse) VibeCheck: clean';
        item.tooltip = 'No unverified AI regions.';
        item.backgroundColor = undefined;
    }
    else {
        item.text = `$(pulse) ${unverified} unverified · ${files} file${files === 1 ? '' : 's'}`;
        item.tooltip = 'Click to open checkpoint panel for unverified AI regions.';
        item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }
}
function deactivate() { }
//# sourceMappingURL=extension.js.map