// Single source of truth for known AI-agent identities.
// Used by Layer 2 (pre-commit hook + GitHub webhook) as a fast-path short-circuit
// before falling through to the Gemma diff classifier.
//
// IMPORTANT: keep this list in sync with packages/hooks/pre-commit.js.

export const KNOWN_AGENT_EMAILS: readonly string[] = [
  'devin-ai-integration[bot]@users.noreply.github.com',
  'devin@cognition.ai',
  'noreply@anthropic.com',
  'copilot-swe-agent[bot]@users.noreply.github.com',
];

export const KNOWN_AGENT_LOGINS: readonly string[] = [
  'devin-ai-integration[bot]',
  'copilot-swe-agent[bot]',
];

export const KNOWN_AGENT_ENV_VARS: readonly string[] = [
  'CLAUDE_CODE',
  'CURSOR_AGENT',
  'WINDSURF_AGENT',
  'DEVIN_SESSION_ID',
];

export function isAgentEmail(email: string | undefined | null): boolean {
  if (!email) return false;
  const e = email.toLowerCase();
  return KNOWN_AGENT_EMAILS.some((known) => e.includes(known.toLowerCase()));
}

export function isAgentLogin(login: string | undefined | null): boolean {
  if (!login) return false;
  return KNOWN_AGENT_LOGINS.some((known) => login.includes(known));
}

export function isAgentEnv(): boolean {
  return KNOWN_AGENT_ENV_VARS.some((v) => !!process.env[v]);
}

export function isAgentIdentity(input: {
  email?: string | null;
  login?: string | null;
}): boolean {
  return isAgentEmail(input.email) || isAgentLogin(input.login);
}
