import { beforeEach, describe, expect, it } from 'vitest';
import { selectIsMultiSelectActive, useMultiSelectStore } from '@/stores/multi-select';

const ids = ['a', 'b', 'c', 'd'];

beforeEach(() => {
  useMultiSelectStore.setState({ selectedIds: new Set(), anchorId: null });
});

describe('multi-select store', () => {
  it('toggles membership and moves the anchor', () => {
    useMultiSelectStore.getState().toggle('b');
    expect([...useMultiSelectStore.getState().selectedIds]).toEqual(['b']);
    expect(useMultiSelectStore.getState().anchorId).toBe('b');

    useMultiSelectStore.getState().toggle('b');
    expect(useMultiSelectStore.getState().selectedIds.size).toBe(0);
  });

  it('replaces the selection with a contiguous range from the anchor on shift-click', () => {
    useMultiSelectStore.getState().toggle('a');
    useMultiSelectStore.getState().selectRange(ids, 'c');
    expect([...useMultiSelectStore.getState().selectedIds].sort()).toEqual(['a', 'b', 'c']);
  });

  it('ranges backwards from the anchor just as well', () => {
    useMultiSelectStore.getState().toggle('c');
    useMultiSelectStore.getState().selectRange(ids, 'a');
    expect([...useMultiSelectStore.getState().selectedIds].sort()).toEqual(['a', 'b', 'c']);
  });

  it('selects just the target and anchors there when there is no prior anchor', () => {
    useMultiSelectStore.getState().selectRange(ids, 'b');
    expect([...useMultiSelectStore.getState().selectedIds]).toEqual(['b']);
    expect(useMultiSelectStore.getState().anchorId).toBe('b');
  });

  it('selects exactly the loaded rows on select-all, nothing more', () => {
    useMultiSelectStore.getState().selectAll(ids);
    expect([...useMultiSelectStore.getState().selectedIds].sort()).toEqual(ids);
  });

  it('clears the selection and anchor', () => {
    useMultiSelectStore.getState().selectAll(ids);
    useMultiSelectStore.getState().clear();
    expect(useMultiSelectStore.getState().selectedIds.size).toBe(0);
    expect(useMultiSelectStore.getState().anchorId).toBeNull();
  });

  it('prunes ids no longer present among the loaded rows, and drops an invalidated anchor', () => {
    useMultiSelectStore.getState().selectAll(ids);
    expect(useMultiSelectStore.getState().anchorId).toBe('a');
    useMultiSelectStore.getState().prune(['b', 'c']);
    expect([...useMultiSelectStore.getState().selectedIds].sort()).toEqual(['b', 'c']);
    expect(useMultiSelectStore.getState().anchorId).toBeNull();
  });

  it('prune is a genuine no-op when nothing changed, so it does not loop a reactive caller', () => {
    useMultiSelectStore.getState().toggle('a');
    const before = useMultiSelectStore.getState();
    useMultiSelectStore.getState().prune(ids);
    expect(useMultiSelectStore.getState()).toBe(before);
  });

  it('exposes whether a multi-selection is active', () => {
    expect(selectIsMultiSelectActive(useMultiSelectStore.getState())).toBe(false);
    useMultiSelectStore.getState().toggle('a');
    expect(selectIsMultiSelectActive(useMultiSelectStore.getState())).toBe(true);
  });
});
