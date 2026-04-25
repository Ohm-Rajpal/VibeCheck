# VibeCheck — Learn Mode for AI Coding Agents

Cascade ships with **Plan Mode** and **Write Mode**. VibeCheck adds **Learn Mode**: a third mode where the agent pauses after each meaningful generation and quizzes the human until they can defend the code in their own words. It's agent-agnostic — works whether Cascade, Devin, Copilot, or Cursor wrote the code — and surfaces the engineer's growing comprehension over time as a learning curve and concept-strength radar.

## Why

AI agents generate code faster than humans can understand it. Code passes CI, looks correct in review, and lands in the codebase. Months later it causes incidents nobody can debug because the original author never understood it. VibeCheck is the comprehension layer between AI generation and production.

## Architecture (current)

- **Layer 1 — In-editor velocity detection** (`packages/vscode-extension`): VSCode extension watches `onDidChangeTextDocument`, flags AI bursts via a multi-signal heuristic (line burst + idle gap + reason filter + clipboard equality), and triggers a non-blocking comprehension toast.
- **Layer 2A — Pre-commit gate** (`packages/hooks`): Husky hook that short-circuits for known agent identities and prompts humans for skipped Layer 1 checkpoints (work in progress).
- **Layer 2B — PR-time classifier** (`packages/api`): Gemma-based diff classifier that catches AI code regardless of who pushed the button (next sprint).
- **Growth dashboard** — Recharts learning curve + concept radar in a VSCode sidebar (placeholder, next sprint).

## Status

Skeleton + working Layer 1 detection. See `packages/vscode-extension/src/detection/` for the multi-signal logic. Open the `VibeCheck` Output Channel in the Extension Dev Host to watch detection decisions in real time.