export function isPlatform(platform: NodeJS.Platform): boolean {
  return process.platform === platform;
}

export function isWindows(): boolean {
  return isPlatform('win32');
}

export function isMacOS(): boolean {
  return isPlatform('darwin');
}

export function isLinux(): boolean {
  return isPlatform('linux');
}
