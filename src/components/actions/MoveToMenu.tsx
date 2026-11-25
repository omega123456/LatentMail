import { useRef } from 'react';
import { Inbox, ShieldAlert, Trash2 } from 'lucide-react';
import { ICON_SIZE } from '@/components/shared/icon-size';
import { wrapIndex } from '@/lib/collections';
import { dispatchKey } from '@/lib/keyboard/dispatch';

export type MoveDestinationId = 'INBOX' | 'SPAM' | 'TRASH';

type DestinationSpec = { id: MoveDestinationId; name: string; Icon: typeof Inbox };

const DESTINATIONS: DestinationSpec[] = [
  { id: 'INBOX', name: 'Inbox', Icon: Inbox },
  { id: 'SPAM', name: 'Spam', Icon: ShieldAlert },
  { id: 'TRASH', name: 'Trash', Icon: Trash2 },
];

export type MoveToMenuProps = {
  currentSystemLabelIds: string[];
  onSelect: (destination: MoveDestinationId) => void;
};

function MoveToMenuItem({
  destination,
  inert,
  assignRef,
  onSelect,
  onKeyDown,
}: {
  destination: DestinationSpec;
  inert: boolean;
  assignRef: (node: HTMLButtonElement | null) => void;
  onSelect: () => void;
  onKeyDown: (event: React.KeyboardEvent) => void;
}) {
  const toneClass = inert
    ? 'cursor-default text-on-surface-variant/60 dark:text-dark-on-surface-variant/60'
    : 'cursor-pointer text-on-surface hover:bg-surface-container-low dark:text-dark-on-surface dark:hover:bg-dark-surface-container';

  return (
    <button
      ref={assignRef}
      type="button"
      role="menuitem"
      disabled={inert}
      aria-disabled={inert || undefined}
      tabIndex={inert ? -1 : 0}
      onClick={() => !inert && onSelect()}
      onKeyDown={onKeyDown}
      className={`flex items-center gap-2 rounded px-2 py-1.5 text-left text-body-sm focus-visible:outline-2 focus-visible:outline-primary ${toneClass}`}
    >
      <destination.Icon aria-hidden="true" size={ICON_SIZE.base} />
      <span className="flex-1">{destination.name}</span>
      {inert && <span className="text-label-sm">here</span>}
    </button>
  );
}

export function MoveToMenu({ currentSystemLabelIds, onSelect }: MoveToMenuProps) {
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const selectable = DESTINATIONS.filter(
    (destination) => !currentSystemLabelIds.includes(destination.id),
  );

  const focusSelectableAt = (index: number) => {
    if (selectable.length === 0) return;
    const target = selectable[wrapIndex(index, 0, selectable.length)];
    const domIndex = DESTINATIONS.findIndex((destination) => destination.id === target.id);
    itemRefs.current[domIndex]?.focus();
  };

  const handleKeyDown = (event: React.KeyboardEvent, id: MoveDestinationId) => {
    const selectableIndex = selectable.findIndex((destination) => destination.id === id);
    const selectCurrent = () => onSelect(id);
    dispatchKey(event, {
      ArrowDown: () => focusSelectableAt(selectableIndex + 1),
      ArrowUp: () => focusSelectableAt(selectableIndex - 1),
      Enter: selectCurrent,
      ' ': selectCurrent,
    });
  };

  return (
    <div
      role="menu"
      aria-label="Move to"
      data-testid="move-to-menu"
      className="flex flex-col gap-1"
    >
      {DESTINATIONS.map((destination, index) => (
        <MoveToMenuItem
          key={destination.id}
          destination={destination}
          inert={currentSystemLabelIds.includes(destination.id)}
          assignRef={(node) => {
            itemRefs.current[index] = node;
          }}
          onSelect={() => onSelect(destination.id)}
          onKeyDown={(event) => handleKeyDown(event, destination.id)}
        />
      ))}
    </div>
  );
}
