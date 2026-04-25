import React, { useEffect, useMemo, useState } from 'react';
import {
  Sparkles,
  ChevronLeft,
  ChevronRight,
  Check,
  X,
  AlertTriangle,
  FileCode,
  Send,
  Mic,
  SkipForward,
} from 'lucide-react';
import QuestionCard from './components/QuestionCard.jsx';
import VoiceButton from './components/VoiceButton.jsx';
import ScoreFeedback from './components/ScoreFeedback.jsx';
import OverrideModal from './components/OverrideModal.jsx';
import ProgressDots from './components/ProgressDots.jsx';
import TriggerBadge from './components/TriggerBadge.jsx';

const vscodeApi =
  typeof window !== 'undefined' && typeof window.acquireVsCodeApi === 'function'
    ? window.acquireVsCodeApi()
    : null;

function send(msg) {
  if (vscodeApi) vscodeApi.postMessage(msg);
  else console.log('[webview→host]', msg);
}

const MOCK = {
  sessionId: 'demo-session',
  trigger: 'velocity',
  questions: [
    {
      question:
        'Walk me through what the AI-generated code in extension.ts:42-58 does, and why this approach over alternatives.',
      concept_tag: 'event subscription',
      code_context: 'extension.ts:42-58',
      file: 'extension.ts',
    },
    {
      question:
        'What happens when onDidChangeTextDocument fires while a burst is already in progress?',
      concept_tag: 'burst aggregation',
      code_context: 'velocityDetector.ts:80-107',
      file: 'velocityDetector.ts',
    },
  ],
};

export default function CheckpointApp({ init }) {
  const data = init && init.questions ? init : MOCK;
  const questions = data.questions ?? [];

  const [index, setIndex] = useState(0);
  const [mode, setMode] = useState('voice'); // 'voice' | 'text'
  const [transcript, setTranscript] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [scores, setScores] = useState({}); // checkpointId -> score
  const [overrideOpen, setOverrideOpen] = useState(false);

  const current = questions[index];
  const checkpointId = useMemo(
    () => `${data.sessionId}-${index}`,
    [data.sessionId, index]
  );
  const score = scores[checkpointId];
  const isLast = index === questions.length - 1;

  // Listen for SCORE messages from the extension host.
  useEffect(() => {
    function onMessage(e) {
      const msg = e.data;
      if (msg?.type === 'SCORE') {
        setScores((prev) => ({ ...prev, [msg.checkpointId]: msg.score }));
        setSubmitting(false);
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // Keyboard shortcut: Cmd/Ctrl+Enter submits.
  useEffect(() => {
    function onKey(e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && transcript.trim() && !submitting) {
        submit();
      }
      if (e.key === 'Escape' && overrideOpen) setOverrideOpen(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  function submit() {
    if (!transcript.trim()) return;
    setSubmitting(true);
    send({
      type: 'SUBMIT_TRANSCRIPT',
      sessionId: data.sessionId,
      checkpointId,
      transcript: transcript.trim(),
    });
  }

  function pass() {
    send({ type: 'PASS', sessionId: data.sessionId, checkpointId });
    next();
  }

  function next() {
    setTranscript('');
    if (index < questions.length - 1) setIndex((i) => i + 1);
    else send({ type: 'CLOSE' });
  }

  function prev() {
    if (index === 0) return;
    setTranscript('');
    setIndex((i) => i - 1);
  }

  function override(reason) {
    send({ type: 'OVERRIDE', sessionId: data.sessionId, reason });
    setOverrideOpen(false);
    send({ type: 'CLOSE' });
  }

  function retry() {
    setScores((prev) => {
      const next = { ...prev };
      delete next[checkpointId];
      return next;
    });
    setTranscript('');
  }

  if (!current) return <EmptyState />;

  return (
    <div style={styles.root}>
      <header style={styles.header}>
        <div style={styles.headerLeft}>
          <TriggerBadge trigger={data.trigger} />
          <span style={styles.sessionId}>
            session {String(data.sessionId).slice(0, 14)}…
          </span>
        </div>
        <button
          style={styles.iconBtn}
          onClick={() => send({ type: 'CLOSE' })}
          aria-label="Close"
          title="Close (Esc)"
        >
          <X size={16} />
        </button>
      </header>

      <ProgressDots total={questions.length} current={index} />

      <main style={styles.main} className="vc-fade-in" key={index}>
        <QuestionCard question={current} />

        {!score && (
          <section style={styles.answerSection}>
            <div style={styles.tabs}>
              <Tab
                active={mode === 'voice'}
                onClick={() => setMode('voice')}
                icon={<Mic size={14} />}
                label="Voice"
              />
              <Tab
                active={mode === 'text'}
                onClick={() => setMode('text')}
                icon={<FileCode size={14} />}
                label="Text"
              />
            </div>

            {mode === 'voice' && (
              <VoiceButton
                onTranscript={(t) =>
                  setTranscript((prev) => `${prev}${prev ? ' ' : ''}${t}`)
                }
              />
            )}

            <textarea
              value={transcript}
              onChange={(e) => setTranscript(e.target.value)}
              placeholder={
                mode === 'voice'
                  ? 'Your transcribed answer will appear here. Edit before submitting.'
                  : 'Explain in your own words…'
              }
              style={styles.textarea}
              rows={5}
            />

            <div style={styles.hintRow}>
              <span style={styles.hint}>
                <kbd style={styles.kbd}>⌘</kbd>
                <kbd style={styles.kbd}>↵</kbd> submit ·{' '}
                <kbd style={styles.kbd}>Esc</kbd> close
              </span>
            </div>

            <div style={styles.actions}>
              <button
                onClick={submit}
                disabled={!transcript.trim() || submitting}
                style={{
                  ...styles.primaryBtn,
                  opacity: !transcript.trim() || submitting ? 0.5 : 1,
                }}
              >
                <Send size={14} />
                {submitting ? 'Scoring…' : 'Submit answer'}
              </button>
              <button
                onClick={pass}
                style={styles.secondaryBtn}
                title="I already understand this"
              >
                <Check size={14} /> I get it
              </button>
              <button
                onClick={next}
                style={styles.ghostBtn}
                title="Skip this question"
              >
                <SkipForward size={14} /> Skip
              </button>
            </div>
          </section>
        )}

        {score && (
          <ScoreFeedback
            score={score}
            onContinue={next}
            onRetry={retry}
            isLast={isLast}
          />
        )}
      </main>

      <footer style={styles.footer}>
        <button
          onClick={prev}
          disabled={index === 0}
          style={{ ...styles.navBtn, opacity: index === 0 ? 0.4 : 1 }}
        >
          <ChevronLeft size={14} /> Previous
        </button>
        <button onClick={() => setOverrideOpen(true)} style={styles.overrideBtn}>
          <AlertTriangle size={14} /> Override
        </button>
        <button
          onClick={next}
          disabled={isLast && !score}
          style={{ ...styles.navBtn, opacity: isLast && !score ? 0.4 : 1 }}
        >
          {isLast ? 'Finish' : 'Next'} <ChevronRight size={14} />
        </button>
      </footer>

      {overrideOpen && (
        <OverrideModal
          onCancel={() => setOverrideOpen(false)}
          onConfirm={override}
        />
      )}
    </div>
  );
}

function Tab({ active, onClick, icon, label }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '8px 14px',
        background: active
          ? 'var(--vscode-tab-activeBackground, rgba(255,255,255,0.04))'
          : 'transparent',
        color: active
          ? 'var(--vscode-tab-activeForeground, #fff)'
          : 'var(--vscode-tab-inactiveForeground, #aaa)',
        borderTop: 'none',
        borderLeft: 'none',
        borderRight: 'none',
        borderBottom: active
          ? '2px solid var(--vscode-focusBorder, #007acc)'
          : '2px solid transparent',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 13,
      }}
    >
      {icon}
      {label}
    </button>
  );
}

function EmptyState() {
  return (
    <div
      style={{
        ...styles.root,
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
      }}
    >
      <Sparkles size={32} style={{ opacity: 0.4 }} />
      <h2 style={{ margin: '12px 0 4px' }}>No questions yet</h2>
      <p style={{ opacity: 0.6, margin: 0 }}>
        VibeCheck didn't find any unverified AI regions.
      </p>
    </div>
  );
}

const styles = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    minHeight: '100vh',
    maxWidth: 760,
    margin: '0 auto',
    padding: '20px 24px 28px',
    gap: 18,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  headerLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
  },
  sessionId: {
    fontSize: 12,
    opacity: 0.5,
    fontFamily: 'var(--vscode-editor-font-family, ui-monospace, monospace)',
  },
  iconBtn: {
    width: 28,
    height: 28,
    borderRadius: 6,
    background: 'transparent',
    border: '1px solid var(--vscode-widget-border, #444)',
    color: 'var(--vscode-foreground, #ddd)',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  main: {
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
    flex: 1,
  },
  answerSection: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    padding: 16,
    border: '1px solid var(--vscode-widget-border, #333)',
    borderRadius: 10,
    background: 'var(--vscode-editorWidget-background, rgba(255,255,255,0.02))',
  },
  tabs: {
    display: 'flex',
    gap: 4,
    borderBottom: '1px solid var(--vscode-widget-border, #333)',
    marginBottom: 4,
  },
  textarea: {
    width: '100%',
    minHeight: 100,
    padding: 12,
    borderRadius: 8,
    border: '1px solid var(--vscode-input-border, #555)',
    background: 'var(--vscode-input-background, #1e1e1e)',
    color: 'var(--vscode-input-foreground, #ddd)',
    resize: 'vertical',
    outline: 'none',
    lineHeight: 1.5,
  },
  hintRow: { display: 'flex', justifyContent: 'flex-end' },
  hint: {
    fontSize: 11,
    opacity: 0.55,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
  },
  kbd: {
    fontFamily: 'var(--vscode-editor-font-family, ui-monospace, monospace)',
    fontSize: 10,
    padding: '1px 5px',
    borderRadius: 4,
    background: 'var(--vscode-keybindingLabel-background, #2a2a2a)',
    border: '1px solid var(--vscode-keybindingLabel-border, #444)',
    color: 'var(--vscode-keybindingLabel-foreground, #ddd)',
    margin: '0 2px',
  },
  actions: {
    display: 'flex',
    gap: 8,
    flexWrap: 'wrap',
    marginTop: 4,
  },
  primaryBtn: {
    padding: '10px 16px',
    borderRadius: 8,
    border: 'none',
    background: 'var(--vscode-button-background, #0e639c)',
    color: 'var(--vscode-button-foreground, #fff)',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    fontWeight: 500,
  },
  secondaryBtn: {
    padding: '10px 14px',
    borderRadius: 8,
    border: '1px solid var(--vscode-button-border, #555)',
    background: 'var(--vscode-button-secondaryBackground, transparent)',
    color: 'var(--vscode-button-secondaryForeground, #ddd)',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
  },
  ghostBtn: {
    padding: '10px 14px',
    borderRadius: 8,
    border: 'none',
    background: 'transparent',
    color: 'var(--vscode-descriptionForeground, #aaa)',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
  },
  footer: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: 14,
    borderTop: '1px solid var(--vscode-widget-border, #333)',
  },
  navBtn: {
    padding: '8px 12px',
    borderRadius: 6,
    border: '1px solid var(--vscode-widget-border, #444)',
    background: 'transparent',
    color: 'var(--vscode-foreground, #ddd)',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
  },
  overrideBtn: {
    padding: '8px 12px',
    borderRadius: 6,
    border: 'none',
    background: 'transparent',
    color: 'var(--vscode-errorForeground, #f48771)',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
  },
};
