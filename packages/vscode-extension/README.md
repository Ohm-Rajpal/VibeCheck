# VibeCheck

Comprehension checkpoints for AI-generated code. Detects when an AI assistant
writes a meaningful chunk of code in your editor and prompts you with a
focused design question to verify you actually understand what was generated
before it lands in `main`.

## How it works

1. **Detect** — a velocity-based heuristic watches for bursts of inserted
   lines that don't look like human typing or paste-from-clipboard.
2. **Mark** — each AI-authored block is highlighted in yellow with an
   `🧠 AI — needs check` margin label.
3. **Check** — when you click the toast or status bar, a panel asks one
   design question per block. Your answer is graded by Gemini.

## Commands

- `VibeCheck: Show Growth Dashboard` — sidebar with comprehension stats.
- `VibeCheck: Open Checkpoint Panel` — re-open the current checkpoint.
- `VibeCheck: Simulate AI Burst (test detection)` — manually trigger a
  detection event for testing.

## Status

Prototype. Built for LA Hacks 2026 (Cognition / Human-AI Collaboration track).
