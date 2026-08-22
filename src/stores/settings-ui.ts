import { create } from 'zustand';
import type { Lane } from '@/lib/types/ipc';

export type SettingsSectionId = 'general' | 'accounts' | 'keyboard' | 'queue' | 'logs' | 'updates';
export type QueueStatusFilter = 'all' | 'failed';

export function laneKey(accountId: string, lane: Lane) {
  return `${accountId}:${lane}`;
}

type SettingsUiState = {
  activeSection: SettingsSectionId;
  setActiveSection: (section: SettingsSectionId) => void;
  expandedLanes: Set<string>;
  isLaneExpanded: (accountId: string, lane: Lane) => boolean;
  toggleLaneExpanded: (accountId: string, lane: Lane) => void;
  queueStatusFilter: QueueStatusFilter;
  setQueueStatusFilter: (filter: QueueStatusFilter) => void;
};

export const useSettingsUiStore = create<SettingsUiState>((set, get) => ({
  activeSection: 'general',
  setActiveSection: (activeSection) => set({ activeSection }),
  expandedLanes: new Set(),
  isLaneExpanded: (accountId, lane) => get().expandedLanes.has(laneKey(accountId, lane)),
  toggleLaneExpanded: (accountId, lane) =>
    set((state) => {
      const key = laneKey(accountId, lane);
      const next = new Set(state.expandedLanes);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return { expandedLanes: next };
    }),
  queueStatusFilter: 'all',
  setQueueStatusFilter: (queueStatusFilter) => set({ queueStatusFilter }),
}));
