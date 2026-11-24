import { beforeEach, describe, expect, it } from 'vitest';
import { isWindows } from '@/lib/os/platform';

function setPlatform(platform: 'macos' | 'windows') {
  Object.assign(window, {
    __TAURI_OS_PLUGIN_INTERNALS__: {
      eol: '\n',
      os_type: platform,
      platform,
      family: platform === 'windows' ? 'windows' : 'unix',
      version: '',
      arch: 'x86_64',
      exe_extension: platform === 'windows' ? 'exe' : '',
    },
  });
}

describe('platform', () => {
  beforeEach(() => setPlatform('macos'));

  it('identifies Windows from the OS plugin global', () => {
    setPlatform('windows');

    expect(isWindows()).toBe(true);
  });

  it('identifies macOS from the OS plugin global', () => {
    expect(isWindows()).toBe(false);
  });
});
