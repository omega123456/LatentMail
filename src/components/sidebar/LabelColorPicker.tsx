import { useMemo, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import {
  LABEL_COLOR_BY_ID,
  LABEL_COLOR_PALETTE,
  type LabelColorId,
  type LabelColorSwatch,
} from '@/lib/labels/palette';
import { ICON_SIZE } from '@/components/shared/icon-size';
import { wrapIndex } from '@/lib/collections';
import { dispatchKey } from '@/lib/keyboard/dispatch';

const COLUMNS = 10;
const HEX_RADIX = 16;
const CHANNEL_MAX = 255;
const HUE_SECTORS = 6;
const GREEN_SECTOR_OFFSET = 2;
const BLUE_SECTOR_OFFSET = 4;
const DEGREES_PER_HUE_SECTOR = 60;
const FULL_CIRCLE_DEGREES = 360;

type HexDigits = { start: number; end: number };
type Rgb = { red: number; green: number; blue: number };

const RED_DIGITS: HexDigits = { start: 1, end: 3 };
const GREEN_DIGITS: HexDigits = { start: 3, end: 5 };
const BLUE_DIGITS: HexDigits = { start: 5, end: 7 };

export type LabelColorPickerProps = {
  selectedId: LabelColorId;
  onApply: (id: LabelColorId) => void;
  onCancel: () => void;
};

function hexChannel(hex: string, digits: HexDigits): number {
  return parseInt(hex.slice(digits.start, digits.end), HEX_RADIX) / CHANNEL_MAX;
}

function hueSector(rgb: Rgb, max: number, delta: number): number {
  if (max === rgb.red) return ((rgb.green - rgb.blue) / delta) % HUE_SECTORS;
  if (max === rgb.green) return (rgb.blue - rgb.red) / delta + GREEN_SECTOR_OFFSET;
  return (rgb.red - rgb.green) / delta + BLUE_SECTOR_OFFSET;
}

function hexToHue(hex: string): number {
  const rgb: Rgb = {
    red: hexChannel(hex, RED_DIGITS),
    green: hexChannel(hex, GREEN_DIGITS),
    blue: hexChannel(hex, BLUE_DIGITS),
  };
  const max = Math.max(rgb.red, rgb.green, rgb.blue);
  const min = Math.min(rgb.red, rgb.green, rgb.blue);
  const delta = max - min;
  if (delta === 0) return 0;
  const hue = hueSector(rgb, max, delta) * DEGREES_PER_HUE_SECTOR;
  return hue < 0 ? hue + FULL_CIRCLE_DEGREES : hue;
}

function byHueFamily(left: LabelColorSwatch, right: LabelColorSwatch): number {
  const leftHue = hexToHue(left.gmailBackground);
  const rightHue = hexToHue(right.gmailBackground);
  if (leftHue !== rightHue) return leftHue - rightHue;
  return left.gmailBackground.localeCompare(right.gmailBackground);
}

export function LabelColorPicker({ selectedId, onApply, onCancel }: LabelColorPickerProps) {
  const [pendingId, setPendingId] = useState(selectedId);
  const cellRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const palette = useMemo(() => [...LABEL_COLOR_PALETTE].sort(byHueFamily), []);
  const pendingSwatch = LABEL_COLOR_BY_ID[pendingId];
  const rows: LabelColorSwatch[][] = [];
  for (let start = 0; start < palette.length; start += COLUMNS) {
    rows.push(palette.slice(start, start + COLUMNS));
  }

  const focusIndex = (index: number) => {
    cellRefs.current[wrapIndex(index, 0, palette.length)]?.focus();
  };

  const handleKeyDown = (event: React.KeyboardEvent, index: number) => {
    const selectCurrent = () => setPendingId(palette[index].id);
    dispatchKey(event, {
      ArrowRight: () => focusIndex(index + 1),
      ArrowLeft: () => focusIndex(index - 1),
      ArrowDown: () => focusIndex(index + COLUMNS),
      ArrowUp: () => focusIndex(index - COLUMNS),
      Enter: selectCurrent,
      ' ': selectCurrent,
    });
  };

  return (
    <div
      data-testid="label-color-picker"
      className="flex w-full flex-col gap-2 rounded-md border border-outline-variant/40 bg-surface-container-lowest p-2 shadow-sm dark:border-dark-outline-variant dark:bg-dark-surface-container-lowest"
    >
      <h3 className="px-1 text-label-md text-secondary dark:text-dark-secondary">LABEL COLOUR</h3>
      <div
        role="grid"
        aria-label="Label colour"
        className="flex max-h-48 flex-col gap-1 overflow-y-auto p-1"
      >
        {rows.map((rowSwatches, rowIndex) => (
          <div key={rowSwatches[0].id} role="row" className="grid grid-cols-10 gap-1">
            {rowSwatches.map((swatch, columnIndex) => {
              const index = rowIndex * COLUMNS + columnIndex;
              const selected = swatch.id === pendingId;
              return (
                <button
                  key={swatch.id}
                  ref={(node) => {
                    cellRefs.current[index] = node;
                  }}
                  type="button"
                  role="gridcell"
                  aria-label={swatch.name}
                  aria-selected={selected}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => setPendingId(swatch.id)}
                  onKeyDown={(event) => handleKeyDown(event, index)}
                  className={`flex size-8 cursor-pointer items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-primary ${swatch.dotClass} ${selected ? 'ring-2 ring-primary ring-offset-1 dark:ring-dark-primary' : ''}`}
                >
                  {selected && (
                    <Check aria-hidden="true" size={ICON_SIZE.sm} className={swatch.textClass} />
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-outline-variant/40 pt-2 dark:border-dark-outline-variant">
        <span className="text-body-sm text-on-surface dark:text-dark-on-surface">
          {pendingSwatch.name}
        </span>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => {
              setPendingId(selectedId);
              onCancel();
            }}
            className="cursor-pointer rounded px-2 py-1 text-label-md text-secondary hover:bg-surface-container-low focus-visible:outline-2 focus-visible:outline-primary dark:text-dark-secondary dark:hover:bg-dark-surface-container"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={pendingId === selectedId}
            onClick={() => onApply(pendingId)}
            className="cursor-pointer rounded bg-primary px-3 py-1 text-label-md text-on-primary focus-visible:outline-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50 dark:bg-dark-primary dark:text-dark-on-primary"
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}
