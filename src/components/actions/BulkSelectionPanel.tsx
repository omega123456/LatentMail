import { ActionRibbon, type ActionRibbonProps } from './ActionRibbon';

export type BulkSelectionPanelProps = Omit<ActionRibbonProps, 'currentLabelName'> & {
  /** Selected conversation count — always ≥1 when this panel renders. */
  count: number;
};

/** Replaces the reading pane while a multi-selection is active (FR
 * "Multi-selection and bulk actions"): states the count, reminds the user
 * that Escape clears it, and reuses `ActionRibbon` verbatim for the inline
 * bulk actions rather than duplicating its hide/overflow rules. */
export function BulkSelectionPanel({ count, ...ribbonProps }: BulkSelectionPanelProps) {
  return (
    <section
      aria-label="Bulk selection"
      data-testid="bulk-selection-panel"
      className="flex h-full flex-col items-center justify-center gap-stack-gap-md bg-surface-bright p-container-padding dark:bg-dark-surface-container-high"
    >
      <div className="flex flex-col items-center gap-1 text-center">
        <p className="text-title-lg text-on-surface dark:text-dark-on-surface">
          {count} conversation{count === 1 ? '' : 's'} selected
        </p>
        <p className="text-body-sm text-secondary dark:text-dark-secondary">
          Escape clears the selection
        </p>
      </div>
      <div className="rounded-md border border-outline-variant/40 bg-surface-container-lowest p-2 shadow-sm dark:border-dark-outline-variant dark:bg-dark-surface-container-lowest">
        <ActionRibbon {...ribbonProps} />
      </div>
    </section>
  );
}
