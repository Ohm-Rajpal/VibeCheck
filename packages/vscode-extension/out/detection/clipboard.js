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
exports.refreshClipboardSnapshot = refreshClipboardSnapshot;
exports.looksLikePaste = looksLikePaste;
const vscode = __importStar(require("vscode"));
// Snapshot of the most recently observed clipboard contents. We keep this
// in-memory so paste detection is O(1) and doesn't await on every keystroke.
let lastClipboard = '';
async function refreshClipboardSnapshot() {
    try {
        lastClipboard = (await vscode.env.clipboard.readText()) ?? '';
    }
    catch {
        lastClipboard = '';
    }
}
// Returns true if the inserted text matches the current clipboard contents,
// strongly suggesting a human paste rather than an AI generation.
function looksLikePaste(insertedText) {
    if (!insertedText || !lastClipboard)
        return false;
    // Exact match — most pastes preserve content verbatim.
    if (insertedText === lastClipboard)
        return true;
    // Trimmed match — editors sometimes strip trailing whitespace.
    if (insertedText.trim() === lastClipboard.trim())
        return true;
    return false;
}
//# sourceMappingURL=clipboard.js.map