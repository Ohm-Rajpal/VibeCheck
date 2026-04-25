"use strict";
// Single source of truth for known AI-agent identities.
// Used by Layer 2 (pre-commit hook + GitHub webhook) as a fast-path short-circuit
// before falling through to the Gemma diff classifier.
//
// IMPORTANT: keep this list in sync with packages/hooks/pre-commit.js.
Object.defineProperty(exports, "__esModule", { value: true });
exports.KNOWN_AGENT_ENV_VARS = exports.KNOWN_AGENT_LOGINS = exports.KNOWN_AGENT_EMAILS = void 0;
exports.isAgentEmail = isAgentEmail;
exports.isAgentLogin = isAgentLogin;
exports.isAgentEnv = isAgentEnv;
exports.isAgentIdentity = isAgentIdentity;
exports.KNOWN_AGENT_EMAILS = [
    'devin-ai-integration[bot]@users.noreply.github.com',
    'devin@cognition.ai',
    'noreply@anthropic.com',
    'copilot-swe-agent[bot]@users.noreply.github.com',
];
exports.KNOWN_AGENT_LOGINS = [
    'devin-ai-integration[bot]',
    'copilot-swe-agent[bot]',
];
exports.KNOWN_AGENT_ENV_VARS = [
    'CLAUDE_CODE',
    'CURSOR_AGENT',
    'WINDSURF_AGENT',
    'DEVIN_SESSION_ID',
];
function isAgentEmail(email) {
    if (!email)
        return false;
    const e = email.toLowerCase();
    return exports.KNOWN_AGENT_EMAILS.some((known) => e.includes(known.toLowerCase()));
}
function isAgentLogin(login) {
    if (!login)
        return false;
    return exports.KNOWN_AGENT_LOGINS.some((known) => login.includes(known));
}
function isAgentEnv() {
    return exports.KNOWN_AGENT_ENV_VARS.some((v) => !!process.env[v]);
}
function isAgentIdentity(input) {
    return isAgentEmail(input.email) || isAgentLogin(input.login);
}
//# sourceMappingURL=agents.js.map