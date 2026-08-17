import { LayoutPanelLeft, Rows2, Rows3, Rows4 } from 'lucide-react';
import { useLayoutStore } from '@/stores/layout';
import type { Density } from '@/lib/types/ipc';

const densityIcons: Record<Density, typeof Rows3> = {
  compact: Rows4,
  comfortable: Rows3,
  spacious: Rows2,
};

export function ListHeader({ mailboxName }: { mailboxName?: string }) {
  const density = useLayoutStore((state) => state.density);
  const DensityIcon = densityIcons[density];
  const cycleDensity = useLayoutStore((state) => state.cycleDensity);
  const cycleLayout = useLayoutStore((state) => state.cycleLayout);
  return (
    <header
      data-testid="list-header"
      className="flex items-center justify-between border-b border-outline-variant/20 bg-surface-bright/50 p-stack-gap-md backdrop-blur-sm dark:border-dark-outline-variant/40 dark:bg-dark-surface-container-high/50"
    >
      <span className="text-title-sm">{mailboxName}</span>
      <span className="flex items-center gap-2">
        <button
          aria-label="Cycle conversation density"
          onClick={cycleDensity}
          className="cursor-pointer rounded-full p-stack-gap-sm text-secondary hover:bg-surface-container-high focus-visible:outline-2 focus-visible:outline-primary dark:text-dark-secondary dark:hover:bg-dark-surface-container-high"
        >
          <DensityIcon size={18} />
        </button>
        <button
          aria-label="Cycle mail layout"
          onClick={cycleLayout}
          className="cursor-pointer rounded-full p-stack-gap-sm text-secondary hover:bg-surface-container-high focus-visible:outline-2 focus-visible:outline-primary dark:text-dark-secondary dark:hover:bg-dark-surface-container-high"
        >
          <LayoutPanelLeft size={18} />
        </button>
      </span>
    </header>
  );
}
