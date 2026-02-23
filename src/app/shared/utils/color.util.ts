/** HSV color representation (hue: 0–360, saturation: 0–1, value/brightness: 0–1). */
export interface HsvColor {
  hue: number;
  saturation: number;
  value: number;
}

/**
 * Convert a 6-digit hex color string (#RRGGBB) to HSV.
 * Returns null if the input is not a valid 6-digit hex string.
 */
export function hexToHsv(hex: string): HsvColor | null {
  const normalized = normalizeHex(hex);
  if (!normalized) {
    return null;
  }
  const red = parseInt(normalized.slice(1, 3), 16) / 255;
  const green = parseInt(normalized.slice(3, 5), 16) / 255;
  const blue = parseInt(normalized.slice(5, 7), 16) / 255;

  const maxChannel = Math.max(red, green, blue);
  const minChannel = Math.min(red, green, blue);
  const delta = maxChannel - minChannel;

  let hue = 0;
  if (delta > 0) {
    if (maxChannel === red) {
      hue = 60 * (((green - blue) / delta) % 6);
    } else if (maxChannel === green) {
      hue = 60 * ((blue - red) / delta + 2);
    } else {
      hue = 60 * ((red - green) / delta + 4);
    }
  }
  if (hue < 0) {
    hue += 360;
  }

  const saturation = maxChannel === 0 ? 0 : delta / maxChannel;
  const value = maxChannel;

  return { hue, saturation, value };
}

/**
 * Convert HSV to a normalized uppercase #RRGGBB hex string.
 * Hue: 0–360, saturation: 0–1, value: 0–1.
 */
export function hsvToHex(hue: number, saturation: number, value: number): string {
  const clampedHue = ((hue % 360) + 360) % 360;
  const clampedSaturation = Math.max(0, Math.min(1, saturation));
  const clampedValue = Math.max(0, Math.min(1, value));

  const chroma = clampedValue * clampedSaturation;
  const hueSector = clampedHue / 60;
  const intermediate = chroma * (1 - Math.abs((hueSector % 2) - 1));

  let red = 0;
  let green = 0;
  let blue = 0;

  if (hueSector >= 0 && hueSector < 1) {
    red = chroma; green = intermediate; blue = 0;
  } else if (hueSector < 2) {
    red = intermediate; green = chroma; blue = 0;
  } else if (hueSector < 3) {
    red = 0; green = chroma; blue = intermediate;
  } else if (hueSector < 4) {
    red = 0; green = intermediate; blue = chroma;
  } else if (hueSector < 5) {
    red = intermediate; green = 0; blue = chroma;
  } else {
    red = chroma; green = 0; blue = intermediate;
  }

  const match = clampedValue - chroma;
  const toHex = (channel: number): string => {
    const byte = Math.round((channel + match) * 255);
    return Math.max(0, Math.min(255, byte)).toString(16).padStart(2, '0');
  };

  return `#${toHex(red)}${toHex(green)}${toHex(blue)}`.toUpperCase();
}

/**
 * Normalize a hex color string to uppercase 6-digit #RRGGBB format.
 * Accepts:
 *   - "#RRGGBB" (already normalized)
 *   - "#RGB" (3-digit shorthand) → expanded
 *   - "RRGGBB" (no leading #) → prefixed
 *   - "rrggbb" (lowercase) → uppercased
 * Returns null if the input is not a recognizable hex format.
 */
export function normalizeHex(input: string): string | null {
  if (typeof input !== 'string') {
    return null;
  }
  let value = input.trim();

  // Strip leading '#' for processing
  if (value.startsWith('#')) {
    value = value.slice(1);
  }

  // Expand 3-digit shorthand to 6-digit
  if (/^[0-9A-Fa-f]{3}$/.test(value)) {
    value = value[0] + value[0] + value[1] + value[1] + value[2] + value[2];
  }

  if (!/^[0-9A-Fa-f]{6}$/.test(value)) {
    return null;
  }

  return `#${value.toUpperCase()}`;
}

/**
 * Check whether a string is a valid #RRGGBB hex color.
 * Also accepts lowercase and the 3-digit shorthand.
 */
export function isValidHex(input: string): boolean {
  return normalizeHex(input) !== null;
}
