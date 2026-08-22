import { invoke } from '@/lib/ipc/commands';
import type { Settings } from '@/lib/types/ipc';

let settings: Promise<Settings> | undefined;

export function hydrateSettings() {
  settings ??= invoke('read_settings', {});
  return settings;
}

export function resetSettingsHydration() {
  settings = undefined;
}
