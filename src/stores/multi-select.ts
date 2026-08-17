import { create } from 'zustand';

type MultiSelectState = {
  selectedIds: Set<string>;
  anchorId: string | null;
  toggle: (id: string) => void;
  selectRange: (orderedIds: string[], targetId: string) => void;
  selectAll: (orderedIds: string[]) => void;
  clear: () => void;
  prune: (loadedIds: string[]) => void;
};

export const useMultiSelectStore = create<MultiSelectState>((set, get) => ({
  selectedIds: new Set(),
  anchorId: null,
  toggle: (id) =>
    set((state) => {
      const selectedIds = new Set(state.selectedIds);
      if (selectedIds.has(id)) selectedIds.delete(id);
      else selectedIds.add(id);
      return { selectedIds, anchorId: id };
    }),
  selectRange: (orderedIds, targetId) => {
    const anchor = get().anchorId ?? targetId;
    const anchorIndex = orderedIds.indexOf(anchor);
    const targetIndex = orderedIds.indexOf(targetId);
    if (anchorIndex === -1 || targetIndex === -1) {
      set({ selectedIds: new Set([targetId]), anchorId: targetId });
      return;
    }
    const [start, end] =
      anchorIndex <= targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
    set({ selectedIds: new Set(orderedIds.slice(start, end + 1)), anchorId: anchor });
  },
  selectAll: (orderedIds) =>
    set({ selectedIds: new Set(orderedIds), anchorId: orderedIds[0] ?? null }),
  clear: () => set({ selectedIds: new Set(), anchorId: null }),
  prune: (loadedIds) => {
    const state = get();
    const loaded = new Set(loadedIds);
    const stillSelected = [...state.selectedIds].filter((id) => loaded.has(id));
    const anchorStillValid = state.anchorId === null || loaded.has(state.anchorId);
    if (stillSelected.length === state.selectedIds.size && anchorStillValid) return;
    set({
      selectedIds: new Set(stillSelected),
      anchorId: anchorStillValid ? state.anchorId : null,
    });
  },
}));

export function selectIsMultiSelectActive(state: Pick<MultiSelectState, 'selectedIds'>): boolean {
  return state.selectedIds.size > 0;
}
