#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

function main() {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const hooksDir = path.join(repoRoot, '.git', 'hooks');
  const hookPath = path.join(hooksDir, 'pre-commit');

  if (!fs.existsSync(path.join(repoRoot, '.git'))) {
    console.error('[VibeCheck] .git directory not found. Run this from a cloned repository.');
    process.exit(1);
  }

  fs.mkdirSync(hooksDir, { recursive: true });
  const script = '#!/bin/sh\nnode packages/hooks/pre-commit.js\n';
  fs.writeFileSync(hookPath, script, 'utf8');

  try {
    fs.chmodSync(hookPath, 0o755);
  } catch {
    // Windows may ignore chmod; git can still execute hooks via shell.
  }

  console.log(`[VibeCheck] Installed pre-commit hook at ${hookPath}`);
}

main();
