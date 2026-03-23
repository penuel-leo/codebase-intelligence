/**
 * Build inverse call map: for each indexed code chunk, which caller symbols invoke it.
 * Uses chunk `calls` (callee names) from AST/regex parsing; resolution is heuristic within a project+branch.
 */

export interface CodeRowForCalls {
  id: string;
  filePath: string;
  symbolName: string | null;
  className: string | null;
  chunkKind: string;
  calls: string[] | null;
}

/** Human-readable caller label stored in callee's `calledBy` array. */
export function callerLabel(row: CodeRowForCalls): string {
  const sym = row.symbolName?.trim() || '';
  if (!sym) return row.id;
  if (row.className && (row.chunkKind === 'method' || row.chunkKind === 'function')) {
    return `${row.className}.${sym}`;
  }
  return sym;
}

/**
 * Map callee identifier → target chunk row (single best match).
 */
export function resolveCallee(
  calleeName: string,
  caller: CodeRowForCalls,
  rows: CodeRowForCalls[],
): CodeRowForCalls | null {
  if (!calleeName) return null;

  const sameFile = rows.filter(
    r => r.filePath === caller.filePath && r.symbolName === calleeName,
  );
  if (sameFile.length === 1) return sameFile[0]!;

  if (sameFile.length > 1 && caller.className) {
    const inClass = sameFile.filter(
      r => r.className === caller.className && (r.chunkKind === 'method' || r.chunkKind === 'function'),
    );
    if (inClass.length === 1) return inClass[0]!;
  }

  if (sameFile.length > 1) {
    const methods = sameFile.filter(r => r.chunkKind === 'method' || r.chunkKind === 'function');
    if (methods.length === 1) return methods[0]!;
    return null;
  }

  const projectWide = rows.filter(r => r.symbolName === calleeName);
  if (projectWide.length === 1) return projectWide[0]!;

  return null;
}

/** id → sorted unique caller labels */
export function buildCalledByMap(rows: CodeRowForCalls[]): Map<string, string[]> {
  const acc = new Map<string, Set<string>>();
  for (const r of rows) {
    acc.set(r.id, new Set());
  }

  for (const caller of rows) {
    if (!caller.calls?.length) continue;
    const label = callerLabel(caller);
    for (const calleeName of caller.calls) {
      const target = resolveCallee(calleeName, caller, rows);
      if (target) {
        acc.get(target.id)!.add(label);
      }
    }
  }

  const out = new Map<string, string[]>();
  for (const [id, set] of acc) {
    if (set.size > 0) {
      out.set(id, [...set].sort());
    }
  }
  return out;
}
