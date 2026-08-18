import type { Density, LayoutMode } from '@/lib/types/ipc';

const bar = 'block rounded-glyph bg-current';

export function LayoutGlyph({ layout, className }: { layout: LayoutMode; className?: string }) {
  if (layout === 'three-column') {
    return (
      <span
        aria-hidden="true"
        className={`inline-flex items-center gap-glyph-gap ${className ?? ''}`}
      >
        <i className={`${bar} h-2.75 w-0.75`} />
        <i className={`${bar} h-2.75 w-1.25`} />
        <i className={`${bar} h-2.75 w-1.75`} />
      </span>
    );
  }
  if (layout === 'bottom-preview') {
    return (
      <span aria-hidden="true" className={`inline-flex flex-col gap-glyph-gap ${className ?? ''}`}>
        <i className={`${bar} h-1.25 w-3.75`} />
        <i className={`${bar} h-1 w-3.75`} />
      </span>
    );
  }
  return (
    <span aria-hidden="true" className={`inline-flex items-center ${className ?? ''}`}>
      <i className={`${bar} h-2.75 w-3.75`} />
    </span>
  );
}

const DENSITY_GAP: Record<Density, string> = {
  compact: 'gap-glyph-gap',
  comfortable: 'gap-0.75',
  spacious: 'gap-glyph-gap-lg',
};

export function DensityGlyph({ density, className }: { density: Density; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-flex flex-col ${DENSITY_GAP[density]} ${className ?? ''}`}
    >
      <i className={`${bar} h-0.5 w-3.5`} />
      <i className={`${bar} h-0.5 w-3.5`} />
      <i className={`${bar} h-0.5 w-3.5`} />
    </span>
  );
}
