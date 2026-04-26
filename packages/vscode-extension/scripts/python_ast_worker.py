import ast
import json
import os
import sys
from typing import Any, Dict, List

def intersects(a_start: int, a_end: int, b_start: int, b_end: int) -> bool:
    return a_start <= b_end and b_start <= a_end


def node_end_line(node: ast.AST) -> int:
    end = getattr(node, "end_lineno", None)
    if isinstance(end, int):
        return end
    start = getattr(node, "lineno", 0)
    return start if isinstance(start, int) else 0


def collect_changed_functions(
    workspace_root: str, changed_file: Dict[str, Any]
) -> List[Dict[str, Any]]:
    file_path = changed_file.get("filePath", "")
    ranges = changed_file.get("ranges", [])
    if not file_path or not isinstance(ranges, list):
        return []

    absolute_path = os.path.join(workspace_root, file_path)
    if not os.path.exists(absolute_path):
        return []

    try:
        with open(absolute_path, "r", encoding="utf-8") as f:
            source = f.read()
        tree = ast.parse(source, filename=absolute_path)
    except Exception:
        return []

    results: List[Dict[str, Any]] = []
    seen = set()

    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue

        start_line = getattr(node, "lineno", 0)
        end_line = node_end_line(node)
        if not isinstance(start_line, int) or not isinstance(end_line, int):
            continue

        overlap = False
        for item in ranges:
            if not isinstance(item, dict):
                continue
            r_start = item.get("start")
            r_end = item.get("end")
            if isinstance(r_start, int) and isinstance(r_end, int):
                if intersects(start_line, end_line, r_start, r_end):
                    overlap = True
                    break

        if not overlap:
            continue

        key = (file_path, node.name, start_line, end_line)
        if key in seen:
            continue
        seen.add(key)
        results.append(
            {
                "filePath": file_path,
                "functionName": node.name,
                "startLine": start_line,
                "endLine": end_line,
            }
        )

    return results


def iter_python_files(workspace_root: str) -> List[str]:
    results: List[str] = []
    ignored_dirs = {
        "node_modules",
        "out",
        "dist",
        "build",
        "coverage",
        ".next",
        ".turbo",
        ".git",
        "__pycache__",
    }
    for current_root, dir_names, file_names in os.walk(workspace_root):
        dir_names[:] = [d for d in dir_names if d not in ignored_dirs and not d.startswith(".")]
        for file_name in file_names:
            if file_name.endswith(".py"):
                absolute = os.path.join(current_root, file_name)
                rel_path = os.path.relpath(absolute, workspace_root).replace("\\", "/")
                results.append(rel_path)
    return results


class CallCollector(ast.NodeVisitor):
    def __init__(self, target_names: set[str], rel_path: str) -> None:
        self.target_names = target_names
        self.rel_path = rel_path
        self.function_stack: List[str] = []
        self.callers_by_target: Dict[str, set[str]] = {}

    def visit_FunctionDef(self, node: ast.FunctionDef) -> Any:
        self.function_stack.append(node.name)
        self.generic_visit(node)
        self.function_stack.pop()

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> Any:
        self.function_stack.append(node.name)
        self.generic_visit(node)
        self.function_stack.pop()

    def visit_Call(self, node: ast.Call) -> Any:
        callee = called_name(node.func)
        if callee and callee in self.target_names:
            caller = self.function_stack[-1] if self.function_stack else "<module>"
            label = f"{caller} ({self.rel_path})"
            if callee not in self.callers_by_target:
                self.callers_by_target[callee] = set()
            self.callers_by_target[callee].add(label)
        self.generic_visit(node)


def called_name(node: ast.AST) -> str | None:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    return None


def collect_callers_by_function(
    workspace_root: str, target_names: set[str]
) -> Dict[str, List[str]]:
    if not target_names:
        return {}

    combined: Dict[str, set[str]] = {}
    for rel_path in iter_python_files(workspace_root):
        absolute_path = os.path.join(workspace_root, rel_path)
        try:
            with open(absolute_path, "r", encoding="utf-8") as f:
                source = f.read()
            tree = ast.parse(source, filename=absolute_path)
        except Exception:
            continue

        collector = CallCollector(target_names, rel_path)
        collector.visit(tree)
        for target, callers in collector.callers_by_target.items():
            if target not in combined:
                combined[target] = set()
            combined[target].update(callers)

    return {target: sorted(list(callers)) for target, callers in combined.items()}


def main() -> int:
    raw = sys.stdin.read()
    if not raw.strip():
        sys.stdout.write(json.dumps({"changedFunctions": [], "errors": []}))
        return 0

    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        sys.stdout.write(
            json.dumps({"changedFunctions": [], "errors": ["Invalid JSON payload"]})
        )
        return 0

    workspace_root = payload.get("workspaceRoot", "")
    files = payload.get("files", [])
    if not isinstance(workspace_root, str) or not isinstance(files, list):
        sys.stdout.write(
            json.dumps(
                {
                    "changedFunctions": [],
                    "errors": ["Payload must include workspaceRoot and files list"],
                }
            )
        )
        return 0

    changed: List[Dict[str, Any]] = []
    for changed_file in files:
        if isinstance(changed_file, dict):
            changed.extend(collect_changed_functions(workspace_root, changed_file))

    target_names = {
        item.get("functionName")
        for item in changed
        if isinstance(item.get("functionName"), str)
    }
    callers_by_target = collect_callers_by_function(workspace_root, target_names)
    for item in changed:
        function_name = item.get("functionName")
        if isinstance(function_name, str):
            item["callers"] = callers_by_target.get(function_name, [])

    sys.stdout.write(json.dumps({"changedFunctions": changed, "errors": []}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
