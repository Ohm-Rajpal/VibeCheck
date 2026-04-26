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

## Install (Linux / macOS)

### Prerequisites

- **Node.js 18+** and **npm** ([install guide](https://nodejs.org/))
- **VSCode** (or any VSCode-compatible editor: Cursor, Windsurf, etc.)
- The `code` CLI in your `PATH`:
  - **Linux**: usually installed automatically with VSCode.
  - **macOS**: open VSCode → `Cmd+Shift+P` → run **`Shell Command: Install 'code' command in PATH`**.

Verify both are available:

```bash
node --version    # should print v18+ or higher
code --version    # should print VSCode version info
```

### Build and install the extension

From the repo root:

```bash
# 1. Install build deps for the extension
cd packages/vscode-extension
npm install

# 2. Compile TypeScript and package into a .vsix
npm run compile
npx @vscode/vsce package --no-dependencies --out vibecheck-0.0.1.vsix

# 3. Install the .vsix into your VSCode
code --install-extension vibecheck-0.0.1.vsix
```

Then reload any open VSCode window: `Ctrl+Shift+P` (or `Cmd+Shift+P` on macOS) → **`Developer: Reload Window`**.

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

1. Look at the bottom-right status bar — it should show `🟣 VibeCheck: clean`.
2. Open any code file.
3. Run `Ctrl+Shift+P` → **`VibeCheck: Simulate AI Burst (test detection)`**.
4. You should see:
   - A yellow highlight + `🧠 AI — needs check` margin label on the inserted lines.
   - A toast in the bottom-right: *"VibeCheck: AI just wrote ~21 lines... Quick check?"*
   - The status bar updates to `🧠 1 unverified · 1 file`.

### Installing in Cursor / Windsurf / other VSCode forks

The VSIX is portable. Use that editor's CLI or UI:

- **Cursor**: `cursor --install-extension vibecheck-0.0.1.vsix`
- **Windsurf**: `windsurf --install-extension vibecheck-0.0.1.vsix`
- **Any fork**: open the Extensions panel (`Ctrl+Shift+X`) → click the `…` menu at the top → **`Install from VSIX…`** → select the file.

### Update installed editor copies

After changing extension code, update all detected editor installs from the repo root:

```bash
npm run update:extension
```

This compiles the extension, packages `vibecheck-0.0.1.vsix`, and force-installs it into available VSCode-compatible CLIs such as `windsurf`, `code`, `cursor`, `code-insiders`, and `codium`. Reload each editor window afterward.

### Uninstall

```bash
code --uninstall-extension vibecheck.vibecheck
```

### Iteration tip

While developing, skip the install step and use the **Extension Development Host**:

```bash
code --extensionDevelopmentPath=$(pwd)/packages/vscode-extension /path/to/test/repo
```

This launches a sandboxed VSCode window running your latest compiled code without touching your global install.