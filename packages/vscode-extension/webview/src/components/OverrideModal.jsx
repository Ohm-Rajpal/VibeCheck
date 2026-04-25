import React, { useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';

export default function OverrideModal({ onCancel, onConfirm }) {
  const [reason, setReason] = useState('');
  return (
    <div style={styles.overlay} onClick={onCancel}>
      <div
        style={styles.modal}
        onClick={(e) => e.stopPropagation()}
        className="vc-fade-in"
      >
        <header style={styles.header}>
          <h3 style={styles.title}>
            <AlertTriangle size={16} /> Override comprehension check
          </h3>
          <button style={styles.close} onClick={onCancel} aria-label="Close">
            <X size={14} />
          </button>
        </header>
        <p style={styles.body}>
          Skipping leaves AI-generated regions marked unverified. Tell us why
          (this gets logged to your growth dashboard).
        </p>
        <textarea
          autoFocus
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g., trivial change, will review tomorrow, blocked on a meeting…"
          style={styles.textarea}
          rows={3}
        />
        <div style={styles.actions}>
          <button onClick={onCancel} style={styles.cancel}>
            Cancel
          </button>
          <button
            onClick={() => onConfirm(reason.trim() || 'no reason given')}
            style={styles.confirm}
          >
            Override anyway
          </button>
        </div>
      </div>
    </div>
  );
}

const styles = {
  overlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.6)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
    zIndex: 100,
  },
  modal: {
    width: '100%',
    maxWidth: 460,
    background: 'var(--vscode-editor-background, #1e1e1e)',
    border: '1px solid var(--vscode-widget-border, #333)',
    borderRadius: 12,
    padding: 20,
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
    boxShadow: '0 10px 30px rgba(0,0,0,0.4)',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  title: {
    margin: 0,
    fontSize: 14,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    color: 'var(--vscode-errorForeground, #f48771)',
  },
  close: {
    background: 'transparent',
    border: 'none',
    color: 'inherit',
    width: 24,
    height: 24,
    borderRadius: 4,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: { margin: 0, opacity: 0.75, fontSize: 13, lineHeight: 1.5 },
  textarea: {
    width: '100%',
    padding: 10,
    borderRadius: 8,
    border: '1px solid var(--vscode-input-border, #555)',
    background: 'var(--vscode-input-background, #1e1e1e)',
    color: 'var(--vscode-input-foreground, #ddd)',
    resize: 'vertical',
    outline: 'none',
  },
  actions: { display: 'flex', justifyContent: 'flex-end', gap: 8 },
  cancel: {
    padding: '8px 14px',
    borderRadius: 8,
    border: '1px solid var(--vscode-widget-border, #555)',
    background: 'transparent',
    color: 'var(--vscode-foreground, #ddd)',
  },
  confirm: {
    padding: '8px 14px',
    borderRadius: 8,
    border: 'none',
    background: 'var(--vscode-errorForeground, #f48771)',
    color: '#fff',
    fontWeight: 500,
  },
};
