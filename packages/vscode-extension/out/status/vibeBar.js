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
exports.activateVibeBar = activateVibeBar;
const vscode = __importStar(require("vscode"));
const recorder_1 = require("../metrics/recorder");
/**
 * Two persistent status-bar items on the bottom-right:
 *
 *   🔥 Vibing   ▰▰▱▱▱▱ 33%
 *   🧠 Learning ▰▰▰▰▱▱ 67%
 *
 * Updates live on every event via the recorder's pub/sub. The bars
 * paint the status-bar background red/green when one side dominates,
 * giving a peripheral-vision gauge without opening a dashboard.
 */
const BAR_WIDTH = 6;
const FILLED = '▰';
const EMPTY = '▱';
function bar(pct) {
    // Round up so 1% still shows one filled cell — the first event after
    // a long idle would otherwise look like nothing happened.
    const filled = Math.max(0, Math.min(BAR_WIDTH, Math.ceil((pct / 100) * BAR_WIDTH)));
    return FILLED.repeat(filled) + EMPTY.repeat(BAR_WIDTH - filled);
}
function activateVibeBar(context) {
    // For StatusBarAlignment.Right, higher priority renders FURTHER LEFT.
    // The pre-existing "unverified regions" bar is at priority 100, so
    // we sit just to its right at 98/97.
    const vibing = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
    const learning = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 97);
    vibing.command = 'vibecheck.showGrowth';
    learning.command = 'vibecheck.showGrowth';
    const render = (s) => {
        if (!s || s.generated === 0) {
            // Cold-start — communicate "no data" rather than 0%, which would
            // misleadingly imply "100% learning".
            vibing.text = `$(flame) Vibing ${bar(0)} –`;
            vibing.tooltip = new vscode.MarkdownString('**VibeCheck — Vibing %**\n\nAI code regions you never engaged with.\n\nNo activity yet.');
            vibing.backgroundColor = undefined;
            learning.text = `$(mortar-board) Learning ${bar(0)} –`;
            learning.tooltip = new vscode.MarkdownString('**VibeCheck — Learning %**\n\nAI code you answered or consciously overrode.\n\nNo activity yet.');
            learning.backgroundColor = undefined;
        }
        else {
            vibing.text = `$(flame) Vibing ${bar(s.vibing_pct)} ${s.vibing_pct}%`;
            vibing.tooltip = buildTooltip('vibing', s);
            vibing.backgroundColor =
                s.vibing_pct > 50
                    ? new vscode.ThemeColor('statusBarItem.errorBackground')
                    : undefined;
            learning.text = `$(mortar-board) Learning ${bar(s.learning_pct)} ${s.learning_pct}%`;
            learning.tooltip = buildTooltip('learning', s);
            learning.backgroundColor =
                s.learning_pct >= 50
                    ? new vscode.ThemeColor('statusBarItem.prominentBackground')
                    : undefined;
        }
        vibing.show();
        learning.show();
    };
    context.subscriptions.push(vibing, learning, (0, recorder_1.onSummaryChange)(render));
    render(undefined);
    void (0, recorder_1.refreshSummary)();
}
function buildTooltip(which, s) {
    const md = new vscode.MarkdownString();
    md.supportThemeIcons = true;
    const title = which === 'vibing' ? '**$(flame) Vibing %**' : '**$(mortar-board) Learning %**';
    md.appendMarkdown(`${title}\n\n`);
    md.appendMarkdown(which === 'vibing'
        ? "Share of AI-authored regions you haven't engaged with " +
            '(ignored, dismissed, or still pending).\n\n'
        : 'Share of AI-authored regions you answered or consciously ' +
            'overrode.\n\n');
    md.appendMarkdown(`| | count |\n` +
        `|---|---:|\n` +
        `| AI generations detected | ${s.generated} |\n` +
        `| Engaged (answered + overridden) | ${s.reviewed} |\n` +
        `| Passed first try | ${s.passed_first_try} (${s.first_try_rate_pct}%) |\n` +
        `| Total submissions | ${s.submitted} |\n` +
        `| Dismissed / skipped | ${s.dismissed} |\n`);
    return md;
}
//# sourceMappingURL=vibeBar.js.map