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
            broadcast(json.summary);
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
        broadcast(json);
    }
    catch {
        // Silent.
    }
}
//# sourceMappingURL=recorder.js.map