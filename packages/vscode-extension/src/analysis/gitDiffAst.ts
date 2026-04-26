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
  changedFunction: string;
  changedFunctionFile: string;
  beforeSource: string;
  afterSource: string;
  changedFunctionSource: string;
  calledBy: string[];
  estimatedImpact: 'Low' | 'Medium' | 'Medium-High' | 'High';
  llmContext: {
    seed: {
      name: string;
      file: string;
      source: string;
    };
    related: Array<{
      relation: 'called_by' | 'calls';
      name: string;
      file: string;
      source: string;
    }>;
  };
  question: string;
  whyThisMatters: string;
};

const MAX_QUESTIONS = 10;
const MAX_GRAPH_DEPTH = 2;
const MAX_GRAPH_NODES = 60;
const MAX_RELATION_ITEMS = 5;

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
        changedFunction: '<diff>',
        changedFunctionFile: '<unknown>',
        beforeSource: '',
        afterSource: '',
        changedFunctionSource: '',
        calledBy: [],
        estimatedImpact: 'Low',
        llmContext: {
          seed: { name: '<diff>', file: '<unknown>', source: '' },
          related: [],
        },
        question:
          'If the staged diff extraction is incomplete, what behavior change could ship without being questioned?',
        whyThisMatters:
          'No function-level AST matches were found in changed hunks, so reasoning about the overall commit intent is the safest fallback.',
      },
    ];
  }

  const tsConfigPath = path.join(workspaceRoot, 'packages', 'vscode-extension', 'tsconfig.json');
  const project = fs.existsSync(tsConfigPath)
    ? buildTypeScriptProject(workspaceRoot, tsConfigPath)
    : undefined;

  const questions: Question[] = [];
  for (const changedFunction of changedFunctions) {
    if (questions.length >= MAX_QUESTIONS) {
      break;
    }

    if (!project || !isTsOrJsFile(changedFunction.filePath)) {
      questions.push({
        changedFunction: changedFunction.functionName,
        changedFunctionFile: changedFunction.filePath,
        beforeSource: '',
        afterSource: '',
        changedFunctionSource: '',
        calledBy: simplifyCallerLabels(changedFunction.callers ?? []),
        estimatedImpact: estimateImpactLevel(changedFunction.callers?.length ?? 0, 0),
        llmContext: {
          seed: {
            name: changedFunction.functionName,
            file: changedFunction.filePath,
            source: '',
          },
          related: [],
        },
        question: buildLearningQuestion(changedFunction.functionName),
        whyThisMatters: buildWhyThisMatters(changedFunction),
      });
      continue;
    }

    const declarationNode = findChangedFunctionDeclaration(
      project,
      workspaceRoot,
      changedFunction
    );
    if (!declarationNode) {
      questions.push({
        changedFunction: changedFunction.functionName,
        changedFunctionFile: changedFunction.filePath,
        beforeSource: '',
        afterSource: '',
        changedFunctionSource: '',
        calledBy: simplifyCallerLabels(changedFunction.callers ?? []),
        estimatedImpact: estimateImpactLevel(changedFunction.callers?.length ?? 0, 0),
        llmContext: {
          seed: {
            name: changedFunction.functionName,
            file: changedFunction.filePath,
            source: '',
          },
          related: [],
        },
        question: buildLearningQuestion(changedFunction.functionName),
        whyThisMatters: `${buildWhyThisMatters(changedFunction)} Symbol resolution was unavailable, so this prompt focuses on behavior and contracts.`,
      });
      continue;
    }

    const generated = generateAdaptiveQuestionForChangedFunction(
      workspaceRoot,
      changedFunction,
      declarationNode,
      options?.staged ?? false
    );
    for (const question of generated) {
      if (questions.length >= MAX_QUESTIONS) {
        break;
      }
      questions.push(question);
    }
  }

  return dedupeQuestions(questions).slice(0, MAX_QUESTIONS);
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

  const project = buildTypeScriptProject(workspaceRoot, tsConfigPath);

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

function buildTypeScriptProject(workspaceRoot: string, tsConfigPath: string): Project {
  const project = new Project({
    tsConfigFilePath: tsConfigPath,
    skipAddingFilesFromTsConfig: false,
  });
  project.addSourceFilesAtPaths(path.join(workspaceRoot, 'shared', '**/*.ts'));
  project.addSourceFilesAtPaths(path.join(workspaceRoot, 'shared', '**/*.tsx'));
  project.addSourceFilesAtPaths(path.join(workspaceRoot, 'packages', '**', 'src', '**/*.ts'));
  project.addSourceFilesAtPaths(path.join(workspaceRoot, 'packages', '**', 'src', '**/*.tsx'));
  project.addSourceFilesAtPaths(path.join(workspaceRoot, 'packages', '**', 'src', '**/*.js'));
  project.addSourceFilesAtPaths(path.join(workspaceRoot, 'packages', '**', 'src', '**/*.jsx'));
  return project;
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

function generateAdaptiveQuestionForChangedFunction(
  workspaceRoot: string,
  changedFunction: ChangedFunction,
  declarationNode: MorphNode,
  staged: boolean
): Question[] {
  const impact = buildImpactGraph(workspaceRoot, declarationNode);
  const callerContexts = findRelatedFunctionContexts(
    workspaceRoot,
    declarationNode,
    'called_by'
  );
  const calleeContexts = findRelatedFunctionContexts(
    workspaceRoot,
    declarationNode,
    'calls'
  );
  const calledBy =
    callerContexts.length > 0
      ? callerContexts
          .slice(0, MAX_RELATION_ITEMS)
          .map((item) => `${item.name} (${item.file})`)
      : impact.upstream.length
        ? simplifyCallerLabelsWithPath(impact.upstream.slice(0, MAX_RELATION_ITEMS))
        : simplifyCallerLabels(changedFunction.callers ?? []);
  const estimatedImpact = estimateImpactLevel(
    impact.upstream.length,
    impact.downstream.length
  );
  const related = [...callerContexts, ...calleeContexts].slice(0, MAX_RELATION_ITEMS * 2);
  const afterSource = declarationNode.getText();
  const beforeSource = resolveBeforeFunctionSource(
    workspaceRoot,
    changedFunction,
    staged
  );

  return [
    {
      changedFunction: changedFunction.functionName,
      changedFunctionFile: changedFunction.filePath,
      beforeSource,
      afterSource,
      changedFunctionSource: afterSource,
      calledBy,
      estimatedImpact,
      llmContext: {
        seed: {
          name: changedFunction.functionName,
          file: changedFunction.filePath,
          source: afterSource,
        },
        related,
      },
      question: buildLearningQuestion(changedFunction.functionName),
      whyThisMatters: buildWhyThisMatters(changedFunction),
    },
  ];
}

function buildImpactGraph(
  workspaceRoot: string,
  seedDeclaration: MorphNode
): { upstream: string[]; downstream: string[] } {
  const upstream = traverseCallGraph(workspaceRoot, [seedDeclaration], 'upstream');
  const downstream = traverseCallGraph(workspaceRoot, [seedDeclaration], 'downstream');
  return { upstream, downstream };
}

function traverseCallGraph(
  workspaceRoot: string,
  startNodes: MorphNode[],
  direction: 'upstream' | 'downstream'
): string[] {
  const visited = new Set<string>();
  const labels = new Set<string>();
  const queue: Array<{ node: MorphNode; depth: number }> = startNodes.map((node) => ({
    node,
    depth: 0,
  }));
  for (const startNode of startNodes) {
    visited.add(symbolKey(startNode));
  }

  while (queue.length > 0 && visited.size < MAX_GRAPH_NODES) {
    const current = queue.shift();
    if (!current) {
      break;
    }
    if (current.depth >= MAX_GRAPH_DEPTH) {
      continue;
    }

    const adjacent =
      direction === 'upstream'
        ? findCallerDeclarations(current.node)
        : findCalleeDeclarations(current.node);

    for (const nextNode of adjacent) {
      const key = symbolKey(nextNode);
      if (visited.has(key)) {
        continue;
      }
      visited.add(key);
      labels.add(formatFunctionLabel(workspaceRoot, nextNode));
      queue.push({ node: nextNode, depth: current.depth + 1 });
      if (visited.size >= MAX_GRAPH_NODES) {
        break;
      }
    }
  }

  return Array.from(labels).sort();
}

function findCallerDeclarations(declarationNode: MorphNode): MorphNode[] {
  const callers = new Map<string, MorphNode>();
  const references = getReferencesForDeclaration(declarationNode);

  for (const reference of references) {
    for (const refEntry of reference.getReferences()) {
      const refNode = refEntry.getNode();
      if (!isCallLikeReference(refNode)) {
        continue;
      }
      if (isSelfReferenceCall(declarationNode, refNode)) {
        continue;
      }
      const enclosing = refNode.getFirstAncestor((ancestor) => isSupportedFunctionNode(ancestor));
      if (!enclosing) {
        continue;
      }
      callers.set(symbolKey(enclosing), enclosing);
    }
  }

  return Array.from(callers.values());
}

function findCalleeDeclarations(declarationNode: MorphNode): MorphNode[] {
  const callees = new Map<string, MorphNode>();
  const callExpressions = declarationNode
    .getDescendants()
    .filter((descendant) => MorphNode.isCallExpression(descendant));

  for (const callExpression of callExpressions) {
    const expression = callExpression.getExpression();
    const symbol = expression.getSymbol();
    const declarations = symbol?.getDeclarations() ?? [];
    for (const candidate of declarations) {
      const resolved = normalizeDeclarationNode(candidate);
      if (!resolved || !isSupportedFunctionNode(resolved)) {
        continue;
      }
      if (isSameFunctionNode(resolved, declarationNode)) {
        continue;
      }
      callees.set(symbolKey(resolved), resolved);
    }
  }

  return Array.from(callees.values());
}

function normalizeDeclarationNode(node: MorphNode): MorphNode | undefined {
  if (isSupportedFunctionNode(node)) {
    return node;
  }

  if (MorphNode.isVariableDeclaration(node)) {
    const initializer = node.getInitializer();
    if (initializer && (MorphNode.isArrowFunction(initializer) || MorphNode.isFunctionExpression(initializer))) {
      return initializer;
    }
  }

  return undefined;
}

function symbolKey(node: MorphNode): string {
  const sourcePath = node.getSourceFile().getFilePath();
  const start = node.getStartLineNumber();
  const end = node.getEndLineNumber();
  const name = getMorphFunctionName(node);
  return `${sourcePath}:${start}:${end}:${name}`;
}

function formatFunctionLabel(workspaceRoot: string, node: MorphNode): string {
  const relativePath = path
    .relative(workspaceRoot, node.getSourceFile().getFilePath())
    .replace(/\\/g, '/');
  if (relativePath.includes('/node_modules/')) {
    return '';
  }
  return `${getMorphFunctionName(node)} (${relativePath}:${node.getStartLineNumber()})`;
}

function formatRelationSuffix(prefix: string, values: string[]): string {
  if (values.length === 0) {
    return '';
  }
  return ` ${prefix}: ${values.join(', ')}.`;
}

function isSelfReferenceCall(declarationNode: MorphNode, referenceNode: MorphNode): boolean {
  return (
    referenceNode.getSourceFile().getFilePath() === declarationNode.getSourceFile().getFilePath() &&
    referenceNode.getStartLineNumber() === declarationNode.getStartLineNumber()
  );
}

function isSameFunctionNode(a: MorphNode, b: MorphNode): boolean {
  return (
    a.getSourceFile().getFilePath() === b.getSourceFile().getFilePath() &&
    a.getStartLineNumber() === b.getStartLineNumber() &&
    a.getEndLineNumber() === b.getEndLineNumber()
  );
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

function dedupeQuestions(questions: Question[]): Question[] {
  const deduped: Question[] = [];
  const seen = new Set<string>();

  for (const question of questions) {
    const key = `${question.changedFunction}::${question.question}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(question);
  }

  return deduped;
}

function intersects(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}

function buildLearningQuestion(functionName: string): string {
  return `Walk through how \`${functionName}\` handles changed inputs. If this function misses a staged case, what downstream behavior would be incorrect?`;
}

function buildWhyThisMatters(changedFunction: ChangedFunction): string {
  return `This function is directly changed in \`${changedFunction.filePath}\` (lines ${changedFunction.startLine}-${changedFunction.endLine}) and controls behavior that VibeCheck evaluates before commit.`;
}

function simplifyCallerLabels(callers: string[]): string[] {
  const simplified = callers
    .map((label) => label.split(' (')[0]?.trim() ?? label.trim())
    .filter((name) => Boolean(name) && name !== '<module>');
  return Array.from(new Set(simplified)).slice(0, MAX_RELATION_ITEMS);
}

function simplifyCallerLabelsWithPath(callers: string[]): string[] {
  const simplified = callers
    .map((label) => {
      const match = label.match(/^(.+?) \((.+?):\d+\)$/);
      if (match) {
        return `${match[1]} (${match[2]})`;
      }
      return label.trim();
    })
    .filter((value) => Boolean(value) && !value.startsWith('<module>'));
  return Array.from(new Set(simplified)).slice(0, MAX_RELATION_ITEMS);
}

function findRelatedFunctionContexts(
  workspaceRoot: string,
  declarationNode: MorphNode,
  relation: 'called_by' | 'calls'
): Array<{ relation: 'called_by' | 'calls'; name: string; file: string; source: string }> {
  const nodes =
    relation === 'called_by'
      ? findCallerDeclarations(declarationNode)
      : findCalleeDeclarations(declarationNode);
  const seen = new Set<string>();
  const results: Array<{
    relation: 'called_by' | 'calls';
    name: string;
    file: string;
    source: string;
  }> = [];

  for (const node of nodes) {
    const relativePath = path
      .relative(workspaceRoot, node.getSourceFile().getFilePath())
      .replace(/\\/g, '/');
    if (relativePath.includes('/node_modules/')) {
      continue;
    }
    const name = getMorphFunctionName(node);
    const key = `${relation}:${name}:${relativePath}:${node.getStartLineNumber()}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    results.push({
      relation,
      name: formatCallerName(name, relativePath),
      file: relativePath,
      source: truncateSource(node.getText(), 2400),
    });
    if (results.length >= MAX_RELATION_ITEMS * 2) {
      break;
    }
  }

  return results;
}

function truncateSource(source: string, maxChars: number): string {
  if (source.length <= maxChars) {
    return source;
  }
  return `${source.slice(0, maxChars)}\n/* ...truncated for context size... */`;
}

function formatCallerName(name: string, relativeFilePath: string): string {
  if (name === 'anonymous function expression' && relativeFilePath.endsWith('extension.ts')) {
    return 'extension.ts pre-commit flow';
  }
  return name;
}

function estimateImpactLevel(
  upstreamCount: number,
  downstreamCount: number
): Question['estimatedImpact'] {
  if (upstreamCount >= 4 || downstreamCount >= 8) {
    return 'High';
  }
  if (upstreamCount >= 2 || downstreamCount >= 4) {
    return 'Medium-High';
  }
  if (upstreamCount >= 1 || downstreamCount >= 1) {
    return 'Medium';
  }
  return 'Low';
}

function resolveBeforeFunctionSource(
  workspaceRoot: string,
  changedFunction: ChangedFunction,
  staged: boolean
): string {
  if (!isTsOrJsFile(changedFunction.filePath)) {
    return '';
  }

  const beforeRef = staged ? `HEAD:${changedFunction.filePath}` : `:${changedFunction.filePath}`;
  const beforeFileText = readGitBlob(workspaceRoot, beforeRef);
  if (!beforeFileText) {
    return '';
  }

  return (
    findFunctionSourceInText(
      beforeFileText,
      changedFunction.filePath,
      changedFunction.functionName
    ) ?? ''
  );
}

function readGitBlob(workspaceRoot: string, ref: string): string | undefined {
  try {
    return execFileSync('git', ['show', ref], {
      cwd: workspaceRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return undefined;
  }
}

function findFunctionSourceInText(
  fileText: string,
  filePath: string,
  functionName: string
): string | undefined {
  const sourceFile = ts.createSourceFile(
    filePath,
    fileText,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFromPath(filePath)
  );
  let result: string | undefined;

  const visit = (node: ts.Node) => {
    if (result) {
      return;
    }
    const fn = toFunctionNode(node);
    if (fn?.name === functionName) {
      result = node.getText(sourceFile);
      return;
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return result;
}
