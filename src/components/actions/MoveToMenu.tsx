import { useRef } from 'react';
import { Inbox, ShieldAlert, Trash2 } from 'lucide-react';

/** The only mutable system mailboxes triage can move a conversation into —
 * `SENT`/`DRAFT` are read-only and never offered (FR "Move to"). */
export type MoveDestinationId = 'INBOX' | 'SPAM' | 'TRASH';

export function moveSource(mailboxId: string, currentLabelName?: string): string[] {
  return currentLabelName || DESTINATIONS.some((destination) => destination.id === mailboxId)
    ? [mailboxId]
    : [];
}

const DESTINATIONS: { id: MoveDestinationId; name: string; Icon: typeof Inbox }[] = [
  { id: 'INBOX', name: 'Inbox', Icon: Inbox },
  { id: 'SPAM', name: 'Spam', Icon: ShieldAlert },
  { id: 'TRASH', name: 'Trash', Icon: Trash2 },
];

export type MoveToMenuProps = {
  /** The mailbox currently being browsed — if it matches a destination, that
   * destination renders inert ("here"). */
  currentMailboxId: string;
  /** Set when `currentMailboxId` is itself a user label rather than one of
   * the three system destinations — rendered as an inert "removed source"
   * row, since moving elsewhere also removes this label (FR). */
  currentLabelName?: string;
  onSelect: (destination: MoveDestinationId) => void;
};

/** Content-only: the caller supplies the menu shell (a `DropdownMenu.Content`
 * from the ribbon, or a `ContextMenu.SubContent` from `RowContextMenu`) so
 * this same data/logic isn't duplicated across both. Arrow keys wrap between
 * the *selectable* destinations only; Enter/Space select; Escape is left to
 * the enclosing radix menu, which already closes on it without acting. */
export function MoveToMenu({ currentMailboxId, currentLabelName, onSelect }: MoveToMenuProps) {
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const selectable = DESTINATIONS.filter((destination) => destination.id !== currentMailboxId);

  const focusSelectableAt = (index: number) => {
    const wrapped = ((index % selectable.length) + selectable.length) % selectable.length;
    const target = selectable[wrapped];
    const domIndex = DESTINATIONS.findIndex((destination) => destination.id === target.id);
    itemRefs.current[domIndex]?.focus();
  };

  const handleKeyDown = (event: React.KeyboardEvent, id: MoveDestinationId) => {
    const selectableIndex = selectable.findIndex((destination) => destination.id === id);
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusSelectableAt(selectableIndex + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusSelectableAt(selectableIndex - 1);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect(id);
    }
  };

  return (
    <div role="menu" aria-label="Move to" data-testid="move-to-menu" className="flex flex-col gap-1">
      {currentLabelName && (
        <div
          role="presentation"
          className="px-2 py-1 text-label-sm text-on-surface-variant dark:text-dark-on-surface-variant"
        >
          Removing from {currentLabelName}
        </div>
      )}
      {DESTINATIONS.map((destination, index) => {
        const inert = destination.id === currentMailboxId;
        return (
          <button
            key={destination.id}
            ref={(node) => {
              itemRefs.current[index] = node;
            }}
            type="button"
            role="menuitem"
            disabled={inert}
            aria-disabled={inert || undefined}
            tabIndex={inert ? -1 : 0}
            onClick={() => !inert && onSelect(destination.id)}
            onKeyDown={(event) => handleKeyDown(event, destination.id)}
            className={`flex items-center gap-2 rounded px-2 py-1.5 text-left text-body-sm focus-visible:outline-2 focus-visible:outline-primary ${
              inert
                ? 'cursor-default text-on-surface-variant/60 dark:text-dark-on-surface-variant/60'
                : 'text-on-surface hover:bg-surface-container-low dark:text-dark-on-surface dark:hover:bg-dark-surface-container'
            }`}
          >
            <destination.Icon aria-hidden="true" size={16} />
            <span className="flex-1">{destination.name}</span>
            {inert && <span className="text-label-sm">here</span>}
          </button>
        );
      })}
    </div>
  );
}
