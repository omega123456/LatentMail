import { create } from 'zustand';

type MultiSelectState = {
  /** Conversation ids currently checked for a bulk action. */
  selectedIds: Set<string>;
  /** The id shift-click ranges extend from. */
  anchorId: string | null;
  /** `Cmd`/`Ctrl`-click: toggles one id's membership and moves the anchor
   * to it. */
  toggle: (id: string) => void;
  /** `Shift`-click: replaces the selection with the contiguous range in
   * `orderedIds` between the current anchor and `targetId` (inclusive). If
   * there is no anchor yet, `targetId` becomes both the anchor and the
   * whole selection. */
  selectRange: (orderedIds: string[], targetId: string) => void;
  /** `Cmd`/`Ctrl`-A: selects every currently *loaded* id — never a
   * server-side "everything in this mailbox" semantic. */
  selectAll: (orderedIds: string[]) => void;
  /** Plain click, mailbox switch, account switch: drops the selection. */
  clear: () => void;
  /** A list refresh: drops any selected id no longer present among the
   * currently loaded rows. */
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
    // A genuine no-op deliberately skips `set` entirely (not just returns an
    // unchanged value from it) — callers run this from a render-triggered
    // effect on every list refresh, and `set` always notifies subscribers
    // even when the values are equal, which would otherwise loop forever.
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

/** Selector helper: whether any conversation is currently multi-selected. */
export function selectIsMultiSelectActive(state: Pick<MultiSelectState, 'selectedIds'>): boolean {
  return state.selectedIds.size > 0;
}
