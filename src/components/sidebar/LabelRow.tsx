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

async function runLabelMutation(
  task: () => Promise<unknown>,
  fallback: string,
  callbacks: { onClose: () => void; onError: (message: string | null) => void },
) {
  callbacks.onClose();
  callbacks.onError(null);
  try {
    await task();
  } catch (submitError) {
    callbacks.onError(describeSubmitError(submitError, fallback));
  }
}

type LabelRowEditorProps = {
  modeKind: RowModeKind | null;
  label: Label;
  dotClass: string;
  existingNames: string[];
  mutations: LabelMutations;
  onClose: () => void;
  onStartRecoloring: () => void;
  onError: (message: string | null) => void;
};

function LabelRenameEditor(props: Omit<LabelRowEditorProps, 'modeKind'>) {
  const callbacks = { onClose: props.onClose, onError: props.onError };
  return (
    <div className="flex items-start gap-2">
      <LabelForm
        mode="rename"
        initialName={props.label.name}
        initialColorId={props.label.color}
        existingNames={props.existingNames}
        onCancel={() => {
          props.onClose();
          props.onError(null);
        }}
        onSubmit={({ name, colorId }) =>
          void runLabelMutation(
            async () => {
              if (name !== props.label.name) {
                await props.mutations.onRenameLabel({ id: props.label.id, name: name });
              }
              if (colorId !== props.label.color) {
                await props.mutations.onRecolorLabel({ id: props.label.id, colorId: colorId });
              }
            },
            "Couldn't save the label. Try again.",
            callbacks,
          )
        }
      />
      <button
        type="button"
        onClick={props.onStartRecoloring}
        className="shrink-0 cursor-pointer rounded p-1.5 text-on-surface-variant hover:bg-surface-container-low focus-visible:outline-2 focus-visible:outline-primary dark:text-dark-on-surface-variant dark:hover:bg-dark-surface-container"
        aria-label={`Change ${props.label.name}'s colour`}
      >
        <span aria-hidden="true" className={`size-chip-dot rounded-full ${props.dotClass}`} />
      </button>
    </div>
  );
}

function LabelRowEditor(props: LabelRowEditorProps) {
  const callbacks = { onClose: props.onClose, onError: props.onError };
  if (props.modeKind === 'renaming') return <LabelRenameEditor {...props} />;
  if (props.modeKind === 'recoloring') {
    return (
      <LabelColorPicker
        selectedId={props.label.color}
        onCancel={props.onClose}
        onApply={(colorId) =>
          void runLabelMutation(
            () => props.mutations.onRecolorLabel({ id: props.label.id, colorId: colorId }),
            "Couldn't update the colour. Try again.",
            callbacks,
          )
        }
      />
    );
  }
  if (props.modeKind === 'confirmingDelete') {
    return (
      <LabelRowConfirm
        labelName={props.label.name}
        onCancel={props.onClose}
        onConfirm={() =>
          void runLabelMutation(
            () => props.mutations.onDeleteLabel(props.label.id),
            "Couldn't delete the label. Try again.",
            callbacks,
          )
        }
      />
    );
  }
  return null;
}

const rowActionButtonClass =
  'cursor-pointer rounded p-1 text-on-surface-variant opacity-0 hover:bg-surface-container-low focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-primary group-focus-within:opacity-100 group-hover:opacity-100 dark:text-dark-on-surface-variant dark:hover:bg-dark-surface-container';

function LabelRowActions({
  labelName,
  onEdit,
  onDelete,
}: {
  labelName: string;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <>
      <button
        type="button"
        aria-label={`Edit ${labelName}`}
        onClick={onEdit}
        className={rowActionButtonClass}
      >
        <Pencil aria-hidden="true" size={ICON_SIZE.sm} />
      </button>
      <button
        type="button"
        aria-label={`Delete ${labelName}`}
        onClick={onDelete}
        className={rowActionButtonClass}
      >
        <X aria-hidden="true" size={ICON_SIZE.sm} />
      </button>
    </>
  );
}

type LabelRowProps = {
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
};

export function LabelRow(props: LabelRowProps) {
  const swatch = LABEL_COLOR_BY_ID[props.label.color];
  const openMode = (kind: RowModeKind) => {
    props.onError(null);
    props.onOpenMode(kind);
  };
  return (
    <div className="group flex flex-col gap-1">
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-current={props.active ? 'page' : undefined}
          onClick={() => props.onSelect(props.label.id)}
          className={`${navRow(props.active)} flex-1`}
        >
          {props.active && <span aria-hidden="true" className={navRail} />}
          <span
            aria-hidden="true"
            className={`mx-1.5 size-chip-dot rounded-full ${swatch.dotClass}`}
          />
          <span className="flex-1 text-left">{props.label.name}</span>
          {props.showUnreadCounts && props.label.unreadCount > 0 && (
            <span className={navCount}>{props.label.unreadCount}</span>
          )}
        </button>
        <LabelRowActions
          labelName={props.label.name}
          onEdit={() => openMode('renaming')}
          onDelete={() => openMode('confirmingDelete')}
        />
      </div>
      <LabelRowEditor
        modeKind={props.modeKind}
        label={props.label}
        dotClass={swatch.dotClass}
        existingNames={props.existingNames}
        mutations={props.mutations}
        onClose={props.onCloseMode}
        onStartRecoloring={() => props.onOpenMode('recoloring')}
        onError={props.onError}
      />
    </div>
  );
}
