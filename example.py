def dfs_iterative(graph, start, visited=None):
    if visited is None:
        visited = set()

    stack = [start]

    while stack:
        node = stack.pop()
        if node in visited:
            continue
        visited.add(node)
        print(node, end=' ')

        for neighbor in graph[node]:
            if neighbor not in visited:
                stack.append(neighbor)

    return visited
