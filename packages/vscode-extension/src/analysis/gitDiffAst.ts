import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import * as ts from 'typescript';

type LineRange = {
  start: number;
  end: number;
};

type ChangedFile = {
  filePath: string;
  ranges: LineRange[];
};

type ChangedFunction = {
  filePath: string;
  functionName: string;
  startLine: number;
  endLine: number;
};

type Question = {
  question: string;
  why: string;
};

const MAX_QUESTIONS = 4;

export function generateQuestionsFromGitDiff(workspaceRoot: string): Question[] {
  const files = parseChangedFiles(workspaceRoot); // Runs git diff --unified=0 --no-color
  const tsOrJsFiles = files.filter((file) => isTsOrJsFile(file.filePath));
  const pythonFiles = files.filter((file) => isPythonFile(file.filePath));

  const changedFunctions = [
    ...tsOrJsFiles.flatMap((file) => analyzeTsOrJsFile(file, workspaceRoot)),
    ...analyzePythonFiles(pythonFiles, workspaceRoot),
  ];

  if (changedFunctions.length === 0) {
    return [
      {
        question:
          'Which behavior changed in this diff, and what tests prove the old behavior is still safe?',
        why: 'No function-level AST matches were found in the changed hunks, so provide a behavioral summary.',
      },
    ];
  }

  return changedFunctions.slice(0, MAX_QUESTIONS).map((fn) => ({
    question: `You changed \`${fn.functionName}\` in \`${fn.filePath}\`. Which callers depend on it and what behavior changed?`,
    why: `The changed lines intersect this function (lines ${fn.startLine}-${fn.endLine}).`,
  }));
}

function parseChangedFiles(workspaceRoot: string): ChangedFile[] {
  const rawDiff = execFileSync('git', ['diff', '--unified=0', '--no-color'], {
    cwd: workspaceRoot,
    encoding: 'utf8',
  });

  const lines = rawDiff.split('\n');
  const files = new Map<string, LineRange[]>();
  let currentFile = '';

  for (const line of lines) {
    if (line.startsWith('+++ b/')) {
      currentFile = line.slice('+++ b/'.length).trim();
      if (isSourceFile(currentFile) && !files.has(currentFile)) {
        files.set(currentFile, []);
      }
      continue;
    }

    if (!currentFile || !isSourceFile(currentFile)) {
      continue;
    }

    if (!line.startsWith('@@')) {
      continue;
    }

    const plusMatch = line.match(/\+(\d+)(?:,(\d+))?/);
    if (!plusMatch) {
      continue;
    }

    const start = Number(plusMatch[1]);
    const count = plusMatch[2] ? Number(plusMatch[2]) : 1;
    const safeCount = Math.max(count, 1);
    const end = start + safeCount - 1;
    files.get(currentFile)?.push({ start, end });
  }

  return Array.from(files.entries()).map(([filePath, ranges]) => ({ filePath, ranges }));
}

function analyzeTsOrJsFile(
  changedFile: ChangedFile,
  workspaceRoot: string
): ChangedFunction[] {
  if (changedFile.ranges.length === 0) {
    return [];
  }

  const absolute = path.join(workspaceRoot, changedFile.filePath);
  if (!fs.existsSync(absolute)) {
    return [];
  }

  const sourceText = fs.readFileSync(absolute, 'utf8');
  const sourceFile = ts.createSourceFile(
    absolute,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFromPath(absolute)
  );

  const hits: ChangedFunction[] = [];
  const seen = new Set<string>();

  const visit = (node: ts.Node) => {
    const fn = toFunctionNode(node);
    if (fn) {
      const startLine = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      const endLine = sourceFile.getLineAndCharacterOfPosition(node.end).line + 1;
      const overlaps = changedFile.ranges.some((range) => intersects(startLine, endLine, range.start, range.end));

      if (overlaps) {
        const key = `${changedFile.filePath}:${fn.name}:${startLine}:${endLine}`;
        if (!seen.has(key)) {
          hits.push({
            filePath: changedFile.filePath,
            functionName: fn.name,
            startLine,
            endLine,
          });
          seen.add(key);
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return hits;
}

function toFunctionNode(node: ts.Node): { name: string } | undefined {
  if (ts.isFunctionDeclaration(node)) {
    return { name: node.name?.getText() ?? 'anonymous function declaration' };
  }

  if (ts.isMethodDeclaration(node)) {
    return { name: node.name.getText() };
  }

  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
      return { name: node.parent.name.text };
    }
    return { name: 'anonymous function expression' };
  }

  return undefined;
}

function scriptKindFromPath(filePath: string): ts.ScriptKind {
  if (filePath.endsWith('.tsx')) {
    return ts.ScriptKind.TSX;
  }
  if (filePath.endsWith('.jsx')) {
    return ts.ScriptKind.JSX;
  }
  if (filePath.endsWith('.js')) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

function isSourceFile(filePath: string): boolean {
  if (!/\.(ts|tsx|js|jsx|py)$/.test(filePath)) {
    return false;
  }

  const normalized = filePath.replace(/\\/g, '/');
  const ignoredSegments = [
    '/out/',
    '/dist/',
    '/build/',
    '/node_modules/',
    '/coverage/',
    '/.next/',
    '/.turbo/',
  ];

  return !ignoredSegments.some((segment) => normalized.includes(segment));
}

function isTsOrJsFile(filePath: string): boolean {
  return /\.(ts|tsx|js|jsx)$/.test(filePath);
}

function isPythonFile(filePath: string): boolean {
  return /\.py$/.test(filePath);
}

function analyzePythonFiles(
  files: ChangedFile[],
  workspaceRoot: string
): ChangedFunction[] {
  if (files.length === 0) {
    return [];
  }

  const workerScript = findPythonWorkerScript(workspaceRoot);
  if (!workerScript) {
    throw new Error(
      'Python worker script not found. Expected scripts/python_ast_worker.py.'
    );
  }

  const payload = JSON.stringify({ workspaceRoot, files });
  const output = runPythonWorker(workerScript, workspaceRoot, payload);

  const parsed = JSON.parse(output) as {
    changedFunctions?: ChangedFunction[];
    errors?: string[];
  };

  if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
    console.warn(
      `[VibeCheck] Python AST worker warnings: ${parsed.errors.join(' | ')}`
    );
  }

  if (!Array.isArray(parsed.changedFunctions)) {
    return [];
  }

  return parsed.changedFunctions;
}

function findPythonWorkerScript(workspaceRoot: string): string | undefined {
  const candidates = [
    path.join(workspaceRoot, 'scripts', 'python_ast_worker.py'),
    path.join(
      workspaceRoot,
      'packages',
      'vscode-extension',
      'scripts',
      'python_ast_worker.py'
    ),
  ];

  return candidates.find((candidate) => fs.existsSync(candidate));
}

function runPythonWorker(
  workerScript: string,
  workspaceRoot: string,
  payload: string
): string {
  try {
    return execFileSync('python', [workerScript], {
      cwd: workspaceRoot,
      encoding: 'utf8',
      input: payload,
    });
  } catch (pythonError) {
    try {
      return execFileSync('py', ['-3', workerScript], {
        cwd: workspaceRoot,
        encoding: 'utf8',
        input: payload,
      });
    } catch {
      const message =
        pythonError instanceof Error ? pythonError.message : 'unknown python error';
      throw new Error(
        `Could not run Python AST worker. Install Python or ensure python/py is on PATH. Details: ${message}`
      );
    }
  }
}

function intersects(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}
