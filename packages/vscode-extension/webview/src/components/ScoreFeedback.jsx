import React from 'react';
import { CheckCircle2, AlertTriangle, ArrowRight, RotateCcw } from 'lucide-react';

export default function ScoreFeedback({ score, onContinue, onRetry, isLast }) {
  if (!score) return null;
  const value = typeof score.value === 'number' ? score.value : score.passed ? 0.85 : 0.4;
  const passed = score.passed ?? value >= 0.6;
  const pct = Math.round(value * 100);

  const accent = passed
    ? 'var(--vscode-testing-iconPassed, #4ec9b0)'
    : 'var(--vscode-testing-iconFailed, #f48771)';

  return (
    <section style={styles.box} className="vc-fade-in">
      <div style={styles.header}>
        <Ring pct={pct} stroke={accent} />
        <div style={{ flex: 1 }}>
          <h3 style={{ ...styles.title, color: accent }}>
            {passed ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />}
            {passed ? 'Comprehension verified' : 'Re-read suggested'}
          </h3>
          <p style={styles.feedback}>{score.feedback ?? '—'}</p>
        </div>
      </div>
      <div style={styles.actions}>
        {!passed && onRetry && (
          <button onClick={onRetry} style={styles.secondary}>
            <RotateCcw size={14} /> Try again
          </button>
        )}
        {onContinue && (
          <button onClick={onContinue} style={styles.primary}>
            {isLast ? 'Finish' : 'Next question'} <ArrowRight size={14} />
          </button>
        )}
      </div>
    </section>
  );
}

function Ring({ pct, stroke }) {
  const r = 26;
  const c = 2 * Math.PI * r;
  const offset = c - (Math.max(0, Math.min(100, pct)) / 100) * c;
  return (
    <svg width="64" height="64" viewBox="0 0 64 64" style={{ flexShrink: 0 }}>
      <circle
        cx="32"
        cy="32"
        r={r}
        stroke="var(--vscode-widget-border, #333)"
        strokeWidth="6"
        fill="none"
      />
      <circle
        cx="32"
        cy="32"
        r={r}
        stroke={stroke}
        strokeWidth="6"
        fill="none"
        strokeDasharray={c}
        strokeDashoffset={offset}
        strokeLinecap="round"
        transform="rotate(-90 32 32)"
        style={{ transition: 'stroke-dashoffset 600ms ease' }}
      />
      <text
        x="32"
        y="37"
        textAnchor="middle"
        fontSize="14"
        fill="currentColor"
        fontWeight="600"
      >
        {pct}
      </text>
    </svg>
  );
}

const styles = {
  box: {
    padding: 18,
    borderRadius: 10,
    border: '1px solid var(--vscode-widget-border, #333)',
    background: 'var(--vscode-editorWidget-background, rgba(255,255,255,0.02))',
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
  },
  header: { display: 'flex', alignItems: 'center', gap: 16 },
  title: {
    margin: '0 0 6px',
    fontSize: 15,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
  },
  feedback: { margin: 0, opacity: 0.85, lineHeight: 1.5, fontSize: 13 },
  actions: { display: 'flex', justifyContent: 'flex-end', gap: 8 },
  primary: {
    padding: '8px 14px',
    borderRadius: 8,
    border: 'none',
    background: 'var(--vscode-button-background, #0e639c)',
    color: 'var(--vscode-button-foreground, #fff)',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    fontWeight: 500,
  },
  secondary: {
    padding: '8px 14px',
    borderRadius: 8,
    border: '1px solid var(--vscode-button-border, #555)',
    background: 'transparent',
    color: 'var(--vscode-foreground, #ddd)',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
  },
};
