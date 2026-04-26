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
exports.onSummaryChange = onSummaryChange;
exports.getLatestSummary = getLatestSummary;
exports.recordEvent = recordEvent;
exports.refreshSummary = refreshSummary;
const vscode = __importStar(require("vscode"));
/**
 * Fire-and-forget telemetry client for the vibing/learning gauge.
 *
 * Design rules:
 *   1. Never block an editor action. Every POST has a short AbortSignal
 *      timeout and swallows all errors.
 *   2. Every event's response carries the fresh summary, so the status
 *      bar stays in sync without a polling loop.
 *   3. User id is `vscode.env.machineId` — stable per machine, no login
 *      or PII. Good enough for a per-user gauge on a local dev machine.
 */
const BACKEND_URL = process.env.VIBECHECK_BACKEND_URL ?? 'http://localhost:8000';
const listeners = [];
let latest;
/**
 * Subscribe to summary updates. Fires immediately with the cached
 * summary if one exists, so subscribers don't need to handle cold-start.
 */
function onSummaryChange(fn) {
    listeners.push(fn);
    if (latest) {
        fn(latest);
    }
    return new vscode.Disposable(() => {
        const i = listeners.indexOf(fn);
        if (i >= 0) {
            listeners.splice(i, 1);
        }
    });
}
function getLatestSummary() {
    return latest;
}
function broadcast(s) {
    latest = s;
    for (const l of listeners) {
        try {
            l(s);
        }
        catch (err) {
            console.warn('[VibeCheck] summary listener threw:', err);
        }
    }
}
function emptySummary() {
    return {
        generated: 0,
        reviewed: 0,
        submitted: 0,
        passed: 0,
        passed_first_try: 0,
        first_try_rate_pct: 0,
        overridden: 0,
        dismissed: 0,
        vibing_count: 0,
        vibing_pct: 0,
        learning_pct: 0,
        cooking_pct: 0,
    };
}
function normalizeSummary(s) {
    const reviewed = s.passed + s.overridden;
    const generated = Math.max(s.generated, reviewed + s.dismissed);
    const vibing_count = Math.max(generated - reviewed, 0);
    // Three-way partition. We round learning + cooking down (Math.round)
    // and let vibing absorb whatever remainder is left so the trio sums
    // to exactly 100. Without the absorption you can get 100 = 33+33+33
    // showing as 99% in the UI.
    const learning_pct = generated
        ? Math.round((100 * s.passed) / generated)
        : 0;
    const cooking_pct = generated
        ? Math.round((100 * s.overridden) / generated)
        : 0;
    const vibing_pct = generated
        ? Math.max(0, 100 - learning_pct - cooking_pct)
        : 0;
    const first_try_rate_pct = generated
        ? Math.round((100 * s.passed_first_try) / generated)
        : 0;
    return {
        ...s,
        generated,
        reviewed,
        vibing_count,
        vibing_pct,
        learning_pct,
        cooking_pct,
        first_try_rate_pct,
    };
}
function broadcastOptimistic(kind, meta) {
    const s = { ...(latest ?? emptySummary()) };
    switch (kind) {
        case 'ai_generated':
            s.generated += 1;
            break;
        case 'answer_submitted':
            s.submitted += 1;
            break;
        case 'answer_passed':
            s.passed += 1;
            if (meta.attempt === 1 || meta.first_try === true) {
                s.passed_first_try += 1;
            }
            break;
        case 'checkpoint_overridden':
            s.overridden += 1;
            break;
        case 'checkpoint_dismissed':
            s.dismissed += 1;
            break;
        case 'checkpoint_opened':
            break;
    }
    broadcast(normalizeSummary(s));
}
function getUserId() {
    // Stable per VSCode installation. Good enough for demo — no PII, no
    // login required.
    return vscode.env.machineId ?? 'unknown-user';
}
/**
 * Record an event. Non-blocking; all errors are swallowed.
 */
async function recordEvent(kind, meta = {}) {
    const user_id = getUserId();
    broadcastOptimistic(kind, meta);
    try {
        const res = await fetch(`${BACKEND_URL}/metrics/event`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ user_id, kind, meta }),
            signal: AbortSignal.timeout(2500),
        });
        if (!res.ok) {
            return;
        }
        const json = (await res.json());
        if (json.summary) {
            broadcast(normalizeSummary(json.summary));
        }
    }
    catch {
        // Metrics failures must never surface to editor UX.
    }
}
/**
 * Hydrate the status bar on activation without recording a new event.
 */
async function refreshSummary() {
    const user_id = getUserId();
    try {
        const res = await fetch(`${BACKEND_URL}/metrics/summary?user_id=${encodeURIComponent(user_id)}`, { signal: AbortSignal.timeout(2500) });
        if (!res.ok) {
            return;
        }
        const json = (await res.json());
        broadcast(normalizeSummary(json));
    }
    catch {
        // Silent.
    }
}
//# sourceMappingURL=recorder.js.map