import { useState } from 'react';
import { Plus } from 'lucide-react';
import type { LabelColorId } from '@/lib/labels/palette';
import { LabelForm } from './LabelForm';
import { describeSubmitError, LabelRow, type Label, type RowModeKind } from './LabelRow';
import { ICON_SIZE } from '@/components/shared/icon-size';

export type { Label };

type RowMode = { kind: RowModeKind; labelId: string } | null;

export type LabelListProps = {
  activeMailboxId: string | null;
  labels: Label[];
  showUnreadCounts: boolean;
  onSelect: (id: string) => void;
  onCreateLabel: (input: { name: string; colorId: LabelColorId }) => Promise<unknown>;
  onRenameLabel: (input: { id: string; name: string }) => Promise<unknown>;
  onRecolorLabel: (input: { id: string; colorId: LabelColorId }) => Promise<unknown>;
  onDeleteLabel: (id: string) => Promise<unknown>;
};

export function LabelList({
  activeMailboxId,
  labels,
  showUnreadCounts,
  onSelect,
  onCreateLabel,
  onRenameLabel,
  onRecolorLabel,
  onDeleteLabel,
}: LabelListProps) {
  const [creating, setCreating] = useState(false);
  const [rowMode, setRowMode] = useState<RowMode>(null);
  const [error, setError] = useState<string | null>(null);

  const existingNames = labels.map((label) => label.name);
  const mutations = { onRenameLabel, onRecolorLabel, onDeleteLabel };
  const closeRow = () => setRowMode(null);

  return (
    <section className="mt-stack-gap-md" aria-labelledby="labels-heading">
      <div className="flex items-center justify-between px-3">
        <h2 id="labels-heading" className="text-label-md text-secondary dark:text-dark-secondary">
          LABELS
        </h2>
        <button
          type="button"
          aria-label="Create label"
          aria-expanded={creating}
          onClick={() => {
            setCreating((wasCreating) => !wasCreating);
            setError(null);
          }}
          className="cursor-pointer rounded p-1 text-on-surface-variant hover:bg-surface-container-low focus-visible:outline-2 focus-visible:outline-primary dark:text-dark-on-surface-variant dark:hover:bg-dark-surface-container"
        >
          <Plus aria-hidden="true" size={ICON_SIZE.base} />
        </button>
      </div>
      {creating && (
        <div className="mt-stack-gap-sm px-3">
          <LabelForm
            mode="create"
            existingNames={existingNames}
            onCancel={() => {
              setCreating(false);
              setError(null);
            }}
            onSubmit={async ({ name, colorId }) => {
              setCreating(false);
              setError(null);
              try {
                await onCreateLabel({ name, colorId });
              } catch (submitError) {
                setError(describeSubmitError(submitError, "Couldn't create the label. Try again."));
              }
            }}
          />
        </div>
      )}
      {labels.length === 0 && !creating ? (
        <p className="mt-stack-gap-sm px-3 text-body-sm text-on-surface-variant dark:text-dark-on-surface-variant">
          No labels yet
        </p>
      ) : (
        <div className="mt-stack-gap-sm grid gap-1">
          {labels.map((label) => (
            <LabelRow
              key={label.id}
              label={label}
              active={activeMailboxId === label.id}
              showUnreadCounts={showUnreadCounts}
              modeKind={rowMode?.labelId === label.id ? rowMode.kind : null}
              existingNames={existingNames}
              mutations={mutations}
              onSelect={onSelect}
              onOpenMode={(kind) => setRowMode({ kind: kind, labelId: label.id })}
              onCloseMode={closeRow}
              onError={setError}
            />
          ))}
        </div>
      )}
      {error && (
        <p
          role="alert"
          className="mt-stack-gap-sm px-3 text-label-sm text-error dark:text-dark-error"
        >
          {error}
        </p>
      )}
    </section>
  );
}
