import React from 'react';
import { createRoot } from 'react-dom/client';
import CheckpointApp from './CheckpointApp.jsx';
import GrowthApp from './GrowthApp.jsx';

// The extension host injects window.__VIBECHECK_VIEW__ = 'checkpoint' | 'growth'
const view = window.__VIBECHECK_VIEW__ ?? 'checkpoint';
const App = view === 'growth' ? GrowthApp : CheckpointApp;

createRoot(document.getElementById('root')).render(<App />);
