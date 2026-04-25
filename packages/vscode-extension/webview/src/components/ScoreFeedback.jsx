import React from 'react';

export default function ScoreFeedback({ score }) {
  if (!score) return null;
  return (
    <div style={{ marginTop: 16, padding: 16, borderRadius: 8, background: '#222' }}>
      <h3>{score.passed ? '✅ Passed' : '⚠️ Re-read suggested'}</h3>
      <p>{score.feedback}</p>
    </div>
  );
}
