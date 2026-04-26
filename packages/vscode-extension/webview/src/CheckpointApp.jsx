import React, { useEffect, useRef, useState } from 'react';
import {
  Brain,
  Send,
  Mic,
  Type as TypeIcon,
  Volume2,
  Copy,
  Check,
  ArrowRight,
  RefreshCcw,
  Square,
  Sparkles,
} from 'lucide-react';

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
  ],
};

function triggerLabel(t) {
  if (t === 'pre_commit') return 'Pre-commit Check';
  if (t === 'devin_pr') return 'Devin PR Review';
  return 'AI Burst Detected';
}

function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = String(sec % 60).padStart(2, '0');
  return `${m}:${s}`;
}

export default function CheckpointApp({ init }) {
  const data = init && init.questions && init.questions.length ? init : MOCK;
  const question = data.questions[0]; // single-question flow per the design spec
  const sessionId = data.sessionId;
  const trigger = data.trigger;
  const checkpointId = `${sessionId}-0`;

  const [mode, setMode] = useState('text'); // 'text' | 'audio'
  const [textAnswer, setTextAnswer] = useState('');
  const [recState, setRecState] = useState('ready'); // 'ready' | 'recording' | 'complete'
  const [duration, setDuration] = useState(0);
  const [audioTranscript, setAudioTranscript] = useState('');
  const [submittedPayload, setSubmittedPayload] = useState(null);
  const [submitted, setSubmitted] = useState(false);
  const [copied, setCopied] = useState(false);

  // Listen for SCORE messages from the extension host (currently we transition
  // to the success view immediately on submit; SCORE is captured but unused).
  useEffect(() => {
    function onMessage(e) {
      // Hook here later if the host sends SCORE/feedback to display.
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  function submit() {
    if (mode === 'text') {
      const value = textAnswer.trim();
      if (!value) return;
      send({ type: 'SUBMIT_TRANSCRIPT', sessionId, checkpointId, transcript: value });
      setSubmittedPayload({ type: 'text', value });
    } else {
      const value = audioTranscript.trim();
      if (recState !== 'complete' || !value) return;
      send({ type: 'SUBMIT_TRANSCRIPT', sessionId, checkpointId, transcript: value });
      setSubmittedPayload({ type: 'audio', value, duration });
    }
    setSubmitted(true);
  }

  function reset() {
    setSubmitted(false);
    setSubmittedPayload(null);
    setTextAnswer('');
    setAudioTranscript('');
    setRecState('ready');
    setDuration(0);
    setCopied(false);
  }

  function copyAnswer() {
    const value = submittedPayload?.value;
    if (!value) return;
    navigator.clipboard?.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  }

  const canSubmit =
    (mode === 'text' && textAnswer.trim().length > 0) ||
    (mode === 'audio' && recState === 'complete' && audioTranscript.trim().length > 0);

  return (
    <div className="vc-page">
      <Orbs />
      <div className="vc-container">
        {!submitted ? (
          <FormView
            question={question}
            trigger={trigger}
            mode={mode}
            setMode={setMode}
            textAnswer={textAnswer}
            setTextAnswer={setTextAnswer}
            recState={recState}
            setRecState={setRecState}
            duration={duration}
            setDuration={setDuration}
            audioTranscript={audioTranscript}
            setAudioTranscript={setAudioTranscript}
            canSubmit={canSubmit}
            onSubmit={submit}
          />
        ) : (
          <SuccessView
            question={question}
            payload={submittedPayload}
            onAnother={reset}
            onCopy={copyAnswer}
            copied={copied}
          />
        )}
      </div>
    </div>
  );
}

function Orbs() {
  const orbs = [
    { top: '-8%', left: '-10%', size: 320, color: 'rgba(59,130,246,0.55)', delay: '0ms' },
    { top: '18%', right: '-12%', size: 360, color: 'rgba(168,85,247,0.50)', delay: '100ms' },
    { bottom: '8%', left: '8%', size: 300, color: 'rgba(139,92,246,0.50)', delay: '200ms' },
    { top: '38%', left: '38%', size: 280, color: 'rgba(34,211,238,0.45)', delay: '150ms' },
    { bottom: '-6%', right: '18%', size: 340, color: 'rgba(236,72,153,0.50)', delay: '300ms' },
  ];
  return (
    <div className="vc-orbs" aria-hidden="true">
      {orbs.map((o, i) => (
        <div
          key={i}
          className="vc-orb"
          style={{
            top: o.top,
            left: o.left,
            right: o.right,
            bottom: o.bottom,
            width: o.size,
            height: o.size,
            background: `radial-gradient(circle, ${o.color}, transparent 65%)`,
            animationDelay: o.delay,
          }}
        />
      ))}
    </div>
  );
}

function FormView({
  question,
  trigger,
  mode,
  setMode,
  textAnswer,
  setTextAnswer,
  recState,
  setRecState,
  duration,
  setDuration,
  audioTranscript,
  setAudioTranscript,
  canSubmit,
  onSubmit,
}) {
  return (
    <>
      <header className="vc-header">
        <span className="vc-badge-pill vc-slide-up">
          <Sparkles size={12} /> {triggerLabel(trigger)}
        </span>
        <h1 className="vc-heading vc-slide-up vc-delay-100">Comprehension Check</h1>
        <p className="vc-subtitle vc-fade-in vc-delay-200">
          Share your understanding of the code AI just wrote.
        </p>
      </header>

      <div className="vc-card vc-slide-up vc-delay-200">
        <section className="vc-section vc-question-section">
          <div className="vc-question-row">
            <div className="vc-question-icon">
              <Brain size={22} />
            </div>
            <div style={{ minWidth: 0 }}>
              <div className="vc-question-label">📝 Question</div>
              <p className="vc-question-text">{question.question}</p>
              {question.code_context && (
                <p className="vc-question-context">📍 {question.code_context}</p>
              )}
            </div>
          </div>
        </section>

        <section className="vc-section">
          <label className="vc-method-label">How would you like to answer?</label>
          <div className="vc-toggle-grid">
            <button
              className={`vc-toggle text${mode === 'text' ? ' active' : ''}`}
              onClick={() => setMode('text')}
              type="button"
            >
              <TypeIcon size={16} /> ✍️ Type Answer
            </button>
            <button
              className={`vc-toggle audio${mode === 'audio' ? ' active' : ''}`}
              onClick={() => setMode('audio')}
              type="button"
            >
              <Mic size={16} /> 🎙️ Record Audio
            </button>
          </div>
        </section>

        <section className="vc-section">
          {mode === 'text' ? (
            <TextInput value={textAnswer} onChange={setTextAnswer} />
          ) : (
            <AudioRecorder
              state={recState}
              setState={setRecState}
              duration={duration}
              setDuration={setDuration}
              transcript={audioTranscript}
              setTranscript={setAudioTranscript}
            />
          )}
        </section>

        <section className="vc-section vc-submit-section">
          <button className="vc-submit-btn" onClick={onSubmit} disabled={!canSubmit}>
            🚀 Submit Answer <Send size={16} />
          </button>
        </section>
      </div>
    </>
  );
}

function TextInput({ value, onChange }) {
  return (
    <>
      <label className="vc-textarea-label">✨ Your Answer</label>
      <textarea
        className="vc-textarea"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Walk through what this code does, the trade-offs you see, and any concerns you'd flag in a review…"
      />
      <span className="vc-counter">{value.length} characters</span>
    </>
  );
}

function AudioRecorder({ state, setState, duration, setDuration, transcript, setTranscript }) {
  const recognitionRef = useRef(null);
  const timerRef = useRef(null);
  const finalRef = useRef('');
  const [interim, setInterim] = useState('');
  const [error, setError] = useState('');

  function getRecognition() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return null;
    const r = new SR();
    r.continuous = true;
    r.interimResults = true;
    r.lang = 'en-US';
    return r;
  }

  async function start() {
    setError('');

    // Step 1: explicitly request mic permission via getUserMedia. Without this
    // the SpeechRecognition API often fails immediately with `not-allowed` in
    // VS Code's Electron webview because the permission prompt never fires.
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      console.warn('[VibeCheck] getUserMedia failed', err);
      const name = err && err.name;
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        setError(
          'Microphone permission denied. Open Windows Settings → Privacy & security → Microphone, allow desktop apps, then restart VS Code and try again.'
        );
      } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
        setError('No microphone detected on this device.');
      } else if (name === 'NotReadableError') {
        setError('Mic is in use by another app. Close it and try again.');
      } else {
        setError('Could not access the microphone. Use text mode instead.');
      }
      return;
    }

    // We don't actually need to keep the stream open — SpeechRecognition will
    // open its own. Stop the tracks immediately to release the indicator.
    stream.getTracks().forEach((t) => t.stop());

    // Step 2: start the speech recognition engine.
    const recognition = getRecognition();
    if (!recognition) {
      setError(
        'Speech recognition is not available in this environment. Please use text mode instead.'
      );
      return;
    }

    finalRef.current = '';
    setTranscript('');
    setInterim('');

    recognition.onresult = (event) => {
      let interimText = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        const text = res[0].transcript;
        if (res.isFinal) {
          finalRef.current += (finalRef.current ? ' ' : '') + text.trim();
        } else {
          interimText += text;
        }
      }
      setInterim(interimText);
      setTranscript((finalRef.current + (interimText ? ' ' + interimText : '')).trim());
    };

    recognition.onerror = (e) => {
      console.warn('[VibeCheck] speech recognition error', e);
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        setError(
          'Speech recognition was blocked. Restart VS Code and re-allow mic access when prompted.'
        );
      } else if (e.error === 'no-speech') {
        // ignore — common when there's a silence gap
        return;
      } else if (e.error === 'audio-capture') {
        setError('No microphone detected.');
      } else if (e.error === 'network') {
        setError(
          'Speech recognition needs an internet connection (it routes through Google). Check your network.'
        );
      } else {
        setError(`Speech recognition error: ${e.error}`);
      }
    };

    recognition.onend = () => {
      clearInterval(timerRef.current);
      setInterim('');
      setState((curr) => (curr === 'recording' ? 'complete' : curr));
    };

    try {
      recognition.start();
      recognitionRef.current = recognition;
      setDuration(0);
      setState('recording');
      timerRef.current = setInterval(() => setDuration((d) => d + 1), 1000);
    } catch (err) {
      console.warn('[VibeCheck] failed to start recognition', err);
      setError('Could not start recording. Try again or switch to text mode.');
    }
  }

  function stop() {
    try {
      recognitionRef.current?.stop();
    } catch {}
  }

  function rerec() {
    finalRef.current = '';
    setTranscript('');
    setInterim('');
    setDuration(0);
    setError('');
    setState('ready');
  }

  useEffect(
    () => () => {
      clearInterval(timerRef.current);
      try {
        recognitionRef.current?.abort();
      } catch {}
    },
    []
  );

  if (state === 'ready') {
    return (
      <div className="vc-rec-box vc-rec-ready vc-fade-in">
        <div className="vc-rec-icon ready">
          <Mic size={32} />
        </div>
        <h3 className="vc-rec-title">Ready to record</h3>
        <p className="vc-rec-text">
          Click Start and explain in your own words — words appear live as you speak.
        </p>
        {error && <p className="vc-rec-error">{error}</p>}
        <div className="vc-rec-actions">
          <button className="vc-glow-btn start" onClick={start} type="button">
            <Mic size={16} /> Start recording
          </button>
        </div>
      </div>
    );
  }

  if (state === 'recording') {
    const finalText = finalRef.current;
    return (
      <div className="vc-rec-box vc-rec-recording vc-fade-in">
        <div className="vc-rec-dots">
          <span className="vc-rec-dot" />
          <span className="vc-rec-dot" />
          <span className="vc-rec-dot" />
        </div>
        <div className="vc-timer">{formatTime(duration)}</div>
        <p className="vc-rec-text" style={{ color: '#fecaca' }}>
          🔴 Recording — speak clearly
        </p>

        <div className="vc-live-transcript">
          {finalText || interim ? (
            <p className="vc-live-text">
              <span className="vc-live-final">{finalText}</span>
              {interim && (
                <span className="vc-live-interim">
                  {finalText ? ' ' : ''}
                  {interim}
                </span>
              )}
            </p>
          ) : (
            <p className="vc-live-placeholder">Listening… start speaking now.</p>
          )}
        </div>

        {error && <p className="vc-rec-error">{error}</p>}

        <div className="vc-rec-actions">
          <button className="vc-glow-btn stop" onClick={stop} type="button">
            <Square size={14} fill="#fff" /> Stop
          </button>
        </div>
      </div>
    );
  }

  // complete
  return (
    <div className="vc-rec-box vc-rec-complete vc-fade-in">
      <div className="vc-rec-icon complete">
        <Volume2 size={32} />
      </div>
      <h3 className="vc-rec-title">✅ Recording complete</h3>
      <p className="vc-rec-text">
        Length: {formatTime(duration)} · edit the transcript below if anything's off
      </p>

      <textarea
        className="vc-textarea vc-transcript-edit"
        value={transcript}
        onChange={(e) => {
          finalRef.current = e.target.value;
          setTranscript(e.target.value);
        }}
        placeholder="Your transcribed answer will appear here…"
      />

      {error && <p className="vc-rec-error">{error}</p>}

      <div className="vc-rec-actions">
        <button className="vc-glow-btn rerec" onClick={rerec} type="button">
          <RefreshCcw size={14} /> Re-record
        </button>
      </div>
    </div>
  );
}

function SuccessView({ question, payload, onAnother, onCopy, copied }) {
  return (
    <div className="vc-success-card vc-slide-up">
      <header className="vc-success-header">
        <div className="vc-success-icon-circle">
          <Check size={28} strokeWidth={3} />
        </div>
        <div>
          <h2 className="vc-success-title">Answer submitted</h2>
          <p className="vc-success-sub">
            Nice work — VibeCheck logged your comprehension.
          </p>
        </div>
      </header>

      <div className="vc-review">
        <div className="vc-review-block">
          <div className="vc-review-label">Question</div>
          <p className="vc-review-content">{question.question}</p>
        </div>

        <div className="vc-review-block">
          <div className="vc-review-label">
            {payload?.type === 'audio' ? '🎙️ Audio answer' : 'Your answer'}
            {payload?.type === 'audio' && payload?.duration != null && (
              <span style={{ marginLeft: 8, opacity: 0.7, fontWeight: 500 }}>
                · {formatTime(payload.duration)}
              </span>
            )}
          </div>
          <p className="vc-review-content">{payload?.value}</p>
          <button
            className={`vc-copy-btn${copied ? ' copied' : ''}`}
            onClick={onCopy}
            type="button"
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>

      <div className="vc-success-action">
        <button className="vc-another-btn" onClick={onAnother} type="button">
          Answer another question <ArrowRight size={16} />
        </button>
      </div>
    </div>
  );
}
