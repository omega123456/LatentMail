import { useMemo, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import {
  LABEL_COLOR_PALETTE,
  type LabelColorId,
  type LabelColorSwatch,
} from '@/lib/labels/palette';

const COLUMNS = 10;

export type LabelColorPickerProps = {
  selectedId: LabelColorId;
  onApply: (id: LabelColorId) => void;
  onCancel: () => void;
};

function hexToHue(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta === 0) return 0;
  let hue: number;
  if (max === r) hue = ((g - b) / delta) % 6;
  else if (max === g) hue = (b - r) / delta + 2;
  else hue = (r - g) / delta + 4;
  hue *= 60;
  return hue < 0 ? hue + 360 : hue;
}

function byHueFamily(a: LabelColorSwatch, b: LabelColorSwatch): number {
  const hueA = hexToHue(a.gmailBackground);
  const hueB = hexToHue(b.gmailBackground);
  if (hueA !== hueB) return hueA - hueB;
  return a.gmailBackground.localeCompare(b.gmailBackground);
}

export function LabelColorPicker({ selectedId, onApply, onCancel }: LabelColorPickerProps) {
  const [pendingId, setPendingId] = useState(selectedId);
  const cellRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const palette = useMemo(() => [...LABEL_COLOR_PALETTE].sort(byHueFamily), []);
  const pendingSwatch = palette.find((swatch) => swatch.id === pendingId)!;
  const rows: LabelColorSwatch[][] = [];
  for (let start = 0; start < palette.length; start += COLUMNS) {
    rows.push(palette.slice(start, start + COLUMNS));
  }

  const focusIndex = (index: number) => {
    const count = palette.length;
    const wrapped = ((index % count) + count) % count;
    cellRefs.current[wrapped]?.focus();
  };

  const handleKeyDown = (event: React.KeyboardEvent, index: number) => {
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      focusIndex(index + 1);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      focusIndex(index - 1);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusIndex(index + COLUMNS);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusIndex(index - COLUMNS);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setPendingId(palette[index].id);
    }
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
          <div key={rowSwatches[0]!.id} role="row" className="grid grid-cols-10 gap-1">
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
                  {selected && <Check aria-hidden="true" size={14} className={swatch.textClass} />}
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
