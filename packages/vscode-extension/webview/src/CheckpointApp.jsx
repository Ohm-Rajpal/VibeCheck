import React from 'react';
import QuestionCard from './components/QuestionCard.jsx';
import VoiceButton from './components/VoiceButton.jsx';
import ScoreFeedback from './components/ScoreFeedback.jsx';

export default function CheckpointApp() {
  // TODO: wire vscode postMessage protocol (INIT / SUBMIT_TRANSCRIPT / SCORE).
  return (
    <div style={{ padding: 24, fontFamily: 'system-ui', color: '#eee' }}>
      <h2>🧠 Comprehension Check</h2>
      <QuestionCard />
      <VoiceButton />
      <ScoreFeedback />
    </div>
  );
}
