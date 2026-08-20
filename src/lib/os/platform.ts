import { platform } from '@tauri-apps/plugin-os';

export function isWindows() {
  return platform() === 'windows';
}

export function isMacos() {
  return platform() === 'macos';
}
