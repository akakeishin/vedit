/**
 * Reconstruct the same logical undo/redo stacks as core/project.ts from the
 * revision log already returned to the browser. Keeping the availability
 * decision pure makes header controls truthful before a user clicks them.
 */
export function historyControlState(entries) {
  const undoStack = [];
  const redoStack = [];
  const sorted = [...(entries ?? [])].sort((a, b) => a.rev - b.rev);
  for (const entry of sorted) {
    const cause = entry.op === 'restore' ? entry.params?.cause : undefined;
    if (cause === 'undo') {
      undoStack.pop();
      redoStack.push(entry.baseRev);
    } else if (cause === 'redo') {
      redoStack.pop();
      undoStack.push(entry.baseRev);
    } else {
      undoStack.push(entry.baseRev);
      redoStack.length = 0;
    }
  }
  const undoTarget = undoStack.at(-1);
  const redoTarget = redoStack.at(-1);
  return {
    canUndo: undoTarget !== undefined && undoTarget !== 0,
    canRedo: redoTarget !== undefined,
    undoTarget: undoTarget !== undefined && undoTarget !== 0 ? undoTarget : null,
    redoTarget: redoTarget ?? null,
  };
}
