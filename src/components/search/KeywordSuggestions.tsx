import { useEffect } from 'react';
import type { SearchSuggestion } from './searchKeywords';

export function KeywordSuggestions({
  id,
  items,
  activeIndex,
  onSelect,
}: {
  id: string;
  items: SearchSuggestion[];
  activeIndex: number;
  onSelect: (item: SearchSuggestion) => void;
}) {
  useEffect(() => {
    if (activeIndex < 0) return;
    document.getElementById(`${id}-option-${activeIndex}`)?.scrollIntoView({ block: 'nearest' });
  }, [id, activeIndex]);

  return (
    <ul id={id} role="listbox" aria-label="Search suggestions" className="flex flex-col">
      {items.map((item, index) => (
        <li key={item.insert} role="presentation">
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
            <span className="text-body-sm text-on-surface dark:text-dark-on-surface">
              {item.primary}
            </span>
            {item.secondary ? (
              <span className="text-label-md text-outline dark:text-dark-outline">
                {item.secondary}
              </span>
            ) : null}
          </button>
        </li>
      ))}
    </ul>
  );
}
