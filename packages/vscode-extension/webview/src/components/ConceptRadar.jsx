import React from 'react';
import { RadarChart, PolarGrid, PolarAngleAxis, Radar, ResponsiveContainer } from 'recharts';

export default function ConceptRadar({ conceptScores = {} }) {
  const data = Object.entries(conceptScores).map(([k, v]) => ({ concept: k, score: v }));
  return (
    <div style={{ height: 240, marginBottom: 16 }}>
      <h4>Concept strengths</h4>
      <ResponsiveContainer>
        <RadarChart data={data}>
          <PolarGrid />
          <PolarAngleAxis dataKey="concept" />
          <Radar dataKey="score" stroke="#60a5fa" fill="#60a5fa" fillOpacity={0.4} />
        </RadarChart>
      </ResponsiveContainer>
    </div>
  );
}
