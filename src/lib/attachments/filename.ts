const RESERVED_WINDOWS_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
]);

export function sanitizeFilename(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? filename;
  const withoutTraversal = base.replace(/\.\.+/g, '_');
  const withoutReservedCharacters = withoutTraversal.replace(/[<>:"|?*\p{Cc}]/gu, '_');
  const trimmed = withoutReservedCharacters.trim().replace(/[. ]+$/, '');
  if (trimmed.length === 0) return 'attachment';
  const [stem] = trimmed.split('.');
  if (RESERVED_WINDOWS_NAMES.has(stem.toUpperCase())) return `_${trimmed}`;
  return trimmed;
}
