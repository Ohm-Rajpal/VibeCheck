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
exports.activateVelocityDetector = activateVelocityDetector;
exports.getPendingChanges = getPendingChanges;
const vscode = __importStar(require("vscode"));
const AI_LINE_THRESHOLD = 8;
const AI_TIME_THRESHOLD_MS = 250;
let lastChangeTime = Date.now();
const pendingChanges = [];
function activateVelocityDetector(context) {
    const sub = vscode.workspace.onDidChangeTextDocument(async (event) => {
        const change = event.contentChanges[0];
        if (!change)
            return;
        const linesAdded = change.text.split('\n').length;
        const elapsed = Date.now() - lastChangeTime;
        const isAIBurst = linesAdded > AI_LINE_THRESHOLD && elapsed < AI_TIME_THRESHOLD_MS;
        lastChangeTime = Date.now();
        if (!isAIBurst)
            return;
        pendingChanges.push({
            file: event.document.fileName,
            lines: `${change.range.start.line}-${change.range.end.line}`,
            content: change.text,
            timestamp: Date.now(),
            answered: false,
        });
        // TODO: call backend /gate/generate (mode=inline) and show toast.
        vscode.window.showInformationMessage(`🧠 VibeCheck: AI just wrote ${linesAdded} lines. Quick check?`, 'Answer Now', 'Skip');
    });
    context.subscriptions.push(sub);
}
function getPendingChanges() {
    return pendingChanges;
}
//# sourceMappingURL=velocityDetector.js.map