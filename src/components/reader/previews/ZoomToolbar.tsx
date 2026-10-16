import type { ReactNode } from 'react';
import { DropdownMenu } from 'radix-ui';
import { Check, ChevronDown, Minus, Plus } from 'lucide-react';
import { formatZoom, MAX_ZOOM, MIN_ZOOM, ZOOM_STEPS, type ZoomMode } from '@/lib/attachments/zoom';
import type { ZoomPreset } from '@/lib/attachments/useZoom';

const iconButtonClass =
  'cursor-pointer rounded-chip p-1.5 hover:bg-surface-container aria-disabled:cursor-default aria-disabled:opacity-40 aria-disabled:hover:bg-transparent focus-visible:outline-2 focus-visible:outline-primary dark:hover:bg-dark-surface-container dark:aria-disabled:hover:bg-transparent';
const contentClass =
  'z-50 flex min-w-40 flex-col gap-0.5 rounded-md border border-outline-variant/40 bg-surface-container-lowest p-1 shadow-sm dark:border-dark-outline-variant dark:bg-dark-surface-container-lowest';
const itemClass =
  'flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-body-sm tabular-nums text-on-surface outline-none data-[highlighted]:bg-surface-container-high data-[state=checked]:font-semibold data-[state=checked]:text-primary dark:text-dark-on-surface dark:data-[highlighted]:bg-dark-surface-container-high dark:data-[state=checked]:text-dark-primary';

const FIT_PRESETS: { value: ZoomMode; label: string }[] = [
  { value: 'fit-width', label: 'Fit width' },
  { value: 'fit-page', label: 'Fit page' },
];

function presetOf(value: string): ZoomPreset {
  return value === 'fit-width' || value === 'fit-page' ? value : Number(value);
}

function portalTarget(): HTMLElement | undefined {
  return document.getElementById('root') ?? undefined;
}

function RadioItem({ value, label }: { value: string; label: string }) {
  return (
    <DropdownMenu.RadioItem value={value} className={itemClass}>
      <span className="flex size-4 shrink-0 items-center justify-center">
        <DropdownMenu.ItemIndicator>
          <Check aria-hidden="true" className="size-4" />
        </DropdownMenu.ItemIndicator>
      </span>
      {label}
    </DropdownMenu.RadioItem>
  );
}

export function ZoomToolbar({
  zoom,
  mode,
  leading,
  onZoomIn,
  onZoomOut,
  onSelectPreset,
}: {
  zoom: number;
  mode: ZoomMode;
  leading?: ReactNode;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onSelectPreset: (preset: ZoomPreset) => void;
}) {
  const percent = formatZoom(zoom);
  const atMin = zoom <= MIN_ZOOM;
  const atMax = zoom >= MAX_ZOOM;
  const announcement = atMax
    ? `Maximum zoom, ${percent}`
    : atMin
      ? `Minimum zoom, ${percent}`
      : `Zoom ${percent}`;

  return (
    <div
      role="toolbar"
      aria-label="Preview controls"
      className="flex items-center justify-between gap-stack-gap-sm border-t border-outline-variant px-3 py-1.5 text-body-sm text-on-surface-variant dark:border-dark-outline-variant dark:text-dark-on-surface-variant"
    >
      <span className="tabular-nums">{leading}</span>
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-label="Zoom out"
          aria-disabled={atMin}
          onClick={onZoomOut}
          className={iconButtonClass}
        >
          <Minus size={16} aria-hidden="true" />
        </button>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              aria-label={`Zoom level ${percent}`}
              className="flex w-zoom-readout cursor-pointer items-center justify-center gap-1 rounded-chip py-1 font-medium tabular-nums text-on-surface hover:bg-surface-container focus-visible:outline-2 focus-visible:outline-primary data-[state=open]:bg-surface-container dark:text-dark-on-surface dark:hover:bg-dark-surface-container dark:data-[state=open]:bg-dark-surface-container"
            >
              {percent}
              <ChevronDown size={12} aria-hidden="true" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal container={portalTarget()}>
            <DropdownMenu.Content side="top" align="center" sideOffset={6} className={contentClass}>
              <DropdownMenu.RadioGroup
                value={mode === 'custom' ? String(zoom) : mode}
                onValueChange={(value) => onSelectPreset(presetOf(value))}
              >
                {FIT_PRESETS.map(({ value, label }) => (
                  <RadioItem key={value} value={value} label={label} />
                ))}
                <DropdownMenu.Separator className="mx-1 my-1 h-px bg-outline-variant/40 dark:bg-dark-outline-variant" />
                {ZOOM_STEPS.map((step) => (
                  <RadioItem key={step} value={String(step)} label={formatZoom(step)} />
                ))}
              </DropdownMenu.RadioGroup>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
        <button
          type="button"
          aria-label="Zoom in"
          aria-disabled={atMax}
          onClick={onZoomIn}
          className={iconButtonClass}
        >
          <Plus size={16} aria-hidden="true" />
        </button>
        <span className="sr-only" aria-live="polite">
          {announcement}
        </span>
      </div>
    </div>
  );
}
