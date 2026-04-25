import React from 'react';
import LearningCurve from './components/LearningCurve.jsx';
import ConceptRadar from './components/ConceptRadar.jsx';
import CommitTimeline from './components/CommitTimeline.jsx';

export default function GrowthApp() {
  return (
    <div style={{ padding: 16, fontFamily: 'system-ui', color: '#eee' }}>
      <h2>📈 Your Comprehension Growth</h2>
      <LearningCurve />
      <ConceptRadar />
      <CommitTimeline />
    </div>
  );
}
