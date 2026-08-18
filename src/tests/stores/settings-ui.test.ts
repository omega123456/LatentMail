import { beforeEach, describe, expect, it } from 'vitest';
import { useSettingsUiStore } from '@/stores/settings-ui';

describe('settings-ui store', () => {
  beforeEach(() => {
    useSettingsUiStore.setState({
      activeSection: 'general',
      expandedLanes: new Set(),
      queueStatusFilter: 'all',
    });
  });

  it('defaults to the general section', () => {
    expect(useSettingsUiStore.getState().activeSection).toBe('general');
  });

  it('remembers the section selected for the app session', () => {
    useSettingsUiStore.getState().setActiveSection('queue');
    expect(useSettingsUiStore.getState().activeSection).toBe('queue');

    useSettingsUiStore.getState().setActiveSection('accounts');
    expect(useSettingsUiStore.getState().activeSection).toBe('accounts');
  });

  it('defaults every lane to collapsed', () => {
    expect(useSettingsUiStore.getState().isLaneExpanded('account-1', 'interactive')).toBe(false);
  });

  it('toggles a single account/lane pair independently of others', () => {
    const { toggleLaneExpanded, isLaneExpanded } = useSettingsUiStore.getState();
    toggleLaneExpanded('account-1', 'interactive');
    expect(isLaneExpanded('account-1', 'interactive')).toBe(true);
    expect(isLaneExpanded('account-1', 'background')).toBe(false);
    expect(isLaneExpanded('account-2', 'interactive')).toBe(false);

    toggleLaneExpanded('account-1', 'interactive');
    expect(isLaneExpanded('account-1', 'interactive')).toBe(false);
  });

  it('defaults the queue status filter to all and allows switching to failed', () => {
    expect(useSettingsUiStore.getState().queueStatusFilter).toBe('all');
    useSettingsUiStore.getState().setQueueStatusFilter('failed');
    expect(useSettingsUiStore.getState().queueStatusFilter).toBe('failed');
  });
});
