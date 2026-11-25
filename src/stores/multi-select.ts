import { create } from 'zustand';
import {
  emptyMultiSelect,
  pruneMultiSelect,
  selectAllInMultiSelect,
  selectRangeInMultiSelect,
  toggleInMultiSelect,
} from './multi-select/transitions';

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
  ...emptyMultiSelect(),
  toggle: (id) => set((state) => toggleInMultiSelect(state, id)),
  selectRange: (orderedIds, targetId) =>
    set((state) => selectRangeInMultiSelect(state, { orderedIds, targetId })),
  selectAll: (orderedIds) => set(selectAllInMultiSelect(orderedIds)),
  clear: () => set(emptyMultiSelect()),
  prune: (loadedIds) => {
    const next = pruneMultiSelect(get(), loadedIds);
    if (next) set(next);
  },
}));

export function selectIsMultiSelectActive(state: Pick<MultiSelectState, 'selectedIds'>): boolean {
  return state.selectedIds.size > 0;
}
