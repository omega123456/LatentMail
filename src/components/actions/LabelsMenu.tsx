import { useMemo, useRef, useState } from 'react';
import { Check, Minus, Plus } from 'lucide-react';
import { TextInput } from '@/components/shared/TextInput';
import { LABEL_COLOR_BY_ID, type LabelColorId } from '@/lib/labels/palette';
import { ICON_SIZE } from '@/components/shared/icon-size';
import { wrapIndex } from '@/lib/collections';
import { dispatchKey } from '@/lib/keyboard/dispatch';

export type LabelMembership = 'checked' | 'unchecked' | 'indeterminate';

export type LabelMenuEntry = {
  id: string;
  name: string;
  color: LabelColorId;
  membership: LabelMembership;
};

const FILTER_THRESHOLD = 10;

type BaseProps = {
  labels: LabelMenuEntry[];
  onCreateLabel?: () => void;
};

export type StagedLabelsMenuProps = BaseProps & {
  variant: 'staged';
  onApply: (changes: { add: string[]; remove: string[] }) => void;
  onCancel: () => void;
};

export type ImmediateLabelsMenuProps = BaseProps & {
  variant: 'immediate';
  onToggle: (labelId: string, nextChecked: boolean) => void;
};

export type LabelsMenuProps = StagedLabelsMenuProps | ImmediateLabelsMenuProps;

function nextBooleanFor(membership: LabelMembership): boolean {
  return membership !== 'checked';
}

function computeLabelDiff(labels: LabelMenuEntry[], overrides: Record<string, boolean>) {
  const add: string[] = [];
  const remove: string[] = [];
  for (const [id, checked] of Object.entries(overrides)) {
    const original = labels.find((label) => label.id === id)?.membership;
    if (checked && original !== 'checked') add.push(id);
    if (!checked && original === 'checked') remove.push(id);
  }
  return { add, remove };
}

function resolveRenderedMembership(
  props: LabelsMenuProps,
  label: LabelMenuEntry,
  overrides: Record<string, boolean>,
): LabelMembership {
  if (props.variant !== 'staged') return label.membership;
  if (!(label.id in overrides)) return label.membership;
  return overrides[label.id] ? 'checked' : 'unchecked';
}

function EmptyLabelsNotice({ onCreateLabel }: { onCreateLabel?: () => void }) {
  return (
    <div className="flex flex-col items-start gap-2 px-2 py-2">
      <p className="text-body-sm text-on-surface-variant dark:text-dark-on-surface-variant">
        No labels yet
      </p>
      {onCreateLabel && (
        <button
          type="button"
          onClick={onCreateLabel}
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-label-md text-primary hover:bg-surface-container-low focus-visible:outline-2 focus-visible:outline-primary dark:text-dark-primary dark:hover:bg-dark-surface-container cursor-pointer"
        >
          <Plus aria-hidden="true" size={ICON_SIZE.sm} />
          Create label
        </button>
      )}
    </div>
  );
}

function LabelMenuRow({
  label,
  membership,
  assignRef,
  onToggle,
  onKeyDown,
}: {
  label: LabelMenuEntry;
  membership: LabelMembership;
  assignRef: (node: HTMLDivElement | null) => void;
  onToggle: () => void;
  onKeyDown: (event: React.KeyboardEvent) => void;
}) {
  const swatch = LABEL_COLOR_BY_ID[label.color];
  const ariaChecked = membership === 'indeterminate' ? 'mixed' : membership === 'checked';
  const checkboxTone =
    membership === 'unchecked'
      ? 'border-outline-variant dark:border-dark-outline-variant'
      : 'border-primary bg-primary text-on-primary dark:border-dark-primary dark:bg-dark-primary dark:text-dark-on-primary';

  return (
    <div
      ref={assignRef}
      role="menuitemcheckbox"
      aria-checked={ariaChecked}
      tabIndex={0}
      onClick={onToggle}
      onKeyDown={onKeyDown}
      className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-body-sm text-on-surface hover:bg-surface-container-low focus-visible:outline-2 focus-visible:outline-primary dark:text-dark-on-surface dark:hover:bg-dark-surface-container"
    >
      <span
        aria-hidden="true"
        className={`flex size-4 shrink-0 items-center justify-center rounded-sm border ${checkboxTone}`}
      >
        {membership === 'checked' && <Check size={ICON_SIZE.xxs} />}
        {membership === 'indeterminate' && <Minus size={ICON_SIZE.xxs} />}
      </span>
      <span aria-hidden="true" className={`size-chip-dot rounded-full ${swatch.dotClass}`} />
      <span className="flex-1">{label.name}</span>
    </div>
  );
}

function handleLabelRowKeyDown(input: {
  event: React.KeyboardEvent;
  index: number;
  count: number;
  focusAt: (index: number) => void;
  onToggle: () => void;
}) {
  dispatchKey(input.event, {
    ArrowDown: () => input.focusAt(wrapIndex(input.index + 1, 0, input.count)),
    ArrowUp: () => input.focusAt(wrapIndex(input.index - 1, 0, input.count)),
    Enter: input.onToggle,
    ' ': input.onToggle,
  });
}

function LabelsListBody({
  labels,
  filtered,
  query,
  onCreateLabel,
  getMembership,
  onToggle,
}: {
  labels: LabelMenuEntry[];
  filtered: LabelMenuEntry[];
  query: string;
  onCreateLabel?: () => void;
  getMembership: (label: LabelMenuEntry) => LabelMembership;
  onToggle: (label: LabelMenuEntry) => void;
}) {
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);

  if (labels.length === 0) return <EmptyLabelsNotice onCreateLabel={onCreateLabel} />;
  if (filtered.length === 0) {
    return (
      <p className="px-2 py-2 text-body-sm text-on-surface-variant dark:text-dark-on-surface-variant">
        No labels match &lsquo;{query}&rsquo;
      </p>
    );
  }

  return (
    <div
      role="group"
      aria-label="Labels"
      className="flex max-h-64 flex-col gap-0.5 overflow-y-auto"
    >
      {filtered.map((label, index) => (
        <LabelMenuRow
          key={label.id}
          label={label}
          membership={getMembership(label)}
          assignRef={(node) => {
            itemRefs.current[index] = node;
          }}
          onToggle={() => onToggle(label)}
          onKeyDown={(event) =>
            handleLabelRowKeyDown({
              event: event,
              index: index,
              count: filtered.length,
              focusAt: (targetIndex) => itemRefs.current[targetIndex]?.focus(),
              onToggle: () => onToggle(label),
            })
          }
        />
      ))}
    </div>
  );
}

function StagedLabelsFooter({
  changeCount,
  onCancel,
  onApply,
}: {
  changeCount: number;
  onCancel: () => void;
  onApply: () => void;
}) {
  return (
    <div className="mt-1 flex items-center justify-between gap-2 border-t border-outline-variant/40 pt-2 dark:border-dark-outline-variant">
      <span className="text-label-sm text-on-surface-variant dark:text-dark-on-surface-variant">
        {changeCount} change{changeCount === 1 ? '' : 's'} staged
      </span>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded px-2 py-1 text-label-md text-secondary hover:bg-surface-container-low focus-visible:outline-2 focus-visible:outline-primary dark:text-dark-secondary dark:hover:bg-dark-surface-container cursor-pointer"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={changeCount === 0}
          onClick={onApply}
          className="cursor-pointer rounded bg-primary px-3 py-1 text-label-md text-on-primary focus-visible:outline-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50 dark:bg-dark-primary dark:text-dark-on-primary"
        >
          Apply
        </button>
      </div>
    </div>
  );
}

export function LabelsMenu(props: LabelsMenuProps) {
  const { labels, onCreateLabel } = props;
  const [query, setQuery] = useState('');
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});

  const filtered = useMemo(() => {
    if (!query.trim()) return labels;
    const needle = query.trim().toLowerCase();
    return labels.filter((label) => label.name.toLowerCase().includes(needle));
  }, [labels, query]);

  const diff = useMemo(() => computeLabelDiff(labels, overrides), [overrides, labels]);
  const changeCount = diff.add.length + diff.remove.length;
  const getMembership = (label: LabelMenuEntry) =>
    resolveRenderedMembership(props, label, overrides);

  const toggle = (label: LabelMenuEntry) => {
    if (props.variant !== 'staged') {
      props.onToggle(label.id, label.membership !== 'checked');
      return;
    }
    const currentMembership = getMembership(label);
    setOverrides((current) => ({ ...current, [label.id]: nextBooleanFor(currentMembership) }));
  };

  return (
    <div className="flex w-full flex-col gap-1" data-testid="labels-menu">
      <h3 className="px-2 pb-1 text-label-md text-secondary dark:text-dark-secondary">LABELS</h3>
      {labels.length > FILTER_THRESHOLD && (
        <TextInput
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter labels…"
          aria-label="Filter labels"
          className="mb-1"
        />
      )}
      <LabelsListBody
        labels={labels}
        filtered={filtered}
        query={query}
        onCreateLabel={onCreateLabel}
        getMembership={getMembership}
        onToggle={toggle}
      />
      {props.variant === 'staged' && labels.length > 0 && (
        <StagedLabelsFooter
          changeCount={changeCount}
          onCancel={props.onCancel}
          onApply={() => props.onApply(diff)}
        />
      )}
    </div>
  );
}
