import * as vscode from 'vscode';

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

const BACKEND_URL =
  process.env.VIBECHECK_BACKEND_URL ?? 'http://localhost:8000';

export type VibeEventKind =
  | 'ai_generated'
  | 'checkpoint_opened'
  | 'answer_submitted'
  | 'answer_passed'
  | 'checkpoint_overridden'
  | 'checkpoint_dismissed';

export interface VibeSummary {
  generated: number;
  reviewed: number;
  submitted: number;
  passed: number;
  passed_first_try: number;
  first_try_rate_pct: number;
  overridden: number;
  dismissed: number;
  vibing_count: number;
  vibing_pct: number;
  learning_pct: number;
}

type SummaryListener = (s: VibeSummary) => void;

const listeners: SummaryListener[] = [];
let latest: VibeSummary | undefined;

/**
 * Subscribe to summary updates. Fires immediately with the cached
 * summary if one exists, so subscribers don't need to handle cold-start.
 */
export function onSummaryChange(fn: SummaryListener): vscode.Disposable {
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

export function getLatestSummary(): VibeSummary | undefined {
  return latest;
}

function broadcast(s: VibeSummary): void {
  latest = s;
  for (const l of listeners) {
    try {
      l(s);
    } catch (err) {
      console.warn('[VibeCheck] summary listener threw:', err);
    }
  }
}

function getUserId(): string {
  // Stable per VSCode installation. Good enough for demo — no PII, no
  // login required.
  return vscode.env.machineId ?? 'unknown-user';
}

/**
 * Record an event. Non-blocking; all errors are swallowed.
 */
export async function recordEvent(
  kind: VibeEventKind,
  meta: Record<string, unknown> = {}
): Promise<void> {
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
    const json = (await res.json()) as { summary?: VibeSummary };
    if (json.summary) {
      broadcast(json.summary);
    }
  } catch {
    // Metrics failures must never surface to editor UX.
  }
}

/**
 * Hydrate the status bar on activation without recording a new event.
 */
export async function refreshSummary(): Promise<void> {
  const user_id = getUserId();
  try {
    const res = await fetch(
      `${BACKEND_URL}/metrics/summary?user_id=${encodeURIComponent(user_id)}`,
      { signal: AbortSignal.timeout(2500) }
    );
    if (!res.ok) {
      return;
    }
    const json = (await res.json()) as VibeSummary;
    broadcast(json);
  } catch {
    // Silent.
  }
}
