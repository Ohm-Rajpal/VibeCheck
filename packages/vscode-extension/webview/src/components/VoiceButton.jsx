import React, { useEffect, useRef, useState } from 'react';
import { Mic, Square, Loader2 } from 'lucide-react';

export default function VoiceButton({ onTranscript }) {
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [transcribing, setTranscribing] = useState(false);
  const mediaRef = useRef(null);
  const timerRef = useRef(null);
  const chunksRef = useRef([]);

  async function start() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = (e) => chunksRef.current.push(e.data);
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setTranscribing(true);
        // TODO: POST chunks to /transcribe endpoint. Mocked for now.
        await new Promise((r) => setTimeout(r, 600));
        setTranscribing(false);
        onTranscript?.('[mock transcript — wire to /transcribe endpoint]');
      };
      rec.start();
      mediaRef.current = rec;
      setRecording(true);
      setElapsed(0);
      timerRef.current = setInterval(() => setElapsed((e) => e + 1), 1000);
    } catch (err) {
      console.warn('[VibeCheck] microphone error', err);
      onTranscript?.('[microphone unavailable — type your answer below]');
    }
  }

  function stop() {
    mediaRef.current?.stop();
    setRecording(false);
    clearInterval(timerRef.current);
  }

  useEffect(() => () => clearInterval(timerRef.current), []);

  const min = Math.floor(elapsed / 60);
  const sec = String(elapsed % 60).padStart(2, '0');

  return (
    <div style={styles.row}>
      <button
        onClick={recording ? stop : start}
        className={recording ? 'vc-pulse' : ''}
        disabled={transcribing}
        style={{
          ...styles.mic,
          background: transcribing
            ? 'var(--vscode-button-secondaryBackground, #444)'
            : recording
            ? 'var(--vscode-errorForeground, #e23)'
            : 'var(--vscode-button-background, #2da44e)',
        }}
      >
        {transcribing ? (
          <Loader2 size={16} className="vc-spin" />
        ) : recording ? (
          <Square size={12} fill="#fff" />
        ) : (
          <Mic size={16} />
        )}
        {transcribing ? 'Transcribing…' : recording ? 'Stop' : 'Record answer'}
      </button>
      {recording && (
        <span style={styles.timer}>
          <span style={styles.dot} />
          {min}:{sec}
        </span>
      )}
    </div>
  );
}

const styles = {
  row: { display: 'flex', alignItems: 'center', gap: 12 },
  mic: {
    padding: '10px 18px',
    borderRadius: 999,
    border: 'none',
    color: '#fff',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    fontWeight: 500,
  },
  timer: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 13,
    color: 'var(--vscode-descriptionForeground, #aaa)',
    fontFamily: 'var(--vscode-editor-font-family, ui-monospace, monospace)',
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 999,
    background: 'var(--vscode-errorForeground, #e23)',
    display: 'inline-block',
    animation: 'vcPulse 1.4s ease-in-out infinite',
  },
};
