export type Label = {
  id: string;
  name: string;
  unreadCount: number;
  color: 'blue' | 'green' | 'orange';
};

const dotColors = { blue: 'bg-primary', green: 'bg-secondary', orange: 'bg-star' };

export function LabelList({
  activeMailboxId,
  labels,
  showUnreadCounts,
  onSelect,
}: {
  activeMailboxId: string | null;
  labels: Label[];
  showUnreadCounts: boolean;
  onSelect: (id: string) => void;
}) {
  if (labels.length === 0) return null;
  return (
    <section className="mt-stack-gap-md" aria-labelledby="labels-heading">
      <h2
        id="labels-heading"
        className="px-3 text-label-md text-secondary dark:text-dark-secondary"
      >
        LABELS
      </h2>
      <div className="mt-stack-gap-sm grid gap-1">
        {labels.map((label) => {
          const active = activeMailboxId === label.id;
          return (
            <button
              key={label.id}
              type="button"
              aria-current={active ? 'page' : undefined}
              onClick={() => onSelect(label.id)}
              className={`flex items-center gap-3 rounded px-3 py-2 text-body-sm focus-visible:outline-2 focus-visible:outline-primary ${active ? 'bg-primary-container font-bold text-on-primary-container dark:bg-dark-primary-container dark:text-dark-on-primary-container' : 'text-on-surface-variant hover:bg-surface-container-low dark:text-dark-on-surface-variant dark:hover:bg-dark-surface-container'} `}
            >
              <span
                aria-hidden="true"
                className={`size-chip-dot rounded-full ${dotColors[label.color]}`}
              />
              <span className="flex-1 text-left">{label.name}</span>
              {showUnreadCounts && label.unreadCount > 0 && (
                <span className="text-label-md">{label.unreadCount}</span>
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}
