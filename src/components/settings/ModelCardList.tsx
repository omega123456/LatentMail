import { Check, ChevronDown, ChevronUp, Loader2 } from 'lucide-react';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { Select as SelectPrimitive } from 'radix-ui';
import { TextInput } from '@/components/shared/TextInput';
import { modelsOfKind } from '@/lib/ai/model-kind';
import { settingsLinkMuted } from './styles';
import type { AiModel } from '@/lib/types/ipc';
import { ICON_SIZE } from '@/components/shared/icon-size';
import { DROPDOWN_SIDE_OFFSET_PX } from '@/components/shared/floating-offsets';

const triggerClass =
  'w-full cursor-pointer rounded-control border border-settings-outline-variant bg-settings-card px-3.25 py-2.5 text-settings-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-settings-primary dark:border-dark-settings-outline-variant dark:bg-dark-settings-card dark:text-dark-settings-ink';
const contentClass =
  'z-50 max-h-64 overflow-hidden rounded-md border border-settings-outline-variant/40 bg-settings-card p-1 shadow-sm dark:border-dark-settings-outline-variant dark:bg-dark-settings-card';
const scrollButtonClass =
  'flex h-5 cursor-default items-center justify-center text-settings-ink-mute dark:text-dark-settings-ink-mute';
const itemClass =
  'flex cursor-pointer select-none items-center gap-2 rounded-sm px-2.5 py-1.75 outline-none hover:bg-settings-container-low dark:hover:bg-dark-settings-container-low data-[highlighted]:bg-settings-container-low data-[state=checked]:bg-settings-primary-container data-[state=checked]:text-settings-on-primary-container dark:data-[highlighted]:bg-dark-settings-container-low dark:data-[state=checked]:bg-dark-settings-primary-container dark:data-[state=checked]:text-dark-settings-on-primary-container';

type ShownModel = { id: string; detail: string };

function modelDetail(
  model: AiModel,
  selectedId: string | null,
  selectedDimension: number | null | undefined,
): string {
  const owner = model.ownedBy ?? 'Unknown owner';
  if (model.id === selectedId && selectedDimension) {
    return `${owner} · ${selectedDimension.toLocaleString()} dimensions`;
  }
  return owner;
}

function resolveShownModel(
  loadingId: string | null | undefined,
  selected: AiModel | null,
  selectedId: string | null,
  selectedDimension: number | null | undefined,
): ShownModel | null {
  if (loadingId) return { id: loadingId, detail: 'Loading model…' };
  if (!selected) return null;
  return { id: selected.id, detail: modelDetail(selected, selectedId, selectedDimension) };
}

function formatCatalogueCount(filter: string, visibleCount: number, totalCount: number): string {
  if (filter) return `${visibleCount.toLocaleString()} of ${totalCount.toLocaleString()}`;
  const noun = totalCount === 1 ? 'model' : 'models';
  return `${totalCount.toLocaleString()} ${noun}`;
}

function ModelTriggerSummary({
  shown,
  isLoading,
}: {
  shown: ShownModel | null;
  isLoading: boolean;
}) {
  return (
    <>
      <span className="min-w-0 flex-1">
        {shown ? (
          <>
            <span className="block truncate text-settings-desc font-medium">{shown.id}</span>
            <span className="block truncate text-settings-meta text-settings-ink-mute dark:text-dark-settings-ink-mute">
              {shown.detail}
            </span>
          </>
        ) : (
          <span className="text-settings-desc text-settings-ink-mute dark:text-dark-settings-ink-mute">
            Select a model…
          </span>
        )}
      </span>
      <SelectPrimitive.Icon>
        {isLoading ? (
          <Loader2
            aria-hidden="true"
            className="size-4 shrink-0 opacity-70 motion-safe:animate-spin"
          />
        ) : (
          <ChevronDown aria-hidden="true" className="size-4 shrink-0 opacity-70" />
        )}
      </SelectPrimitive.Icon>
    </>
  );
}

export function ModelCardList({
  accountEmail,
  label,
  kind,
  models,
  selectedId,
  selectedDimension,
  confirm,
  loadingId,
  onChange,
}: {
  accountEmail: string;
  label: string;
  kind: 'chat' | 'embedding';
  models: AiModel[];
  selectedId: string | null;
  selectedDimension?: number | null;
  confirm?: ReactNode;
  loadingId?: string | null;
  onChange: (id: string) => void;
}) {
  const [filter, setFilter] = useState('');
  const [showAll, setShowAll] = useState(false);
  const filterRef = useRef<HTMLInputElement>(null);
  const firstItemRef = useRef<HTMLDivElement>(null);
  const navigatingRef = useRef(false);
  const ofKind = useMemo(() => modelsOfKind(models, kind, selectedId), [kind, models, selectedId]);
  const catalogue = showAll ? models : ofKind;
  const visible = useMemo(
    () => catalogue.filter((model) => model.id.toLowerCase().includes(filter.toLowerCase())),
    [catalogue, filter],
  );
  const selected = models.find((model) => model.id === selectedId) ?? null;
  const isLoading = Boolean(loadingId);
  const shown = resolveShownModel(loadingId, selected, selectedId, selectedDimension);

  return (
    <div className="flex flex-col gap-2.25">
      <SelectPrimitive.Root
        value={selectedId ?? ''}
        onValueChange={onChange}
        onOpenChange={(next) => {
          navigatingRef.current = false;
          if (!next) {
            setFilter('');
            setShowAll(false);
          }
        }}
      >
        <SelectPrimitive.Trigger
          aria-label={`${label} model for ${accountEmail}`}
          aria-busy={isLoading}
          disabled={isLoading}
          className={`flex items-center justify-between gap-3 text-left disabled:cursor-progress disabled:opacity-70 ${triggerClass}`}
        >
          <ModelTriggerSummary shown={shown} isLoading={isLoading} />
        </SelectPrimitive.Trigger>
        <SelectPrimitive.Portal>
          <SelectPrimitive.Content
            position="popper"
            sideOffset={DROPDOWN_SIDE_OFFSET_PX}
            className={contentClass}
            style={{ minWidth: 'var(--radix-select-trigger-width)' }}
            onFocusCapture={(event) => {
              if (event.target === filterRef.current) return;
              if (!navigatingRef.current) queueMicrotask(() => filterRef.current?.focus());
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowUp' && document.activeElement === firstItemRef.current) {
                event.preventDefault();
                navigatingRef.current = false;
                filterRef.current?.focus();
              }
            }}
          >
            <div className="flex items-center gap-2 border-b border-settings-outline-variant/40 px-1 pb-1.5 dark:border-dark-settings-outline-variant">
              <TextInput
                ref={filterRef}
                aria-label={`Filter ${label} models for ${accountEmail}`}
                value={filter}
                onChange={(event) => {
                  navigatingRef.current = false;
                  setFilter(event.target.value);
                }}
                onKeyDown={(event) => {
                  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                    navigatingRef.current = true;
                    return;
                  }
                  if (event.key !== 'Escape') event.stopPropagation();
                }}
                placeholder="Filter models…"
                className="min-w-0 flex-1"
              />
              <span className="shrink-0 text-settings-meta tabular-nums text-settings-ink-mute dark:text-dark-settings-ink-mute">
                {formatCatalogueCount(filter, visible.length, catalogue.length)}
              </span>
              {ofKind.length !== models.length && (
                <button
                  type="button"
                  onClick={() => setShowAll((wasShowingAll) => !wasShowingAll)}
                  className={`shrink-0 ${settingsLinkMuted}`}
                >
                  {showAll ? `${label} only` : 'Show all'}
                </button>
              )}
            </div>
            <SelectPrimitive.ScrollUpButton className={scrollButtonClass}>
              <ChevronUp aria-hidden="true" className="size-4" />
            </SelectPrimitive.ScrollUpButton>
            <SelectPrimitive.Viewport className="flex max-h-52 flex-col gap-0.5 overflow-y-auto">
              {visible.map((model, index) => (
                <SelectPrimitive.Item
                  key={model.id}
                  value={model.id}
                  ref={index === 0 ? firstItemRef : undefined}
                  onPointerMove={(event) => event.preventDefault()}
                  className={itemClass}
                >
                  <span className="min-w-0 flex-1">
                    <SelectPrimitive.ItemText>
                      <span className="block truncate text-settings-desc font-semibold">
                        {model.id}
                      </span>
                    </SelectPrimitive.ItemText>
                    <span className="block truncate text-settings-meta opacity-80">
                      {modelDetail(model, selectedId, selectedDimension)}
                    </span>
                  </span>
                  <SelectPrimitive.ItemIndicator>
                    <Check
                      aria-label="Selected"
                      size={ICON_SIZE.md}
                      className="shrink-0 text-settings-primary dark:text-dark-settings-primary"
                    />
                  </SelectPrimitive.ItemIndicator>
                </SelectPrimitive.Item>
              ))}
            </SelectPrimitive.Viewport>
            <SelectPrimitive.ScrollDownButton className={scrollButtonClass}>
              <ChevronDown aria-hidden="true" className="size-4" />
            </SelectPrimitive.ScrollDownButton>
          </SelectPrimitive.Content>
        </SelectPrimitive.Portal>
      </SelectPrimitive.Root>
      {confirm}
    </div>
  );
}
