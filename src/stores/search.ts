import { create } from 'zustand';
import { useMultiSelectStore } from './multi-select';
import { useSelectionStore } from './selection';
import type { SearchScope } from '@/lib/types/ipc';

export const MAX_SEARCH_QUERY_LENGTH = 2048;

type SearchState = {
  draft: string;
  submittedQuery: string;
  scope: SearchScope;
  active: boolean;
  panelOpen: boolean;
  setDraft: (draft: string) => void;
  setScope: (scope: SearchScope) => void;
  openPanel: () => void;
  closePanel: () => void;
  submit: (query: string) => void;
  clear: () => void;
};

export const useSearchStore = create<SearchState>((set) => ({
  draft: '',
  submittedQuery: '',
  scope: { kind: 'default' },
  active: false,
  panelOpen: false,
  setDraft: (draft) => set({ draft }),
  setScope: (scope) => {
    useSelectionStore.getState().clearSelection();
    set({ scope });
  },
  openPanel: () => set({ panelOpen: true }),
  closePanel: () => set({ panelOpen: false }),
  submit: (query) => {
    useMultiSelectStore.getState().clear();
    useSelectionStore.getState().clearSelection();
    set({ draft: query, submittedQuery: query, active: true, panelOpen: false });
  },
  clear: () => {
    useSelectionStore.getState().clearSelection();
    set({ draft: '', submittedQuery: '', active: false, panelOpen: false });
  },
}));
