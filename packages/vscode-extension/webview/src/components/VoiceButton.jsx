import React, { useState } from 'react';
import { Mic, MicOff } from 'lucide-react';

export default function VoiceButton({ onTranscript }) {
  const [recording, setRecording] = useState(false);
  // TODO: wire MediaRecorder + send blob to backend transcriber.
  const toggle = () => setRecording((r) => !r);
  return (
    <button
      onClick={toggle}
      style={{
        padding: '12px 20px',
        borderRadius: 999,
        border: 'none',
        background: recording ? '#e23' : '#3a3',
        color: '#fff',
        cursor: 'pointer',
        display: 'inline-flex',
        gap: 8,
        alignItems: 'center',
      }}
    >
      {recording ? <MicOff size={16} /> : <Mic size={16} />}
      {recording ? 'Stop' : 'Record answer'}
    </button>
  );
}
