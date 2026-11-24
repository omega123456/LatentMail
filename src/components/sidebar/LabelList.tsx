import { useState } from 'react';
import { Pencil, Plus, X } from 'lucide-react';
import { LABEL_COLOR_BY_ID, type LabelColorId } from '@/lib/labels/palette';
import { LabelColorPicker } from './LabelColorPicker';
import { LabelForm } from './LabelForm';
import { LabelRowConfirm } from './LabelRowConfirm';
import { navCount, navRail, navRow } from './rowStyles';
import { ICON_SIZE } from '@/components/shared/icon-size';

export type Label = {
  id: string;
  name: string;
  unreadCount: number;
  color: LabelColorId;
};

type RowModeKind = 'renaming' | 'recoloring' | 'confirmingDelete';
type RowMode = { kind: RowModeKind; labelId: string } | null;

function describeSubmitError(submitError: unknown, fallback: string): string {
  return submitError instanceof Error ? submitError.message : fallback;
}

function LabelRowEditor({
  modeKind,
  label,
  dotClass,
  existingNames,
  onClose,
  onStartRecoloring,
  onRenameLabel,
  onRecolorLabel,
  onDeleteLabel,
  onError,
}: {
  modeKind: RowModeKind | null;
  label: Label;
  dotClass: string;
  existingNames: string[];
  onClose: () => void;
  onStartRecoloring: () => void;
  onRenameLabel: (input: { id: string; name: string }) => Promise<unknown>;
  onRecolorLabel: (input: { id: string; colorId: LabelColorId }) => Promise<unknown>;
  onDeleteLabel: (id: string) => Promise<unknown>;
  onError: (message: string | null) => void;
}) {
  if (modeKind === 'renaming') {
    return (
      <div className="flex items-start gap-2">
        <LabelForm
          mode="rename"
          initialName={label.name}
          initialColorId={label.color}
          existingNames={existingNames}
          onCancel={() => {
            onClose();
            onError(null);
          }}
          onSubmit={async ({ name, colorId }) => {
            onClose();
            onError(null);
            try {
              if (name !== label.name) await onRenameLabel({ id: label.id, name: name });
              if (colorId !== label.color) await onRecolorLabel({ id: label.id, colorId: colorId });
            } catch (submitError) {
              onError(describeSubmitError(submitError, "Couldn't save the label. Try again."));
            }
          }}
        />
        <button
          type="button"
          onClick={onStartRecoloring}
          className="shrink-0 cursor-pointer rounded p-1.5 text-on-surface-variant hover:bg-surface-container-low focus-visible:outline-2 focus-visible:outline-primary dark:text-dark-on-surface-variant dark:hover:bg-dark-surface-container"
          aria-label={`Change ${label.name}'s colour`}
        >
          <span aria-hidden="true" className={`size-chip-dot rounded-full ${dotClass}`} />
        </button>
      </div>
    );
  }
  if (modeKind === 'recoloring') {
    return (
      <LabelColorPicker
        selectedId={label.color}
        onCancel={onClose}
        onApply={async (colorId) => {
          onClose();
          onError(null);
          try {
            await onRecolorLabel({ id: label.id, colorId: colorId });
          } catch (submitError) {
            onError(describeSubmitError(submitError, "Couldn't update the colour. Try again."));
          }
        }}
      />
    );
  }
  if (modeKind === 'confirmingDelete') {
    return (
      <LabelRowConfirm
        labelName={label.name}
        onCancel={onClose}
        onConfirm={async () => {
          onClose();
          onError(null);
          try {
            await onDeleteLabel(label.id);
          } catch (submitError) {
            onError(describeSubmitError(submitError, "Couldn't delete the label. Try again."));
          }
        }}
      />
    );
  }
  return null;
}

function LabelRow({
  label,
  active,
  showUnreadCounts,
  modeKind,
  existingNames,
  onSelect,
  onOpenMode,
  onCloseMode,
  onRenameLabel,
  onRecolorLabel,
  onDeleteLabel,
  onError,
}: {
  label: Label;
  active: boolean;
  showUnreadCounts: boolean;
  modeKind: RowModeKind | null;
  existingNames: string[];
  onSelect: (id: string) => void;
  onOpenMode: (kind: RowModeKind) => void;
  onCloseMode: () => void;
  onRenameLabel: (input: { id: string; name: string }) => Promise<unknown>;
  onRecolorLabel: (input: { id: string; colorId: LabelColorId }) => Promise<unknown>;
  onDeleteLabel: (id: string) => Promise<unknown>;
  onError: (message: string | null) => void;
}) {
  const swatch = LABEL_COLOR_BY_ID[label.color];
  return (
    <div className="group flex flex-col gap-1">
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-current={active ? 'page' : undefined}
          onClick={() => onSelect(label.id)}
          className={`${navRow(active)} flex-1`}
        >
          {active && <span aria-hidden="true" className={navRail} />}
          <span
            aria-hidden="true"
            className={`mx-1.5 size-chip-dot rounded-full ${swatch.dotClass}`}
          />
          <span className="flex-1 text-left">{label.name}</span>
          {showUnreadCounts && label.unreadCount > 0 && (
            <span className={navCount}>{label.unreadCount}</span>
          )}
        </button>
        <button
          type="button"
          aria-label={`Edit ${label.name}`}
          onClick={() => {
            onError(null);
            onOpenMode('renaming');
          }}
          className="cursor-pointer rounded p-1 text-on-surface-variant opacity-0 hover:bg-surface-container-low focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-primary group-focus-within:opacity-100 group-hover:opacity-100 dark:text-dark-on-surface-variant dark:hover:bg-dark-surface-container"
        >
          <Pencil aria-hidden="true" size={ICON_SIZE.sm} />
        </button>
        <button
          type="button"
          aria-label={`Delete ${label.name}`}
          onClick={() => {
            onError(null);
            onOpenMode('confirmingDelete');
          }}
          className="cursor-pointer rounded p-1 text-on-surface-variant opacity-0 hover:bg-surface-container-low focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-primary group-focus-within:opacity-100 group-hover:opacity-100 dark:text-dark-on-surface-variant dark:hover:bg-dark-surface-container"
        >
          <X aria-hidden="true" size={ICON_SIZE.sm} />
        </button>
      </div>
      <LabelRowEditor
        modeKind={modeKind}
        label={label}
        dotClass={swatch.dotClass}
        existingNames={existingNames}
        onClose={onCloseMode}
        onStartRecoloring={() => onOpenMode('recoloring')}
        onRenameLabel={onRenameLabel}
        onRecolorLabel={onRecolorLabel}
        onDeleteLabel={onDeleteLabel}
        onError={onError}
      />
    </div>
  );
}

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
              onSelect={onSelect}
              onOpenMode={(kind) => setRowMode({ kind: kind, labelId: label.id })}
              onCloseMode={closeRow}
              onRenameLabel={onRenameLabel}
              onRecolorLabel={onRecolorLabel}
              onDeleteLabel={onDeleteLabel}
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
