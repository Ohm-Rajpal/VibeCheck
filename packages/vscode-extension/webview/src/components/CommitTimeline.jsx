import React from 'react';

export default function CommitTimeline({ sessions = [] }) {
  return (
    <div>
      <h4>Recent checkpoints</h4>
      {sessions.length === 0 && <p style={{ opacity: 0.6 }}>No sessions yet.</p>}
      <ul>
        {sessions.map((s) => (
          <li key={s.session_id}>
            {s.started_at} — {s.repo}@{s.branch}
          </li>
        ))}
      </ul>
    </div>
  );
}
