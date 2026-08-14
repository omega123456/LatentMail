import type { ContactSuggestion } from '@/lib/types/ipc';

/** The anchored suggestion listbox for `RecipientField`'s custom combobox —
 * pseudo-focus (`activeIndex`) is owned by the caller so arrow-key handling
 * lives beside the input it drives. A named contact shows its display name
 * with the address beneath; an address-only contact shows the address as
 * its sole line. */
export function ContactSuggestions({
  id,
  items,
  activeIndex,
  onSelect,
}: {
  id: string;
  items: ContactSuggestion[];
  activeIndex: number;
  onSelect: (item: ContactSuggestion) => void;
}) {
  return (
    <ul id={id} role="listbox" aria-label="Contact suggestions" className="flex flex-col">
      {items.map((item, index) => (
        <li key={item.address} role="presentation">
          <button
            type="button"
            id={`${id}-option-${index}`}
            role="option"
            aria-selected={index === activeIndex}
            // A mousedown-time preventDefault beats the recipient input's
            // blur handler, which would otherwise commit the raw typed text
            // before this selection has a chance to land.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onSelect(item)}
            className={`flex w-full flex-col items-start gap-0.5 rounded px-2.5 py-1.5 text-left ${
              index === activeIndex
                ? 'bg-surface-container-high dark:bg-dark-surface-container-high'
                : 'hover:bg-surface-container-low dark:hover:bg-dark-surface-container-low'
            }`}
          >
            {item.displayName ? (
              <>
                <span className="text-body-sm text-on-surface dark:text-dark-on-surface">
                  {item.displayName}
                </span>
                <span className="text-label-md text-outline dark:text-dark-outline">
                  {item.address}
                </span>
              </>
            ) : (
              <span className="text-body-sm text-on-surface dark:text-dark-on-surface">
                {item.address}
              </span>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}
