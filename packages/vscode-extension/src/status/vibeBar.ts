import * as vscode from 'vscode';
import {
  onSummaryChange,
  refreshSummary,
  VibeSummary,
} from '../metrics/recorder';

/**
 * Three persistent status-bar items on the bottom-right that always
 * sum to 100% of AI-generated regions:
 *
 *   � Vibing   ▰▰▱▱▱▱ 33%   (red)   — ignored / dismissed / pending
 *   � Learning ▰▰▰▰▱▱ 50%   (green) — passed comprehension check
 *   🚀 Cooking  ▰▱▱▱▱▱ 17%   (blue)  — override + suggestion to Cascade
 *
 * Each gauge has TWO visual states:
 *   - "muted"  — grey foreground, used when the gauge hasn't fired yet
 *                (count === 0). Conveys "no activity in this bucket".
 *   - "active" — full saturated chart color (red/green/blue), used the
 *                moment the gauge accumulates its first hit.
 *
 * Updates live on every event via the recorder's pub/sub. The bars
 * also paint a status-bar background when one side dominates (>=50%),
 * giving a peripheral-vision gauge without opening a dashboard.
 */

const BAR_WIDTH = 6;
const FILLED = '▰';
const EMPTY = '▱';

function bar(pct: number): string {
  // Round up so 1% still shows one filled cell — the first event after
  // a long idle would otherwise look like nothing happened.
  const filled = Math.max(
    0,
    Math.min(BAR_WIDTH, Math.ceil((pct / 100) * BAR_WIDTH))
  );
  return FILLED.repeat(filled) + EMPTY.repeat(BAR_WIDTH - filled);
}

export function activateVibeBar(context: vscode.ExtensionContext): void {
  // For StatusBarAlignment.Right, higher priority renders FURTHER LEFT.
  // The pre-existing "unverified regions" bar is at priority 100, so
  // we sit just to its right at 98/97/96. Order on screen, left→right:
  //   Vibing (98) | Learning (97) | Cooking (96)
  const vibing = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    98
  );
  const learning = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    97
  );
  const cooking = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    96
  );
  vibing.command = 'vibecheck.showGrowth';
  learning.command = 'vibecheck.showGrowth';
  cooking.command = 'vibecheck.showGrowth';

  // Active = full saturation; muted = pre-activity grey. Built-in
  // VSCode chart colors render consistently across light + dark themes.
  const VIBING_ACTIVE = new vscode.ThemeColor('charts.red');
  const LEARNING_ACTIVE = new vscode.ThemeColor('charts.green');
  const COOKING_ACTIVE = new vscode.ThemeColor('charts.blue');
  // `descriptionForeground` is VSCode's native dim/secondary text color
  // — perfect for "this gauge has no data yet, don't draw the eye to it".
  const MUTED = new vscode.ThemeColor('descriptionForeground');

  const render = (s: VibeSummary | undefined) => {
    if (!s || s.generated === 0) {
      // Cold-start — communicate "no data" rather than 0%, which would
      // misleadingly imply "100% learning". All three render in the
      // muted hue until something fires.
      vibing.text = `😎 Vibing ${bar(0)} –`;
      vibing.color = MUTED;
      vibing.tooltip = new vscode.MarkdownString(
        '**VibeCheck — Vibing %**\n\nAI code regions you never engaged with.\n\nNo activity yet.'
      );
      vibing.backgroundColor = undefined;

      learning.text = `🤓 Learning ${bar(0)} –`;
      learning.color = MUTED;
      learning.tooltip = new vscode.MarkdownString(
        '**VibeCheck — Learning %**\n\nAI code you answered correctly.\n\nNo activity yet.'
      );
      learning.backgroundColor = undefined;

      cooking.text = `$(rocket) Cooking ${bar(0)} –`;
      cooking.color = MUTED;
      cooking.tooltip = new vscode.MarkdownString(
        '**VibeCheck — Cooking %**\n\nAI code you overrode with your own ' +
          'suggestion to Cascade.\n\nNo activity yet.'
      );
      cooking.backgroundColor = undefined;
    } else {
      // Per-gauge "has fired" check. We light up the saturated color the
      // instant the underlying count goes above zero — even at 1%.
      const vibingFired = s.vibing_count > 0;
      const learningFired = s.passed > 0;
      const cookingFired = s.overridden > 0;

      vibing.text = `😎 Vibing ${bar(s.vibing_pct)} ${s.vibing_pct}%`;
      vibing.color = vibingFired ? VIBING_ACTIVE : MUTED;
      vibing.tooltip = buildTooltip('vibing', s);
      vibing.backgroundColor =
        s.vibing_pct > 50
          ? new vscode.ThemeColor('statusBarItem.errorBackground')
          : undefined;

      learning.text = `🤓 Learning ${bar(s.learning_pct)} ${s.learning_pct}%`;
      learning.color = learningFired ? LEARNING_ACTIVE : MUTED;
      learning.tooltip = buildTooltip('learning', s);
      learning.backgroundColor =
        s.learning_pct >= 50
          ? new vscode.ThemeColor('statusBarItem.prominentBackground')
          : undefined;

      cooking.text = `$(rocket) Cooking ${bar(s.cooking_pct)} ${s.cooking_pct}%`;
      cooking.color = cookingFired ? COOKING_ACTIVE : MUTED;
      cooking.tooltip = buildTooltip('cooking', s);
      // Use VSCode's iconic remote-indicator blue background once
      // cooking dominates — same hue family as the foreground tint.
      cooking.backgroundColor =
        s.cooking_pct >= 50
          ? new vscode.ThemeColor('statusBarItem.remoteBackground')
          : undefined;
    }

    vibing.show();
    learning.show();
    cooking.show();
  };

  context.subscriptions.push(
    vibing,
    learning,
    cooking,
    onSummaryChange(render)
  );

  render(undefined);
  void refreshSummary();
}

function buildTooltip(
  which: 'vibing' | 'learning' | 'cooking',
  s: VibeSummary
): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.supportThemeIcons = true;
  const title =
    which === 'vibing'
      ? '**😎 Vibing %**'
      : which === 'learning'
        ? '**🤓 Learning %**'
        : '**$(rocket) Cooking %**';
  md.appendMarkdown(`${title}\n\n`);
  md.appendMarkdown(
    which === 'vibing'
      ? "Share of AI-authored regions you haven't engaged with " +
          '(ignored, dismissed, or still pending).\n\n'
      : which === 'learning'
        ? 'Share of AI-authored regions where you passed the ' +
            'comprehension check.\n\n'
        : 'Share of AI-authored regions you overrode with your own ' +
            'replacement instructions to Cascade — the collaborative ' +
            'human-in-the-loop bucket.\n\n'
  );
  md.appendMarkdown(
    `| | count |\n` +
      `|---|---:|\n` +
      `| AI generations detected | ${s.generated} |\n` +
      `| Passed comprehension | ${s.passed} (${s.learning_pct}%) |\n` +
      `| Override + suggestion | ${s.overridden} (${s.cooking_pct}%) |\n` +
      `| First-try passes | ${s.passed_first_try} (${s.first_try_rate_pct}%) |\n` +
      `| Total submissions | ${s.submitted} |\n` +
      `| Dismissed / skipped | ${s.dismissed} |\n` +
      `\n_Vibing + Learning + Cooking always sums to 100%._`
  );
  return md;
}
