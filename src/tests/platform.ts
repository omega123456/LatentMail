export const MAC_PLATFORM = 'MacIntel';
export const WINDOWS_PLATFORM = 'Win32';

export function setPlatform(platform: string) {
  Object.defineProperty(window.navigator, 'platform', { value: platform, configurable: true });
}
