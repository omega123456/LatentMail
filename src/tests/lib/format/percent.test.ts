import { describe, expect, it } from 'vitest';
import {
  fractionToPercent,
  percentOf,
  percentToFraction,
  WHOLE_PERCENT,
} from '@/lib/format/percent';

const QUARTER_PERCENT = 25;
const QUARTER_FRACTION = 0.25;

describe('percent', () => {
  it('expresses a part of a whole as a percentage, and an empty whole as zero', () => {
    const part = 1;
    const whole = 4;
    expect(percentOf(part, whole)).toBe(QUARTER_PERCENT);
    expect(percentOf(part, 0)).toBe(0);
  });

  it('converts between fractions and percentages', () => {
    expect(fractionToPercent(QUARTER_FRACTION)).toBe(QUARTER_PERCENT);
    expect(percentToFraction(QUARTER_PERCENT)).toBe(QUARTER_FRACTION);
    expect(percentToFraction(WHOLE_PERCENT)).toBe(1);
  });
});
