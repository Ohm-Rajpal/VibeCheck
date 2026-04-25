import ast
import json
import os
import sys
from typing import Any, Dict, List

def intersects(a_start: int, a_end: int, b_start: int, b_end: int) -> bool:
    print("changed something")
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

    sys.stdout.write(json.dumps({"changedFunctions": changed, "errors": []}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
