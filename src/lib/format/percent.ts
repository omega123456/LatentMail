export const WHOLE_PERCENT = 100;

export function percentOf(part: number, whole: number): number {
  if (whole === 0) return 0;
  return (part / whole) * WHOLE_PERCENT;
}

export function fractionToPercent(fraction: number): number {
  return fraction * WHOLE_PERCENT;
}

export function percentToFraction(percent: number): number {
  return percent / WHOLE_PERCENT;
}
