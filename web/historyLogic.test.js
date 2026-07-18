import { describe, expect, it } from 'vitest';
import { historyControlState } from './historyLogic.js';

function entries(spec) {
  return spec.map((item, index) => ({
    rev: index + 1,
    baseRev: index,
    op: item === 'edit' ? 'edit' : 'restore',
    ...(item === 'edit' ? {} : { params: { rev: item.restore, ...(item.cause ? { cause: item.cause } : {}) } }),
  }));
}

describe('historyControlState', () => {
  it('disables both controls for an empty or first-edit-only history', () => {
    expect(historyControlState([])).toEqual({ canUndo: false, canRedo: false, undoTarget: null, redoTarget: null });
    expect(historyControlState(entries(['edit']))).toMatchObject({ canUndo: false, canRedo: false });
  });

  it('enables undo once a restorable prior revision exists', () => {
    expect(historyControlState(entries(['edit', 'edit', 'edit']))).toEqual({
      canUndo: true, canRedo: false, undoTarget: 2, redoTarget: null,
    });
  });

  it('enables redo after undo and walks consecutive undo entries backward', () => {
    const oneUndo = [
      ...entries(['edit', 'edit', 'edit']),
      { rev: 4, baseRev: 3, op: 'restore', params: { rev: 2, cause: 'undo' } },
    ];
    expect(historyControlState(oneUndo)).toEqual({ canUndo: true, canRedo: true, undoTarget: 1, redoTarget: 3 });

    const twoUndos = [
      ...oneUndo,
      { rev: 5, baseRev: 4, op: 'restore', params: { rev: 1, cause: 'undo' } },
    ];
    expect(historyControlState(twoUndos)).toEqual({ canUndo: false, canRedo: true, undoTarget: null, redoTarget: 4 });
  });

  it('consumes redo symmetrically', () => {
    const state = [
      ...entries(['edit', 'edit', 'edit']),
      { rev: 4, baseRev: 3, op: 'restore', params: { rev: 2, cause: 'undo' } },
      { rev: 5, baseRev: 4, op: 'restore', params: { rev: 3, cause: 'redo' } },
    ];
    expect(historyControlState(state)).toEqual({ canUndo: true, canRedo: false, undoTarget: 4, redoTarget: null });
  });

  it('invalidates redo after a normal edit or legacy/manual restore', () => {
    const undone = [
      ...entries(['edit', 'edit', 'edit']),
      { rev: 4, baseRev: 3, op: 'restore', params: { rev: 2, cause: 'undo' } },
    ];
    expect(historyControlState([...undone, { rev: 5, baseRev: 4, op: 'edit' }]).canRedo).toBe(false);
    expect(historyControlState([...undone, { rev: 5, baseRev: 4, op: 'restore', params: { rev: 1 } }]).canRedo).toBe(false);
  });

  it('sorts unordered revision input before replaying it', () => {
    const state = entries(['edit', 'edit', 'edit']);
    expect(historyControlState([state[2], state[0], state[1]])).toMatchObject({ undoTarget: 2, canUndo: true });
  });
});
