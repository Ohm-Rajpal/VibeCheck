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
  // Three gauges that partition the AI-generated regions and ALWAYS
  // sum to exactly 100% (when generated > 0):
  //   vibing  = ignored / dismissed / still pending
  //   learning = passed comprehension check
  //   cooking = override + suggestion (collaborated with the agent)
  // Rounding remainder is absorbed into vibing so the user-facing
  // numbers never look like 99% or 101%.
  vibing_pct: number;
  learning_pct: number;
  cooking_pct: number;
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

function emptySummary(): VibeSummary {
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

function normalizeSummary(s: VibeSummary): VibeSummary {
  const reviewed = s.passed + s.overridden;
  const generated = Math.max(s.generated, reviewed + s.dismissed);
  const vibing_count = Math.max(generated - reviewed, 0);
  const hasCooking = s.overridden > 0;

  // Three-way partition. We round learning + cooking down (Math.round)
  // and let vibing absorb whatever remainder is left so the trio sums
  // to exactly 100. Without the absorption you can get 100 = 33+33+33
  // showing as 99% in the UI.
  const learning_pct = generated
    ? Math.round((100 * s.passed) / generated)
    : 0;
  const cooking_pct = generated && hasCooking
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

function broadcastOptimistic(kind: VibeEventKind, meta: Record<string, unknown>): void {
  const s: VibeSummary = { ...(latest ?? emptySummary()) };
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
    const json = (await res.json()) as { summary?: VibeSummary };
    if (json.summary) {
      broadcast(normalizeSummary(json.summary));
    }
  } catch {
    // Metrics failures must never surface to editor UX.
  }
}

export interface SessionSnapshot {
  ended_at: string | null;
  vibing_pct: number;
  learning_pct: number;
  cooking_pct: number;
  generated: number;
  passed: number;
  overridden: number;
  vibing_count: number;
  dismissed: number;
}

export interface ResetResult {
  ok: boolean;
  deleted: number;
  snapshotted: boolean;
}

/**
 * Snapshot the current summary into the `sessions` collection on the
 * server, then wipe every event for the current user_id. Optimistic
 * local broadcast clears the gauges immediately so the UI reflects
 * the user's intent even before the network round-trip finishes.
 */
export async function resetMetrics(): Promise<ResetResult> {
  // Optimistic: zero out the cached summary so the status bar + sidebar
  // show "no data" the instant the user clicks the command, instead of
  // showing stale numbers until the POST returns.
  broadcast(emptySummary());

  const user_id = getUserId();
  try {
    const res = await fetch(`${BACKEND_URL}/metrics/reset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user_id }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      return { ok: false, deleted: 0, snapshotted: false };
    }
    const json = (await res.json()) as {
      ok?: boolean;
      deleted?: number;
      snapshotted?: boolean;
      summary?: VibeSummary;
    };
    if (json.summary) {
      broadcast(normalizeSummary(json.summary));
    }
    return {
      ok: !!json.ok,
      deleted: json.deleted ?? 0,
      snapshotted: !!json.snapshotted,
    };
  } catch {
    return { ok: false, deleted: 0, snapshotted: false };
  }
}

/**
 * Fetch the user's saved session snapshots (oldest → newest) for the
 * Growth dashboard's history bar chart. Empty array on any failure —
 * the chart simply won't render in that case.
 */
export async function fetchSessions(
  limit: number = 30
): Promise<SessionSnapshot[]> {
  const user_id = getUserId();
  try {
    const res = await fetch(
      `${BACKEND_URL}/metrics/sessions?user_id=${encodeURIComponent(
        user_id
      )}&limit=${limit}`,
      { signal: AbortSignal.timeout(3000) }
    );
    if (!res.ok) return [];
    const json = (await res.json()) as { sessions?: SessionSnapshot[] };
    return json.sessions ?? [];
  } catch {
    return [];
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
    broadcast(normalizeSummary(json));
  } catch {
    // Silent.
  }
}
