# VibeCheck — Learn Mode for AI Coding Agents

> **Built for Windsurf.** VibeCheck is optimized for Windsurf + Cascade. It also runs on VS Code and Cursor as a fallback, but the override-into-Cascade flow, the Cascade-aware prompt handoff, and the demo defaults all assume Windsurf is the host editor.

> **Cognition track — Human–AI collaboration tooling.** The handoff between human and agent is clunky. VibeCheck makes it seamless for the engineers most exposed to the gap: **interns and junior engineers** who are shipping AI-generated code faster than they can absorb it.

## The problem

In the era of vibe coding, **human-AI interaction is more important than ever**, because every design choice that gets vibe-coded instead of understood or challenged is **tech debt** that compounds silently. The pattern goes like this:

1. An intern accepts an AI suggestion they don't fully understand.
2. The code passes CI, looks correct in review, and lands in the codebase.
3. Months later it breaks in production, and the original author can't explain why they made the choice, because they never made it; the AI did.

This is the failure mode VibeCheck is built to prevent. It's an **educational tool that reduces tech debt** by forcing a brief, low-friction comprehension checkpoint at the moment the AI code is generated. Not at PR review, not in post-mortem, but *right then*, while the context is still fresh and the alternative paths are still cheap.

## What VibeCheck adds

Cascade ships with **Plan Mode** and **Write Mode**. VibeCheck adds **Learn Mode**: a third mode where the agent pauses after each meaningful generation and quizzes the human until they can defend the code in their own words. When the human pushes back, VibeCheck deletes the AI snippet and pipes a structured prompt straight into a fresh **Cascade** conversation, so the override loop stays inside Windsurf instead of bouncing through external tools.

The product surfaces three numbers that mean something (**Vibing**, **Learning**, **Cooking**) so engineers and their managers can watch a real growth curve as accept-blindly behavior gives way to comprehension and engineering pushback.

## Architecture (current)

- **Layer 1, in-editor velocity detection** (`packages/vscode-extension`): Windsurf extension watches `onDidChangeTextDocument`, flags AI bursts via a multi-signal heuristic (line burst + idle gap + reason filter + clipboard equality), and triggers a non-blocking comprehension toast.
- **Cascade override handoff** (`packages/vscode-extension/src/checkpoint/commentThreads.ts`): when the user rejects an AI snippet, VibeCheck deletes the code, builds a structured prompt with file context plus the user's reasoning, and forwards it to Cascade via the `windsurf.triggerCascade` command and a clipboard auto-paste. Windsurf-specific; the VS Code / Cursor fallback opens the built-in chat surface instead.
- **Layer 2A, pre-commit gate** (`packages/hooks`): Husky hook that short-circuits for known agent identities and prompts humans for skipped Layer 1 checkpoints (work in progress).
- **Layer 2B, PR-time classifier** (`packages/api`): Gemma-based diff classifier that catches AI code regardless of who pushed the button (next sprint).
- **Growth dashboard**: Recharts learning curve and concept radar in the Windsurf sidebar.

## Status

Skeleton + working Layer 1 detection + working Cascade-handoff override. See `packages/vscode-extension/src/detection/` for the multi-signal logic. Open the `VibeCheck` Output Channel in Windsurf to watch detection decisions in real time.

## Run VibeCheck (TL;DR)

VibeCheck is **two processes**. Both must be running for the demo to work end-to-end. **Run them in this order:**

| # | Command | What it does | When to rerun |
|---|---|---|---|
| 1 | `npm run update:extension` | Compiles the TS extension, packages a `.vsix`, and installs it into **Windsurf** (primary target) plus any other detected editors (VS Code, Cursor) as fallbacks. | **Every time you edit extension code.** Then **reload the Windsurf window** (`Ctrl+Shift+P` → `Developer: Reload Window`). |
| 2 | `npm run start:api` | Starts the Python FastAPI backend on `localhost:8000` (Gemma questions, grading, metrics). | Once per session. Hot-reloads on Python edits. |
| 3 (optional) | `npm run seed:demo` | Pre-fills the **Session history** chart with 8 fake sessions telling a "vibing → cooking" trend story. Great for screen-share demos. | When you want a clean, story-rich dashboard. Idempotent: re-running replaces the seed. |

> **Important:** `npm run update:extension` does **not** start the backend. `npm run start:api` does **not** install the extension. They are independent, so you need both.

### Day-to-day dev loop

```bash
# Terminal 1 — install the extension first, then reload your editor:
#   Ctrl+Shift+P → Developer: Reload Window
npm run update:extension

# Terminal 2 — backend (leave running for the rest of the session)
npm run start:api
```

Whenever you edit extension TypeScript, rerun `npm run update:extension` and reload the window. The backend keeps hot-reloading on its own.

The `update:extension` script lives at `scripts/update-editor-extension.sh`.
The `start:api` script lives at `scripts/start-api.sh`.

### Demo seeding (optional)

For demos and screen recordings the Growth dashboard looks much more
compelling with an existing trend than with an empty bar chart. The
seed script populates the `sessions` collection with 8 fake snapshots
that visibly slope from "heavy vibing" to "majority learning + cooking",
ending ~12 hours before now so a live Reset during the demo lands a
fresh bar at the right edge that extends the pattern.

```bash
# 1. Make sure the API is running and you've reloaded Windsurf so the
#    extension fires GET /metrics/summary at least once. That registers
#    your machine_id in MongoDB so --auto can find it.
# 2. Then:
npm run seed:demo
```

`npm run seed:demo` runs `python scripts/seed-sessions.py --auto --replace`:

- `--auto`: auto-detects `vscode.env.machineId` from the `users` registry,
  falling back to recent events / sessions if needed. No need to copy/paste an id.
- `--replace`: wipes any prior seed for that machine before inserting,
  so re-running is safe.

If you'd rather control the user_id explicitly:

```bash
.venv/bin/python scripts/seed-sessions.py --user-id <your_machine_id>
```

Reopen the **VibeCheck activity-bar panel** after seeding (or close+reopen
the panel) and the **Session history** chart below the Reset button
will be populated. Hover any bar to morph the donut and headline into
that past session's snapshot.

---

## Features

### AI detection
- Watches `onDidChangeTextDocument` for **velocity bursts** using a multi-signal heuristic that combines line-burst size, idle-prefix gap, edit-reason filter, and clipboard equality, so AI generations are flagged but human typing and Cmd/Ctrl+V pastes are not.
- AI-authored regions are highlighted in yellow with a `🧠 AI — needs check` margin label, and the status bar updates from `VibeCheck: clean` to `🧠 N unverified · M files`.

### Gemma-powered comprehension quiz
- When an AI burst is detected, a non-blocking toast offers three actions: **Skip**, **Override**, or **Answer Now**.
- Choosing **Answer Now** opens an inline GitHub-PR-style comment thread with a question generated by **Gemma**, targeted at a specific implementation choice (not a goal-level paraphrase the user could fake from memory).
- The grading UI shows a loading animation while Gemma scores the answer (typically <3s).
- **Correct** → thread auto-resolves, Learning score goes up.
- **Incorrect** → thread stays open, follow-up prompt asks for a better explanation. The user can keep iterating or fall back to Skip.

### The three options on every checkpoint
| Option | Effect | Score it grows |
|---|---|---|
| **Skip** | Accepts the AI code as-is without engaging. | **Vibing** ⬆ |
| **Answer Now** (Learn) | Submit a written answer; Gemma grades it. | **Learning** ⬆ on pass |
| **Override** | Reject the AI code; pipe a structured prompt to Cascade. | **Cooking** ⬆ |

### Override → Cascade handoff (Windsurf-specific)
- Clicking **Override** swaps the question for an override prompt: the user types why the AI code is wrong.
- On submit, VibeCheck:
  1. Deletes the AI-authored snippet from the file.
  2. Builds a structured prompt containing the file path, the deleted snippet, and the user's reasoning.
  3. Opens **Cascade** via `windsurf.triggerCascade` (a Windsurf command we discovered while inspecting the bundled extension manifest at `~/.windsurf-server/.../extensions/windsurf/package.json`).
  4. Auto-pastes the structured prompt into Cascade's input. The user just presses Enter.
- Falls back to clipboard-only on VS Code / Cursor (the discovered command is Windsurf-only).

### Three metrics: Vibing, Learning, Cooking
- **Vibing**: AI generations the user never engaged with. Useful for shipping speed, dangerous for tech debt.
- **Learning**: AI generations the user passed a Gemma comprehension check on. Demonstrates genuine ownership of the codebase.
- **Cooking**: AI generations the user pushed back on with a real suggestion. Demonstrates engineering judgement and design-decision-making, a skill the team thinks is increasingly underweighted in the vibe-coding era.

### Status-bar visualization
- `VibeCheck: clean` when there's no unverified AI code.
- Live gauges for the three metrics: `Vibing N% · Learning N% · Cooking N%`.
- Click any gauge to open the Growth dashboard.

### Growth dashboard (sidebar)
- **Current-session pie chart**: interactive donut showing the live mix of Vibing, Learning, and Cooking. Hover for exact percentages.
- **Session history**: stacked-bar chart of past sessions, oldest-on-the-left to newest-on-the-right. Hover any bar to morph the donut into that snapshot.
- **Trend reading guide:**
  - **Red shrinking**: you're catching yourself before shipping unreviewed AI code.
  - **Green growing**: you're genuinely understanding the codebase.
  - **Blue growing**: you're making engineering decisions, not just accepting suggestions.

### Reset metrics (live → long-term)
- One-click **Reset** in the dashboard:
  1. Snapshots the current `summarize()` result into the `sessions` collection (immutable history).
  2. Deletes every event from the live `events` collection.
- The pie chart clears, the session-history bar chart gains one new bar reflecting the just-snapshotted session.
- TTL on `sessions` (planned: 1–2 weeks) cycles out the oldest snapshots to keep the trend window honest.

### AST-aware pre-commit gate (reach goal)
- Husky pre-commit hook (`packages/hooks`) runs `git diff` and asks the API to AST-parse only the **changed functions**.
- Each AI-authored function that's never been verified blocks the commit until the human passes a checkpoint or explicitly overrides it.
- Skips itself for known agent identities (Devin, Cascade-as-author) so agents can keep autopiloting without prompting a human who isn't there.

---

## Install (Linux / macOS)

### Prerequisites

- **Node.js 18+** and **npm** ([install guide](https://nodejs.org/))
- **Windsurf** (recommended, and required for the Cascade override flow). VS Code and Cursor work as fallbacks but lose the Cascade-specific features.
- The `windsurf` CLI in your `PATH` (installed automatically with Windsurf on Linux; on macOS open Windsurf → `Cmd+Shift+P` → run **`Shell Command: Install 'windsurf' command in PATH`**).

Verify both are available:

```bash
node --version       # should print v18+ or higher
windsurf --version   # should print Windsurf version info
```

> Don't have Windsurf? `code --version` (VS Code) or `cursor --version` (Cursor) also work, but the Cascade override handoff degrades to opening a generic chat surface.

### Build and install the extension

From the repo root:

```bash
# 1. Install build deps for the extension
cd packages/vscode-extension
npm install

# 2. Compile TypeScript and package into a .vsix
npm run compile
npx @vscode/vsce package --no-dependencies --out vibecheck-0.0.1.vsix

# 3. Install the .vsix into Windsurf (primary target)
windsurf --install-extension vibecheck-0.0.1.vsix
```

Then reload any open Windsurf window: `Ctrl+Shift+P` (or `Cmd+Shift+P` on macOS) → **`Developer: Reload Window`**.

### Start the API backend

The extension calls the local Python API at `http://localhost:8000` for Gemma question generation, answer grading, and metrics. Start it before demoing checkpoints:

```bash
npm run start:api
```

This is the single startup command for the backend. It delegates to `scripts/start-api.sh`, which creates `packages/api/.venv` if needed, installs Python dependencies only when `packages/api/requirements.txt` changes, and runs `uvicorn packages.api.main:app --reload --host 0.0.0.0 --port 8000` from the repo root.

If port `8000` is already serving VibeCheck, the command exits successfully and prints the health URLs. If port `8000` is occupied by a broken process, stop that process and rerun `npm run start:api`.

Verify the API is live:

```bash
curl http://localhost:8000/health
curl http://localhost:8000/metrics/health
```

### Verify it's working

1. Look at the bottom-right status bar; it should show `🟣 VibeCheck: clean`.
2. Open any code file.
3. Run `Ctrl+Shift+P` → **`VibeCheck: Simulate AI Burst (test detection)`**.
4. You should see:
   - A yellow highlight + `🧠 AI — needs check` margin label on the inserted lines.
   - A toast in the bottom-right: *"VibeCheck: AI just wrote ~21 lines... Quick check?"*
   - The status bar updates to `🧠 1 unverified · 1 file`.

### Fallback: installing in VS Code or Cursor

The VSIX is portable, so VS Code and Cursor work too. They just lose the Cascade override handoff (you'll get the built-in chat surface instead).

- **VS Code**: `code --install-extension vibecheck-0.0.1.vsix`
- **Cursor**: `cursor --install-extension vibecheck-0.0.1.vsix`
- **Any VSCode fork**: open the Extensions panel (`Ctrl+Shift+X`) → click the `…` menu → **`Install from VSIX…`** → select the file.

### Update installed editor copies

After changing extension code, update all detected editor installs from the repo root:

```bash
npm run update:extension
```

This compiles the extension, packages `vibecheck-0.0.1.vsix`, and force-installs it into Windsurf first, then any other available VSCode-compatible CLIs (`code`, `cursor`, `code-insiders`, `codium`). Reload each editor window afterward.

### Uninstall

```bash
windsurf --uninstall-extension vibecheck.vibecheck
```

### Iteration tip

While developing, skip the install step and use Windsurf's **Extension Development Host**:

```bash
windsurf --extensionDevelopmentPath=$(pwd)/packages/vscode-extension /path/to/test/repo
```

This launches a sandboxed Windsurf window running your latest compiled code without touching your global install.