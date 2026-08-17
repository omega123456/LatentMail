import type { ContactSuggestion } from '@/lib/types/ipc';

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
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onSelect(item)}
            className={`flex w-full cursor-pointer flex-col items-start gap-0.5 rounded px-2.5 py-1.5 text-left ${
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
