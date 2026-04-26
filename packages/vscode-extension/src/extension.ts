import * as vscode from 'vscode';
import * as http from 'http';
import { activateVelocityDetector, resetDetectorForTest } from './detection/velocityDetector';
import { activateDecorator } from './detection/decorator';
import { regionTracker } from './detection/regionTracker';
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
        } catch {
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

  // 2. Layer 1 — velocity detector + visual decorator.
  activateVelocityDetector(context);
  activateDecorator(context);

  // 3. Status bar counter — total unverified AI regions across the workspace.
  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBar.command = 'vibecheck.openCheckpoint';
  context.subscriptions.push(
    statusBar,
    regionTracker.onChange(() => updateStatusBar(statusBar))
  );
  updateStatusBar(statusBar);
  statusBar.show();

  // 4. Growth dashboard sidebar.
  activateGrowthSidebar(context);

  // 5. Commands.
  context.subscriptions.push(
    vscode.commands.registerCommand('vibecheck.showGrowth', () => {
      vscode.commands.executeCommand('workbench.view.extension.vibecheck');
    }),
    vscode.commands.registerCommand('vibecheck.simulateAIBurst', async () => {
      const sample = [
        'function simulatedAIFunction(input: string): string {',
        '  // This block was inserted by vibecheck.simulateAIBurst for',
        '  // detection-pipeline testing. Delete after verifying the toast.',
        '  const trimmed = input.trim();',
        '  if (!trimmed) return "empty";',
        '  const result = trimmed',
        '    .split(/\\s+/)',
        '    .map((word) => word.toLowerCase())',
        '    .filter((w) => w.length > 2)',
        '    .join("-");',
        '  return result || "no-significant-tokens";',
        '}',
        '',
        'class SimulatedAIClass {',
        '  constructor(private readonly seed: number) {}',
        '  next(): number {',
        '    return (this.seed * 9301 + 49297) % 233280;',
        '  }',
        '}',
        '',
      ].join('\n');
      const now = Date.now();
      const burstId = `simulated-burst-${now}`;
      const scratchUri = vscode.Uri.joinPath(
        context.globalStorageUri,
        `simulated-ai-burst-${now}.ts`
      );
      await vscode.workspace.fs.createDirectory(context.globalStorageUri);
      await vscode.workspace.fs.writeFile(
        scratchUri,
        Buffer.from(`// VibeCheck detection scratchpad\n${sample}`, 'utf8')
      );
      const doc = await vscode.workspace.openTextDocument(scratchUri);
      await vscode.window.showTextDocument(doc);

      const region = {
        id: `simulated-region-${now}`,
        burstId,
        file: scratchUri.fsPath,
        startLine: 1,
        endLine: sample.split('\n').length,
        text: sample,
        generatedAt: now,
        status: 'unverified' as const,
      };
      regionTracker.addBurst([region]);

      openCheckpointPanel(
        context,
        burstId,
        [
          {
            checkpoint_id: region.id,
            question: `Walk me through what the AI-generated code in simulated-ai-burst.ts:${region.startLine + 1}-${region.endLine + 1} does, and why this approach over alternatives.`,
            concept_tag: 'general comprehension',
            code_context: `simulated-ai-burst.ts:${region.startLine + 1}-${region.endLine + 1}`,
            file: 'simulated-ai-burst.ts',
            diff_excerpt: region.text,
          },
        ],
        'velocity'
      );
    }),
    vscode.commands.registerCommand('vibecheck.openCheckpoint', () => {
      const regions = regionTracker.getUnverified();
      const questions = regions.map((r) => ({
        checkpoint_id: r.id,
        question: `Walk me through ${r.file.split('/').pop()}:${r.startLine + 1}-${r.endLine + 1}.`,
        concept_tag: 'general comprehension',
        code_context: `${r.file.split('/').pop()}:${r.startLine + 1}-${r.endLine + 1}`,
        file: r.file.split('/').pop() ?? r.file,
        diff_excerpt: r.text,
      }));
      openCheckpointPanel(
        context,
        `manual-${Date.now()}`,
        questions.length ? questions : [],
        'pre_commit'
      );
    })
  );
}

function updateStatusBar(item: vscode.StatusBarItem) {
  const { unverified, files } = regionTracker.stats();
  if (unverified === 0) {
    item.text = '$(pulse) VibeCheck: clean';
    item.tooltip = 'No unverified AI regions.';
    item.backgroundColor = undefined;
  } else {
    item.text = `$(pulse) ${unverified} unverified · ${files} file${files === 1 ? '' : 's'}`;
    item.tooltip = 'Click to open checkpoint panel for unverified AI regions.';
    item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  }
}

export function deactivate() {}
