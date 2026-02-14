import { Injectable, signal } from '@angular/core';

export type LayoutMode = 'three-column' | 'bottom-preview' | 'list-only';
export type DensityMode = 'compact' | 'comfortable' | 'spacious';

@Injectable({ providedIn: 'root' })
export class LayoutService {
  readonly layout = signal<LayoutMode>('three-column');
  readonly density = signal<DensityMode>('comfortable');
  readonly sidebarCollapsed = signal(false);

  constructor() {
    // Restore saved preferences
    const savedLayout = localStorage.getItem('layout') as LayoutMode | null;
    if (savedLayout) this.layout.set(savedLayout);

    const savedDensity = localStorage.getItem('density') as DensityMode | null;
    if (savedDensity) this.density.set(savedDensity);

    const savedSidebar = localStorage.getItem('sidebarCollapsed');
    if (savedSidebar === 'true') this.sidebarCollapsed.set(true);
  }

  setLayout(mode: LayoutMode): void {
    this.layout.set(mode);
    localStorage.setItem('layout', mode);
  }

  setDensity(mode: DensityMode): void {
    this.density.set(mode);
    localStorage.setItem('density', mode);
  }

  toggleSidebar(): void {
    const collapsed = !this.sidebarCollapsed();
    this.sidebarCollapsed.set(collapsed);
    localStorage.setItem('sidebarCollapsed', String(collapsed));
  }
}
