import React from 'react';

export default function QuestionCard({ question }) {
  return (
    <div style={{ padding: 16, border: '1px solid #444', borderRadius: 8, marginBottom: 12 }}>
      <p style={{ fontSize: 14, opacity: 0.6 }}>
        {question?.code_context ?? 'file.ts:0-0'}
      </p>
      <p style={{ fontSize: 18 }}>
        {question?.question ?? 'Walk me through what this code does.'}
      </p>
    </div>
  );
}
