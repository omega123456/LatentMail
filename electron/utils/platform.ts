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

export function isArch(arch: NodeJS.Architecture): boolean {
  return process.arch === arch;
}

export function isX64(): boolean {
  return isArch('x64');
}

export function isArm64(): boolean {
  return isArch('arm64');
}
