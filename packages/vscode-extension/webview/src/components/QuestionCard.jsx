import React from 'react';
import { FileCode, Tag } from 'lucide-react';

export default function QuestionCard({ question }) {
  if (!question) return null;
  return (
    <article style={styles.card}>
      <div style={styles.meta}>
        {question.concept_tag && (
          <span style={styles.tag}>
            <Tag size={11} /> {question.concept_tag}
          </span>
        )}
        {question.code_context && (
          <span style={styles.context}>
            <FileCode size={12} /> {question.code_context}
          </span>
        )}
      </div>
      <h2 style={styles.q}>{question.question}</h2>
    </article>
  );
}

const styles = {
  card: {
    padding: '20px 22px',
    borderRadius: 12,
    border: '1px solid var(--vscode-widget-border, #2c2c2c)',
    background: 'var(--vscode-editorWidget-background, rgba(255,255,255,0.02))',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  meta: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    flexWrap: 'wrap',
  },
  tag: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    padding: '3px 8px',
    borderRadius: 999,
    background: 'var(--vscode-badge-background, #4d4d4d)',
    color: 'var(--vscode-badge-foreground, #fff)',
    fontSize: 11,
    fontWeight: 500,
  },
  context: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    fontSize: 12,
    color: 'var(--vscode-descriptionForeground, #999)',
    fontFamily: 'var(--vscode-editor-font-family, ui-monospace, monospace)',
  },
  q: {
    margin: 0,
    fontSize: 18,
    lineHeight: 1.45,
    fontWeight: 500,
    color: 'var(--vscode-foreground, #eee)',
  },
};
