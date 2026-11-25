import { Pencil, X } from 'lucide-react';
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

export type RowModeKind = 'renaming' | 'recoloring' | 'confirmingDelete';

export type LabelMutations = {
  onRenameLabel: (input: { id: string; name: string }) => Promise<unknown>;
  onRecolorLabel: (input: { id: string; colorId: LabelColorId }) => Promise<unknown>;
  onDeleteLabel: (id: string) => Promise<unknown>;
};

export function describeSubmitError(submitError: unknown, fallback: string): string {
  return submitError instanceof Error ? submitError.message : fallback;
}

function LabelRowEditor({
  modeKind,
  label,
  dotClass,
  existingNames,
  mutations,
  onClose,
  onStartRecoloring,
  onError,
}: {
  modeKind: RowModeKind | null;
  label: Label;
  dotClass: string;
  existingNames: string[];
  mutations: LabelMutations;
  onClose: () => void;
  onStartRecoloring: () => void;
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
              if (name !== label.name) await mutations.onRenameLabel({ id: label.id, name: name });
              if (colorId !== label.color) {
                await mutations.onRecolorLabel({ id: label.id, colorId: colorId });
              }
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
            await mutations.onRecolorLabel({ id: label.id, colorId: colorId });
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
            await mutations.onDeleteLabel(label.id);
          } catch (submitError) {
            onError(describeSubmitError(submitError, "Couldn't delete the label. Try again."));
          }
        }}
      />
    );
  }
  return null;
}

export function LabelRow({
  label,
  active,
  showUnreadCounts,
  modeKind,
  existingNames,
  mutations,
  onSelect,
  onOpenMode,
  onCloseMode,
  onError,
}: {
  label: Label;
  active: boolean;
  showUnreadCounts: boolean;
  modeKind: RowModeKind | null;
  existingNames: string[];
  mutations: LabelMutations;
  onSelect: (id: string) => void;
  onOpenMode: (kind: RowModeKind) => void;
  onCloseMode: () => void;
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
        mutations={mutations}
        onClose={onCloseMode}
        onStartRecoloring={() => onOpenMode('recoloring')}
        onError={onError}
      />
    </div>
  );
}
