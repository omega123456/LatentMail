import { useMemo, useRef, useState } from 'react';
import { Check, Minus, Plus } from 'lucide-react';
import { LABEL_COLOR_BY_ID, type LabelColorId } from '@/lib/labels/palette';

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
  /** Opens label creation from the zero-labels empty state. Its absence
   * simply omits the affordance rather than disabling it. */
  onCreateLabel?: () => void;
};

export type StagedLabelsMenuProps = BaseProps & {
  variant: 'staged';
  onApply: (changes: { add: string[]; remove: string[] }) => void;
  onCancel: () => void;
};

export type ImmediateLabelsMenuProps = BaseProps & {
  variant: 'immediate';
  /** Commits the toggle immediately — no Apply/Cancel footer. Membership is
   * always `'checked'`/`'unchecked'` in this variant (row context menu rows
   * are binary, never tri-state, per the wireframe). */
  onToggle: (labelId: string, nextChecked: boolean) => void;
};

export type LabelsMenuProps = StagedLabelsMenuProps | ImmediateLabelsMenuProps;

/** Indeterminate/unchecked both move toward "checked" on first touch; a
 * second touch moves to unchecked. There's no way back to indeterminate
 * once touched — matching Gmail's own staged-labels behaviour. */
function nextBooleanFor(membership: LabelMembership): boolean {
  return membership !== 'checked';
}

export function LabelsMenu(props: LabelsMenuProps) {
  const { labels, onCreateLabel } = props;
  const [query, setQuery] = useState('');
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);

  const filtered = useMemo(() => {
    if (!query.trim()) return labels;
    const needle = query.trim().toLowerCase();
    return labels.filter((label) => label.name.toLowerCase().includes(needle));
  }, [labels, query]);

  const diff = useMemo(() => {
    const add: string[] = [];
    const remove: string[] = [];
    for (const [id, checked] of Object.entries(overrides)) {
      const original = labels.find((label) => label.id === id)?.membership;
      if (checked && original !== 'checked') add.push(id);
      if (!checked && original === 'checked') remove.push(id);
    }
    return { add, remove };
  }, [overrides, labels]);
  const changeCount = diff.add.length + diff.remove.length;

  const focusAt = (index: number) => {
    if (filtered.length === 0) return;
    const wrapped = ((index % filtered.length) + filtered.length) % filtered.length;
    itemRefs.current[wrapped]?.focus();
  };

  const toggle = (label: LabelMenuEntry) => {
    if (props.variant === 'staged') {
      const currentMembership: LabelMembership = label.id in overrides
        ? overrides[label.id]
          ? 'checked'
          : 'unchecked'
        : label.membership;
      setOverrides((current) => ({ ...current, [label.id]: nextBooleanFor(currentMembership) }));
    } else {
      props.onToggle(label.id, label.membership !== 'checked');
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent, index: number, label: LabelMenuEntry) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusAt(index + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusAt(index - 1);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      toggle(label);
    }
  };

  const renderMembership = (label: LabelMenuEntry): LabelMembership => {
    if (props.variant !== 'staged') return label.membership;
    if (!(label.id in overrides)) return label.membership;
    return overrides[label.id] ? 'checked' : 'unchecked';
  };

  return (
    <div className="flex w-full flex-col gap-1" data-testid="labels-menu">
      <h3 className="px-2 pb-1 text-label-md text-secondary dark:text-dark-secondary">LABELS</h3>
      {labels.length > FILTER_THRESHOLD && (
        <input
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter labels…"
          aria-label="Filter labels"
          className="mb-1 rounded border border-outline-variant/50 bg-surface-container-lowest px-2 py-1 text-body-sm text-on-surface focus-visible:outline-2 focus-visible:outline-primary dark:border-dark-outline-variant dark:bg-dark-surface-container-lowest dark:text-dark-on-surface"
        />
      )}
      {labels.length === 0 ? (
        <div className="flex flex-col items-start gap-2 px-2 py-2">
          <p className="text-body-sm text-on-surface-variant dark:text-dark-on-surface-variant">
            No labels yet
          </p>
          {onCreateLabel && (
            <button
              type="button"
              onClick={onCreateLabel}
              className="inline-flex items-center gap-1 rounded px-2 py-1 text-label-md text-primary hover:bg-surface-container-low focus-visible:outline-2 focus-visible:outline-primary dark:text-dark-primary dark:hover:bg-dark-surface-container"
            >
              <Plus aria-hidden="true" size={14} />
              Create label
            </button>
          )}
        </div>
      ) : filtered.length === 0 ? (
        <p className="px-2 py-2 text-body-sm text-on-surface-variant dark:text-dark-on-surface-variant">
          No labels match &lsquo;{query}&rsquo;
        </p>
      ) : (
        <div role="group" aria-label="Labels" className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
          {filtered.map((label, index) => {
            const membership = renderMembership(label);
            const swatch = LABEL_COLOR_BY_ID[label.color];
            return (
              <div
                key={label.id}
                ref={(node) => {
                  itemRefs.current[index] = node;
                }}
                role="menuitemcheckbox"
                aria-checked={membership === 'indeterminate' ? 'mixed' : membership === 'checked'}
                tabIndex={0}
                onClick={() => toggle(label)}
                onKeyDown={(event) => handleKeyDown(event, index, label)}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-body-sm text-on-surface hover:bg-surface-container-low focus-visible:outline-2 focus-visible:outline-primary dark:text-dark-on-surface dark:hover:bg-dark-surface-container"
              >
                <span
                  aria-hidden="true"
                  className={`flex size-4 shrink-0 items-center justify-center rounded-sm border ${
                    membership === 'unchecked'
                      ? 'border-outline-variant dark:border-dark-outline-variant'
                      : 'border-primary bg-primary text-on-primary dark:border-dark-primary dark:bg-dark-primary dark:text-dark-on-primary'
                  }`}
                >
                  {membership === 'checked' && <Check size={12} />}
                  {membership === 'indeterminate' && <Minus size={12} />}
                </span>
                <span aria-hidden="true" className={`size-chip-dot rounded-full ${swatch.dotClass}`} />
                <span className="flex-1">{label.name}</span>
              </div>
            );
          })}
        </div>
      )}
      {props.variant === 'staged' && labels.length > 0 && (
        <div className="mt-1 flex items-center justify-between gap-2 border-t border-outline-variant/40 pt-2 dark:border-dark-outline-variant">
          <span className="text-label-sm text-on-surface-variant dark:text-dark-on-surface-variant">
            {changeCount} change{changeCount === 1 ? '' : 's'} staged
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={props.onCancel}
              className="rounded px-2 py-1 text-label-md text-secondary hover:bg-surface-container-low focus-visible:outline-2 focus-visible:outline-primary dark:text-dark-secondary dark:hover:bg-dark-surface-container"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={changeCount === 0}
              onClick={() => props.onApply(diff)}
              className="rounded bg-primary px-3 py-1 text-label-md text-on-primary focus-visible:outline-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50 dark:bg-dark-primary dark:text-dark-on-primary"
            >
              Apply
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
