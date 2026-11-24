const UNITS = ['B', 'KB', 'MB', 'GB'];
const BYTES_PER_KILOBYTE = 1024;
const WHOLE_NUMBER_THRESHOLD = 10;
const ONE_DECIMAL_SCALE = 10;

export function formatFileSize(bytes: number): string {
  if (bytes < BYTES_PER_KILOBYTE) return `${bytes} B`;
  let sizeInUnit = bytes / BYTES_PER_KILOBYTE;
  let unitIndex = 1;
  while (sizeInUnit >= BYTES_PER_KILOBYTE && unitIndex < UNITS.length - 1) {
    sizeInUnit /= BYTES_PER_KILOBYTE;
    unitIndex += 1;
  }
  const rounded =
    sizeInUnit >= WHOLE_NUMBER_THRESHOLD
      ? Math.round(sizeInUnit)
      : Math.round(sizeInUnit * ONE_DECIMAL_SCALE) / ONE_DECIMAL_SCALE;
  return `${rounded} ${UNITS[unitIndex]}`;
}
