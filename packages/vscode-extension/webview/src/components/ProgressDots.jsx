import React from 'react';

export default function ProgressDots({ total, current }) {
  if (total <= 1) return null;
  return (
    <div style={styles.row}>
      <span style={styles.label}>
        Question {current + 1} of {total}
      </span>
      <div style={styles.track}>
        {Array.from({ length: total }).map((_, i) => (
          <span
            key={i}
            style={{
              ...styles.dot,
              background:
                i < current
                  ? 'var(--vscode-testing-iconPassed, #4ec9b0)'
                  : i === current
                  ? 'var(--vscode-button-background, #0e639c)'
                  : 'var(--vscode-widget-border, #444)',
              width: i === current ? 24 : 8,
            }}
          />
        ))}
      </div>
    </div>
  );
}

const styles = {
  row: { display: 'flex', flexDirection: 'column', gap: 6 },
  label: {
    fontSize: 12,
    opacity: 0.6,
    fontFamily: 'var(--vscode-editor-font-family, ui-monospace, monospace)',
  },
  track: { display: 'flex', gap: 4, alignItems: 'center' },
  dot: {
    height: 8,
    borderRadius: 999,
    transition: 'all 200ms ease',
  },
};
