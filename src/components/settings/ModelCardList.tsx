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

function resolveShownModel({
  loadingId,
  selected,
  selectedId,
  selectedDimension,
}: {
  loadingId: string | null | undefined;
  selected: AiModel | null;
  selectedId: string | null;
  selectedDimension: number | null | undefined;
}): ShownModel | null {
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

function ModelFilterBar({
  filterRef,
  navigatingRef,
  label,
  accountEmail,
  filter,
  visibleCount,
  catalogueCount,
  canToggleAll,
  showAll,
  onFilterChange,
  onToggleShowAll,
}: {
  filterRef: React.RefObject<HTMLInputElement | null>;
  navigatingRef: React.RefObject<boolean>;
  label: string;
  accountEmail: string;
  filter: string;
  visibleCount: number;
  catalogueCount: number;
  canToggleAll: boolean;
  showAll: boolean;
  onFilterChange: (next: string) => void;
  onToggleShowAll: () => void;
}) {
  return (
    <div className="flex items-center gap-2 border-b border-settings-outline-variant/40 px-1 pb-1.5 dark:border-dark-settings-outline-variant">
      <TextInput
        ref={filterRef}
        aria-label={`Filter ${label} models for ${accountEmail}`}
        value={filter}
        onChange={(event) => {
          navigatingRef.current = false;
          onFilterChange(event.target.value);
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
        {formatCatalogueCount(filter, visibleCount, catalogueCount)}
      </span>
      {canToggleAll && (
        <button type="button" onClick={onToggleShowAll} className={`shrink-0 ${settingsLinkMuted}`}>
          {showAll ? `${label} only` : 'Show all'}
        </button>
      )}
    </div>
  );
}

function ModelOptionList({
  visible,
  firstItemRef,
  selectedId,
  selectedDimension,
}: {
  visible: AiModel[];
  firstItemRef: React.RefObject<HTMLDivElement | null>;
  selectedId: string | null;
  selectedDimension: number | null | undefined;
}) {
  return (
    <>
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
                <span className="block truncate text-settings-desc font-semibold">{model.id}</span>
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
    </>
  );
}

type ModelCardListProps = {
  accountEmail: string;
  label: string;
  kind: 'chat' | 'embedding';
  models: AiModel[];
  selectedId: string | null;
  selectedDimension?: number | null;
  confirm?: ReactNode;
  loadingId?: string | null;
  onChange: (id: string) => void;
};

function useModelCatalogue(props: ModelCardListProps) {
  const [filter, setFilter] = useState('');
  const [showAll, setShowAll] = useState(false);
  const ofKind = useMemo(
    () => modelsOfKind(props.models, props.kind, props.selectedId),
    [props.kind, props.models, props.selectedId],
  );
  const catalogue = showAll ? props.models : ofKind;
  const visible = useMemo(
    () => catalogue.filter((model) => model.id.toLowerCase().includes(filter.toLowerCase())),
    [catalogue, filter],
  );
  const selected = props.models.find((model) => model.id === props.selectedId) ?? null;
  const shown = resolveShownModel({
    loadingId: props.loadingId,
    selected: selected,
    selectedId: props.selectedId,
    selectedDimension: props.selectedDimension,
  });
  return {
    filter: filter,
    setFilter: setFilter,
    showAll: showAll,
    setShowAll: setShowAll,
    ofKind: ofKind,
    catalogue: catalogue,
    visible: visible,
    shown: shown,
  };
}

function ModelSelectDropdown({
  props,
  state,
  navigatingRef,
}: {
  props: ModelCardListProps;
  state: ReturnType<typeof useModelCatalogue>;
  navigatingRef: React.RefObject<boolean>;
}) {
  const filterRef = useRef<HTMLInputElement>(null);
  const firstItemRef = useRef<HTMLDivElement>(null);
  return (
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
        <ModelFilterBar
          filterRef={filterRef}
          navigatingRef={navigatingRef}
          label={props.label}
          accountEmail={props.accountEmail}
          filter={state.filter}
          visibleCount={state.visible.length}
          catalogueCount={state.catalogue.length}
          canToggleAll={state.ofKind.length !== props.models.length}
          showAll={state.showAll}
          onFilterChange={state.setFilter}
          onToggleShowAll={() => state.setShowAll((wasShowingAll) => !wasShowingAll)}
        />
        <ModelOptionList
          visible={state.visible}
          firstItemRef={firstItemRef}
          selectedId={props.selectedId}
          selectedDimension={props.selectedDimension}
        />
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

export function ModelCardList(props: ModelCardListProps) {
  const navigatingRef = useRef(false);
  const state = useModelCatalogue(props);
  const isLoading = Boolean(props.loadingId);

  return (
    <div className="flex flex-col gap-2.25">
      <SelectPrimitive.Root
        value={props.selectedId ?? ''}
        onValueChange={props.onChange}
        onOpenChange={(next) => {
          navigatingRef.current = false;
          if (!next) {
            state.setFilter('');
            state.setShowAll(false);
          }
        }}
      >
        <SelectPrimitive.Trigger
          aria-label={`${props.label} model for ${props.accountEmail}`}
          aria-busy={isLoading}
          disabled={isLoading}
          className={`flex items-center justify-between gap-3 text-left disabled:cursor-progress disabled:opacity-70 ${triggerClass}`}
        >
          <ModelTriggerSummary shown={state.shown} isLoading={isLoading} />
        </SelectPrimitive.Trigger>
        <ModelSelectDropdown props={props} state={state} navigatingRef={navigatingRef} />
      </SelectPrimitive.Root>
      {props.confirm}
    </div>
  );
}
