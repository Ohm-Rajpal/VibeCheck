import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import * as ts from 'typescript';
import {
  Node as MorphNode,
  Project,
  ReferencedSymbol,
  SyntaxKind,
} from 'ts-morph';

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
  callers?: string[];
};

type Question = {
  question: string;
  why: string;
};

const MAX_QUESTIONS = 10;

export function generateQuestionsFromGitDiff(
  workspaceRoot: string,
  options?: { staged?: boolean }
): Question[] {
  const files = parseChangedFiles(workspaceRoot, options?.staged ?? false);
  const tsOrJsFiles = files.filter((file) => isTsOrJsFile(file.filePath));
  const pythonFiles = files.filter((file) => isPythonFile(file.filePath));

  const tsOrJsChangedFunctions = tsOrJsFiles.flatMap((file) =>
    analyzeTsOrJsFile(file, workspaceRoot)
  );
  const tsOrJsCallers = findTsOrJsCallersForFunctions(
    workspaceRoot,
    tsOrJsChangedFunctions
  );
  const enrichedTsOrJsChangedFunctions = tsOrJsChangedFunctions.map((fn) => ({
    ...fn,
    callers: tsOrJsCallers.get(changedFunctionKey(fn)) ?? [],
  }));

  const changedFunctions = [
    ...enrichedTsOrJsChangedFunctions,
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
    question: `You changed \`${fn.functionName}\` in \`${fn.filePath}\`. Which callers depend on it and what behavior changed?${formatCallerSuffix(fn.callers)}`,
    why: `The changed lines intersect this function (lines ${fn.startLine}-${fn.endLine}).`,
  }));
}

function parseChangedFiles(workspaceRoot: string, staged: boolean): ChangedFile[] {
  const diffArgs = staged
    ? ['diff', '--cached', '--unified=0', '--no-color']
    : ['diff', '--unified=0', '--no-color'];
  const rawDiff = execFileSync('git', diffArgs, {
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
    // Skip anonymous callbacks to keep checkpoints focused on named functions/methods.
    return undefined;
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

function findTsOrJsCallersForFunctions(
  workspaceRoot: string,
  changedFunctions: ChangedFunction[]
): Map<string, string[]> {
  if (changedFunctions.length === 0) {
    return new Map();
  }

  const tsConfigPath = path.join(workspaceRoot, 'packages', 'vscode-extension', 'tsconfig.json');
  if (!fs.existsSync(tsConfigPath)) {
    return new Map();
  }

  const project = new Project({
    tsConfigFilePath: tsConfigPath,
    skipAddingFilesFromTsConfig: false,
  });
  project.addSourceFilesAtPaths(path.join(workspaceRoot, 'shared', '**/*.ts')); // FLAG: What does this do? Does this only allow ts fiels to be analyzed?

  const result = new Map<string, string[]>();
  for (const changedFunction of changedFunctions) {
    const key = changedFunctionKey(changedFunction);
    const declarationNode = findChangedFunctionDeclaration(project, workspaceRoot, changedFunction);
    if (!declarationNode) {
      result.set(key, []);
      continue;
    }

    const callers = findCallersForDeclaration(workspaceRoot, declarationNode);
    result.set(key, callers);
  }
  return result;
}

function changedFunctionKey(changedFunction: ChangedFunction): string {
  return `${changedFunction.filePath}:${changedFunction.functionName}:${changedFunction.startLine}:${changedFunction.endLine}`;
}

function findChangedFunctionDeclaration(
  project: Project,
  workspaceRoot: string,
  changedFunction: ChangedFunction
): MorphNode | undefined {
  const absolutePath = path.join(workspaceRoot, changedFunction.filePath);
  const sourceFile = project.getSourceFile(absolutePath);
  if (!sourceFile) {
    return undefined;
  }

  const candidates = sourceFile.getDescendants().filter((node) => {
    if (!isSupportedFunctionNode(node)) {
      return false;
    }

    const nodeName = getMorphFunctionName(node);
    if (nodeName !== changedFunction.functionName) {
      return false;
    }

    const startLine = node.getStartLineNumber();
    const endLine = node.getEndLineNumber();
    return (
      startLine === changedFunction.startLine && endLine === changedFunction.endLine
    );
  });

  return candidates[0];
}

function isSupportedFunctionNode(node: MorphNode): boolean {
  return (
    MorphNode.isFunctionDeclaration(node) ||
    MorphNode.isMethodDeclaration(node) ||
    MorphNode.isFunctionExpression(node) ||
    MorphNode.isArrowFunction(node)
  );
}

function getMorphFunctionName(node: MorphNode): string {
  if (MorphNode.isFunctionDeclaration(node)) {
    return node.getName() ?? 'anonymous function declaration';
  }
  if (MorphNode.isMethodDeclaration(node)) {
    return node.getName();
  }
  if (MorphNode.isFunctionExpression(node) || MorphNode.isArrowFunction(node)) {
    const variableDeclaration = node.getFirstAncestorByKind(
      SyntaxKind.VariableDeclaration
    );
    if (variableDeclaration) {
      return variableDeclaration.getName();
    }
    return 'anonymous function expression';
  }
  return 'anonymous function expression';
}

function findCallersForDeclaration(
  workspaceRoot: string,
  declarationNode: MorphNode
): string[] {
  const callers = new Set<string>();
  const references = getReferencesForDeclaration(declarationNode);

  for (const reference of references) {
    for (const refEntry of reference.getReferences()) {
      const refNode = refEntry.getNode();
      if (!isCallLikeReference(refNode)) {
        continue;
      }

      if (
        refNode.getSourceFile().getFilePath() === declarationNode.getSourceFile().getFilePath() &&
        refNode.getStartLineNumber() === declarationNode.getStartLineNumber()
      ) {
        continue;
      }

      const relativeFilePath = path
        .relative(workspaceRoot, refNode.getSourceFile().getFilePath())
        .replace(/\\/g, '/');
      const enclosingName = findEnclosingFunctionName(refNode) ?? '<module>';
      const label = `${enclosingName} (${relativeFilePath}:${refNode.getStartLineNumber()})`;
      callers.add(label);
    }
  }

  return Array.from(callers).sort();
}

function getReferencesForDeclaration(declarationNode: MorphNode): ReferencedSymbol[] {
  if (MorphNode.isFunctionDeclaration(declarationNode)) {
    const nameNode = declarationNode.getNameNode();
    return nameNode ? nameNode.findReferences() : [];
  }

  if (MorphNode.isMethodDeclaration(declarationNode)) {
    const nameNode = declarationNode.getNameNode();
    return MorphNode.isIdentifier(nameNode) ? nameNode.findReferences() : [];
  }

  if (MorphNode.isFunctionExpression(declarationNode) || MorphNode.isArrowFunction(declarationNode)) {
    const variableDeclaration = declarationNode.getFirstAncestorByKind(
      SyntaxKind.VariableDeclaration
    );
    const nameNode = variableDeclaration?.getNameNode();
    return nameNode && MorphNode.isIdentifier(nameNode) ? nameNode.findReferences() : [];
  }

  return [];
}

function isCallLikeReference(node: MorphNode): boolean {
  const parent = node.getParent();
  if (!parent) {
    return false;
  }
  if (MorphNode.isCallExpression(parent) && parent.getExpression() === node) {
    return true;
  }
  if (MorphNode.isPropertyAccessExpression(parent)) {
    const callParent = parent.getParent();
    return MorphNode.isCallExpression(callParent) && callParent.getExpression() === parent;
  }
  return false;
}

function findEnclosingFunctionName(node: MorphNode): string | undefined {
  const enclosing = node.getFirstAncestor((ancestor) => isSupportedFunctionNode(ancestor));
  if (!enclosing) {
    return undefined;
  }
  return getMorphFunctionName(enclosing);
}

function formatCallerSuffix(callers: string[] | undefined): string {
  if (!callers || callers.length === 0) {
    return '';
  }
  return ` Callers found: ${callers.slice(0, 6).join(', ')}.`;
}

function intersects(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}
