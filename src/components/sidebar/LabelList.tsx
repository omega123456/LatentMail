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

function LabelListHeader({ creating, onToggle }: { creating: boolean; onToggle: () => void }) {
  return (
    <div className="flex items-center justify-between px-3">
      <h2 id="labels-heading" className="text-label-md text-secondary dark:text-dark-secondary">
        LABELS
      </h2>
      <button
        type="button"
        aria-label="Create label"
        aria-expanded={creating}
        onClick={onToggle}
        className="cursor-pointer rounded p-1 text-on-surface-variant hover:bg-surface-container-low focus-visible:outline-2 focus-visible:outline-primary dark:text-dark-on-surface-variant dark:hover:bg-dark-surface-container"
      >
        <Plus aria-hidden="true" size={ICON_SIZE.base} />
      </button>
    </div>
  );
}

function LabelCreatePanel({
  existingNames,
  onCancel,
  onCreate,
  onError,
}: {
  existingNames: string[];
  onCancel: () => void;
  onCreate: (input: { name: string; colorId: LabelColorId }) => Promise<unknown>;
  onError: (message: string | null) => void;
}) {
  return (
    <div className="mt-stack-gap-sm px-3">
      <LabelForm
        mode="create"
        existingNames={existingNames}
        onCancel={onCancel}
        onSubmit={async ({ name, colorId }) => {
          onCancel();
          try {
            await onCreate({ name, colorId });
          } catch (submitError) {
            onError(describeSubmitError(submitError, "Couldn't create the label. Try again."));
          }
        }}
      />
    </div>
  );
}

function LabelRowsSection({
  props,
  creating,
  rowMode,
  existingNames,
  onOpenMode,
  onCloseMode,
  onError,
}: {
  props: LabelListProps;
  creating: boolean;
  rowMode: RowMode;
  existingNames: string[];
  onOpenMode: (mode: RowMode) => void;
  onCloseMode: () => void;
  onError: (message: string | null) => void;
}) {
  if (props.labels.length === 0 && !creating) {
    return (
      <p className="mt-stack-gap-sm px-3 text-body-sm text-on-surface-variant dark:text-dark-on-surface-variant">
        No labels yet
      </p>
    );
  }
  const mutations = {
    onRenameLabel: props.onRenameLabel,
    onRecolorLabel: props.onRecolorLabel,
    onDeleteLabel: props.onDeleteLabel,
  };
  return (
    <div className="mt-stack-gap-sm grid gap-1">
      {props.labels.map((label) => (
        <LabelRow
          key={label.id}
          label={label}
          active={props.activeMailboxId === label.id}
          showUnreadCounts={props.showUnreadCounts}
          modeKind={rowMode?.labelId === label.id ? rowMode.kind : null}
          existingNames={existingNames}
          mutations={mutations}
          onSelect={props.onSelect}
          onOpenMode={(kind) => onOpenMode({ kind: kind, labelId: label.id })}
          onCloseMode={onCloseMode}
          onError={onError}
        />
      ))}
    </div>
  );
}

export function LabelList(props: LabelListProps) {
  const [creating, setCreating] = useState(false);
  const [rowMode, setRowMode] = useState<RowMode>(null);
  const [error, setError] = useState<string | null>(null);
  const existingNames = props.labels.map((label) => label.name);

  return (
    <section className="mt-stack-gap-md" aria-labelledby="labels-heading">
      <LabelListHeader
        creating={creating}
        onToggle={() => {
          setCreating((wasCreating) => !wasCreating);
          setError(null);
        }}
      />
      {creating && (
        <LabelCreatePanel
          existingNames={existingNames}
          onCancel={() => {
            setCreating(false);
            setError(null);
          }}
          onCreate={props.onCreateLabel}
          onError={setError}
        />
      )}
      <LabelRowsSection
        props={props}
        creating={creating}
        rowMode={rowMode}
        existingNames={existingNames}
        onOpenMode={setRowMode}
        onCloseMode={() => setRowMode(null)}
        onError={setError}
      />
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
