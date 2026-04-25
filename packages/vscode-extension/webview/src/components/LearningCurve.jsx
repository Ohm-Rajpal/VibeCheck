import React from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

export default function LearningCurve({ trajectory = [] }) {
  const data = trajectory.map((v, i) => ({ idx: i + 1, score: v }));
  return (
    <div style={{ height: 180, marginBottom: 16 }}>
      <h4>Learning curve</h4>
      <ResponsiveContainer>
        <LineChart data={data}>
          <XAxis dataKey="idx" />
          <YAxis domain={[0, 1]} />
          <Tooltip />
          <Line type="monotone" dataKey="score" stroke="#4ade80" />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
