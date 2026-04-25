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
exports.activateDecorator = activateDecorator;
const vscode = __importStar(require("vscode"));
const regionTracker_1 = require("./regionTracker");
// Three styles so the engineer can see at a glance which AI-touched regions
// they still owe a checkpoint on.
let unverifiedDeco;
let passedDeco;
let overriddenDeco;
function activateDecorator(context) {
    unverifiedDeco = vscode.window.createTextEditorDecorationType({
        backgroundColor: 'rgba(255, 200, 0, 0.10)',
        borderWidth: '0 0 0 2px',
        borderStyle: 'solid',
        borderColor: 'rgba(255, 200, 0, 0.7)',
        isWholeLine: true,
        overviewRulerColor: 'rgba(255, 200, 0, 0.7)',
        overviewRulerLane: vscode.OverviewRulerLane.Right,
        after: {
            contentText: '  🧠 AI — needs check',
            color: 'rgba(255, 200, 0, 0.6)',
            margin: '0 0 0 2em',
        },
    });
    passedDeco = vscode.window.createTextEditorDecorationType({
        backgroundColor: 'rgba(74, 222, 128, 0.08)',
        borderWidth: '0 0 0 2px',
        borderStyle: 'solid',
        borderColor: 'rgba(74, 222, 128, 0.6)',
        isWholeLine: true,
        overviewRulerColor: 'rgba(74, 222, 128, 0.6)',
        overviewRulerLane: vscode.OverviewRulerLane.Right,
    });
    overriddenDeco = vscode.window.createTextEditorDecorationType({
        backgroundColor: 'rgba(239, 68, 68, 0.08)',
        borderWidth: '0 0 0 2px',
        borderStyle: 'solid',
        borderColor: 'rgba(239, 68, 68, 0.6)',
        isWholeLine: true,
        overviewRulerColor: 'rgba(239, 68, 68, 0.6)',
        overviewRulerLane: vscode.OverviewRulerLane.Right,
    });
    context.subscriptions.push(unverifiedDeco, passedDeco, overriddenDeco, vscode.window.onDidChangeActiveTextEditor((ed) => ed && refresh(ed)), vscode.workspace.onDidOpenTextDocument(() => refreshAll()), regionTracker_1.regionTracker.onChange(() => refreshAll()));
    refreshAll();
}
function refreshAll() {
    for (const ed of vscode.window.visibleTextEditors)
        refresh(ed);
}
function refresh(editor) {
    const file = editor.document.fileName;
    const regions = regionTracker_1.regionTracker.getForFile(file);
    const ranges = (status) => regions
        .filter((r) => r.status === status)
        .map((r) => new vscode.Range(new vscode.Position(r.startLine, 0), new vscode.Position(r.endLine, Number.MAX_SAFE_INTEGER)));
    editor.setDecorations(unverifiedDeco, ranges('unverified'));
    editor.setDecorations(passedDeco, ranges('passed'));
    editor.setDecorations(overriddenDeco, ranges('overridden'));
}
//# sourceMappingURL=decorator.js.map