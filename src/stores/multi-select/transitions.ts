import { toggleInSet } from '@/lib/collections';

export type MultiSelectData = {
  selectedIds: Set<string>;
  anchorId: string | null;
};

export function emptyMultiSelect(): MultiSelectData {
  return {
    selectedIds: new Set(),
    anchorId: null,
  };
}

export function toggleInMultiSelect(state: MultiSelectData, id: string): MultiSelectData {
  return {
    selectedIds: toggleInSet(state.selectedIds, id),
    anchorId: id,
  };
}

export function selectRangeInMultiSelect(
  state: MultiSelectData,
  input: { orderedIds: string[]; targetId: string },
): MultiSelectData {
  const anchor = state.anchorId ?? input.targetId;
  const anchorIndex = input.orderedIds.indexOf(anchor);
  const targetIndex = input.orderedIds.indexOf(input.targetId);
  if (anchorIndex === -1 || targetIndex === -1) {
    return { selectedIds: new Set([input.targetId]), anchorId: input.targetId };
  }
  const [start, end] =
    anchorIndex <= targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
  return {
    selectedIds: new Set(input.orderedIds.slice(start, end + 1)),
    anchorId: anchor,
  };
}

export function selectAllInMultiSelect(orderedIds: string[]): MultiSelectData {
  return {
    selectedIds: new Set(orderedIds),
    anchorId: orderedIds[0] ?? null,
  };
}

export function pruneMultiSelect(
  state: MultiSelectData,
  loadedIds: string[],
): MultiSelectData | null {
  const loaded = new Set(loadedIds);
  const stillSelected = [...state.selectedIds].filter((id) => loaded.has(id));
  const anchorStillValid = state.anchorId === null || loaded.has(state.anchorId);
  const unchanged = stillSelected.length === state.selectedIds.size && anchorStillValid;
  if (unchanged) return null;
  return {
    selectedIds: new Set(stillSelected),
    anchorId: anchorStillValid ? state.anchorId : null,
  };
}
