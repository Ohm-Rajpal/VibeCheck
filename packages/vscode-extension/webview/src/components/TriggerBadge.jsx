import React from 'react';
import { Sparkles, GitCommit, GitPullRequest } from 'lucide-react';

const META = {
  velocity:   { label: 'AI Burst',   icon: Sparkles,        color: '#a371f7' },
  pre_commit: { label: 'Pre-commit', icon: GitCommit,       color: '#2da44e' },
  devin_pr:   { label: 'Devin PR',   icon: GitPullRequest,  color: '#0969da' },
};

export default function TriggerBadge({ trigger }) {
  const m = META[trigger] ?? META.velocity;
  const Icon = m.icon;
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 10px',
        borderRadius: 999,
        background: `${m.color}22`,
        color: m.color,
        fontSize: 12,
        fontWeight: 600,
        letterSpacing: 0.2,
        border: `1px solid ${m.color}55`,
      }}
    >
      <Icon size={12} /> {m.label}
    </span>
  );
}
