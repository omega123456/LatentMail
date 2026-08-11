import { ChevronDown, LayoutPanelLeft, Rows3 } from 'lucide-react';
import { useLayoutStore } from '@/stores/layout';

export function ListHeader() {
  const cycleDensity = useLayoutStore((state) => state.cycleDensity);
  const cycleLayout = useLayoutStore((state) => state.cycleLayout);
  return (
    <header
      data-testid="list-header"
      className="flex items-center justify-between border-b border-outline-variant/20 bg-surface-bright/50 p-stack-gap-md backdrop-blur-sm dark:border-dark-outline-variant/40 dark:bg-dark-surface-container-high/50"
    >
      <span className="flex items-center gap-2">
        <span className="size-4 rounded-sm border border-outline-variant bg-surface dark:border-dark-outline-variant dark:bg-dark-surface" />
        <ChevronDown
          aria-hidden="true"
          size={16}
          className="text-secondary dark:text-dark-secondary"
        />
      </span>
      <span className="flex items-center gap-2">
        <span className="text-label-sm text-secondary dark:text-dark-secondary">1-50 of 2,431</span>
        <button
          aria-label="Cycle conversation density"
          onClick={cycleDensity}
          className="rounded-full p-stack-gap-sm text-secondary hover:bg-surface-container-high focus-visible:outline-2 focus-visible:outline-primary dark:text-dark-secondary dark:hover:bg-dark-surface-container-high"
        >
          <Rows3 size={18} />
        </button>
        <button
          aria-label="Cycle mail layout"
          onClick={cycleLayout}
          className="rounded-full p-stack-gap-sm text-secondary hover:bg-surface-container-high focus-visible:outline-2 focus-visible:outline-primary dark:text-dark-secondary dark:hover:bg-dark-surface-container-high"
        >
          <LayoutPanelLeft size={18} />
        </button>
      </span>
    </header>
  );
}
