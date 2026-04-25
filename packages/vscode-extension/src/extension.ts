import * as vscode from 'vscode';
import * as http from 'http';
import { activateVelocityDetector } from './detection/velocityDetector';
import { openCheckpointPanel } from './checkpoint/panel';
import { activateGrowthSidebar } from './growth/sidebar';

const CHECKPOINT_PORT = Number(process.env.CHECKPOINT_PORT ?? 3456);

export function activate(context: vscode.ExtensionContext) {
  console.log('[VibeCheck] activate() called');

  // 1. Local HTTP server: receives notifications from pre-commit hook + Devin webhook.
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/checkpoint') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        try {
          const { session_id, questions, trigger } = JSON.parse(body);
          openCheckpointPanel(context, session_id, questions, trigger);
          res.writeHead(200);
          res.end('ok');
        } catch (err) {
          res.writeHead(400);
          res.end('bad payload');
        }
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(CHECKPOINT_PORT);
  context.subscriptions.push({ dispose: () => server.close() });

  // 2. Layer 1 — velocity detector.
  activateVelocityDetector(context);

  // 3. Growth dashboard sidebar.
  activateGrowthSidebar(context);

  // 4. Commands.
  context.subscriptions.push(
    vscode.commands.registerCommand('vibecheck.showGrowth', () => {
      vscode.commands.executeCommand('workbench.view.extension.vibecheck');
    }),
    vscode.commands.registerCommand('vibecheck.openCheckpoint', () => {
      openCheckpointPanel(context, 'manual', [], 'pre_commit');
    })
  );
}

export function deactivate() {}
