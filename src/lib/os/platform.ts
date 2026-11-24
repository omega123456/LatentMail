import { platform } from '@tauri-apps/plugin-os';

export function isWindows() {
  return platform() === 'windows';
}
