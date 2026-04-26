import React from 'react';
import { createRoot } from 'react-dom/client';
import CheckpointApp from './CheckpointApp.jsx';
import GrowthApp from './GrowthApp.jsx';
import './style.css';

// The extension host injects:
//   window.__VIBECHECK_VIEW__ = 'checkpoint' | 'growth'
//   window.__VIBECHECK_INIT__ = { sessionId, questions, trigger }   (checkpoint)
const view = window.__VIBECHECK_VIEW__ ?? 'checkpoint';
const init = window.__VIBECHECK_INIT__ ?? null;
const App = view === 'growth' ? GrowthApp : CheckpointApp;

createRoot(document.getElementById('root')).render(<App init={init} />);
