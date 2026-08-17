import { useRef } from 'react';
import { Inbox, ShieldAlert, Trash2 } from 'lucide-react';

export type MoveDestinationId = 'INBOX' | 'SPAM' | 'TRASH';

const DESTINATIONS: { id: MoveDestinationId; name: string; Icon: typeof Inbox }[] = [
  { id: 'INBOX', name: 'Inbox', Icon: Inbox },
  { id: 'SPAM', name: 'Spam', Icon: ShieldAlert },
  { id: 'TRASH', name: 'Trash', Icon: Trash2 },
];

export type MoveToMenuProps = {
  currentSystemLabelIds: string[];
  onSelect: (destination: MoveDestinationId) => void;
};

export function MoveToMenu({ currentSystemLabelIds, onSelect }: MoveToMenuProps) {
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const selectable = DESTINATIONS.filter(
    (destination) => !currentSystemLabelIds.includes(destination.id),
  );

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
    <div
      role="menu"
      aria-label="Move to"
      data-testid="move-to-menu"
      className="flex flex-col gap-1"
    >
      {DESTINATIONS.map((destination, index) => {
        const inert = currentSystemLabelIds.includes(destination.id);
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
                : 'cursor-pointer text-on-surface hover:bg-surface-container-low dark:text-dark-on-surface dark:hover:bg-dark-surface-container'
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
