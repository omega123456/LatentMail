import { useState } from 'react';
import { Pencil, Plus, X } from 'lucide-react';
import { LABEL_COLOR_BY_ID, type LabelColorId } from '@/lib/labels/palette';
import { LabelColorPicker } from './LabelColorPicker';
import { LabelForm } from './LabelForm';
import { LabelRowConfirm } from './LabelRowConfirm';
import { navCount, navRail, navRow } from './rowStyles';

export type Label = {
  id: string;
  name: string;
  unreadCount: number;
  color: LabelColorId;
};

type RowMode = { kind: 'renaming' | 'recoloring' | 'confirmingDelete'; labelId: string } | null;

export type LabelListProps = {
  activeMailboxId: string | null;
  labels: Label[];
  showUnreadCounts: boolean;
  onSelect: (id: string) => void;
  onCreateLabel?: (input: { name: string; colorId: LabelColorId }) => Promise<unknown>;
  onRenameLabel?: (input: { id: string; name: string }) => Promise<unknown>;
  onRecolorLabel?: (input: { id: string; colorId: LabelColorId }) => Promise<unknown>;
  onDeleteLabel?: (id: string) => Promise<unknown>;
};

const defaultAsync = async () => undefined;

export function LabelList({
  activeMailboxId,
  labels,
  showUnreadCounts,
  onSelect,
  onCreateLabel = defaultAsync,
  onRenameLabel = defaultAsync,
  onRecolorLabel = defaultAsync,
  onDeleteLabel = defaultAsync,
}: LabelListProps) {
  const [creating, setCreating] = useState(false);
  const [rowMode, setRowMode] = useState<RowMode>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

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
            setCreating((value) => !value);
            setError(null);
          }}
          className="cursor-pointer rounded p-1 text-on-surface-variant hover:bg-surface-container-low focus-visible:outline-2 focus-visible:outline-primary dark:text-dark-on-surface-variant dark:hover:bg-dark-surface-container"
        >
          <Plus aria-hidden="true" size={16} />
        </button>
      </div>
      {creating && (
        <div className="mt-stack-gap-sm px-3">
          <LabelForm
            mode="create"
            existingNames={existingNames}
            submitError={error}
            submitting={submitting}
            onCancel={() => {
              setCreating(false);
              setError(null);
            }}
            onSubmit={async ({ name, colorId }) => {
              setSubmitting(true);
              setError(null);
              try {
                await onCreateLabel({ name, colorId });
                setCreating(false);
              } catch (submitError) {
                setError(
                  submitError instanceof Error
                    ? submitError.message
                    : "Couldn't create the label. Try again.",
                );
              } finally {
                setSubmitting(false);
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
          {labels.map((label) => {
            const active = activeMailboxId === label.id;
            const swatch = LABEL_COLOR_BY_ID[label.color];
            const rowActive = rowMode?.labelId === label.id;
            return (
              <div key={label.id} className="group flex flex-col gap-1">
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
                      setError(null);
                      setRowMode({ kind: 'renaming', labelId: label.id });
                    }}
                    className="cursor-pointer rounded p-1 text-on-surface-variant opacity-0 hover:bg-surface-container-low focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-primary group-focus-within:opacity-100 group-hover:opacity-100 dark:text-dark-on-surface-variant dark:hover:bg-dark-surface-container"
                  >
                    <Pencil aria-hidden="true" size={14} />
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete ${label.name}`}
                    onClick={() => {
                      setError(null);
                      setRowMode({ kind: 'confirmingDelete', labelId: label.id });
                    }}
                    className="cursor-pointer rounded p-1 text-on-surface-variant opacity-0 hover:bg-surface-container-low focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-primary group-focus-within:opacity-100 group-hover:opacity-100 dark:text-dark-on-surface-variant dark:hover:bg-dark-surface-container"
                  >
                    <X aria-hidden="true" size={14} />
                  </button>
                </div>
                {rowActive && rowMode?.kind === 'renaming' && (
                  <div className="flex items-start gap-2">
                    <LabelForm
                      mode="rename"
                      initialName={label.name}
                      initialColorId={label.color}
                      existingNames={existingNames}
                      submitError={error}
                      submitting={submitting}
                      onCancel={() => {
                        closeRow();
                        setError(null);
                      }}
                      onSubmit={async ({ name, colorId }) => {
                        setSubmitting(true);
                        setError(null);
                        try {
                          if (name !== label.name) {
                            await onRenameLabel({ id: label.id, name });
                          }
                          if (colorId !== label.color) {
                            await onRecolorLabel({ id: label.id, colorId });
                          }
                          closeRow();
                        } catch (submitError) {
                          setError(
                            submitError instanceof Error
                              ? submitError.message
                              : "Couldn't save the label. Try again.",
                          );
                        } finally {
                          setSubmitting(false);
                        }
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => setRowMode({ kind: 'recoloring', labelId: label.id })}
                      className="shrink-0 cursor-pointer rounded p-1.5 text-on-surface-variant hover:bg-surface-container-low focus-visible:outline-2 focus-visible:outline-primary dark:text-dark-on-surface-variant dark:hover:bg-dark-surface-container"
                      aria-label={`Change ${label.name}'s colour`}
                    >
                      <span
                        aria-hidden="true"
                        className={`size-chip-dot rounded-full ${swatch.dotClass}`}
                      />
                    </button>
                  </div>
                )}
                {rowActive && rowMode?.kind === 'recoloring' && (
                  <LabelColorPicker
                    selectedId={label.color}
                    onCancel={closeRow}
                    onApply={async (colorId) => {
                      setSubmitting(true);
                      setError(null);
                      try {
                        await onRecolorLabel({ id: label.id, colorId });
                        closeRow();
                      } catch (submitError) {
                        setError(
                          submitError instanceof Error
                            ? submitError.message
                            : "Couldn't update the colour. Try again.",
                        );
                      } finally {
                        setSubmitting(false);
                      }
                    }}
                  />
                )}
                {rowActive && rowMode?.kind === 'confirmingDelete' && (
                  <LabelRowConfirm
                    labelName={label.name}
                    onCancel={closeRow}
                    onConfirm={async () => {
                      setSubmitting(true);
                      setError(null);
                      try {
                        await onDeleteLabel(label.id);
                        closeRow();
                      } catch (submitError) {
                        setError(
                          submitError instanceof Error
                            ? submitError.message
                            : "Couldn't delete the label. Try again.",
                        );
                      } finally {
                        setSubmitting(false);
                      }
                    }}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
      {error && !creating && rowMode?.kind !== 'renaming' && (
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
