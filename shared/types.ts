// Shared TypeScript interfaces for VibeCheck.
// Mirrored on the Python side in packages/api/db/schema.py.

export interface GeneratedQuestion {
  question: string;
  concept_tag: string;     // e.g. "async patterns", "error handling"
  code_context: string;    // e.g. "redis_cache.py:23-31"
  file: string;
}

export interface ComprehensionScore {
  what_it_does: number;        // 0.0 - 1.0
  why_this_approach: number;   // 0.0 - 1.0
  tradeoffs: number;           // 0.0 - 1.0
  overall: number;             // weighted average
  passed: boolean;             // overall >= 0.65 AND no dimension < 0.4
  feedback: string;
  concepts_weak: string[];
  concepts_strong: string[];
}

export type CheckpointTrigger = 'velocity' | 'pre_commit' | 'devin_pr';

export interface Checkpoint {
  checkpoint_id: string;
  trigger: CheckpointTrigger;
  triggered_at: string;        // ISO timestamp
  file: string;
  diff_excerpt: string;
  question: GeneratedQuestion;
  transcript?: string;
  score?: ComprehensionScore;
  skipped: boolean;
  override_used: boolean;
}

export interface Session {
  session_id: string;
  user_id: string;             // git config user.email
  repo: string;
  branch: string;
  started_at: string;
  checkpoints: Checkpoint[];
  commit_sha?: string;
  devin_pr_url?: string;
}

export interface GrowthData {
  sessions: Session[];
  concept_scores: Record<string, number>;
  overall_trajectory: number[];
  total_checkpoints: number;
  skipped_count: number;
  override_count: number;
  devin_prs_reviewed?: number;
}

export type CheckpointMode = 'inline' | 'commit' | 'devin_pr';

export interface GenerateRequest {
  diff: string;
  claude_md: string;
  user_email: string;
  diff_lines: number;
  mode: CheckpointMode;
  skipped_sections?: string[];
}

export interface GenerateResponse {
  session_id: string;
  questions: GeneratedQuestion[];
}

export interface VerifyRequest {
  session_id: string;
  checkpoint_id: string;
  transcript: string;
}

export interface VerifyResponse {
  score: ComprehensionScore;
}

export interface ChangedFunction {
  filePath: string;
  functionName: string;
  startLine: number;
  endLine: number;
}

// Temporary probe to validate ts-morph cross-root reference resolution.
export function sharedReferenceProbe(seed: string): string {
  return `probe:${seed}`;
}
